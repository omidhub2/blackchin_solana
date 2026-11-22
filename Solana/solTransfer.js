import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction
} from '@solana/web3.js';

import {
  commitment as defaultCommitment,
  connection,
  solanaNetwork
} from '../config/connection.js';

const LAMPORTS_PER_SOL = 1_000_000_000n;
const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const VALID_COMMITMENTS = new Set(['processed', 'confirmed', 'finalized']);

function encodeBase58(bytes) {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = '';
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  for (const byte of bytes) {
    if (byte !== 0) break;
    encoded = `1${encoded}`;
  }
  return encoded || '1';
}

function parsePublicKey(value, fieldName = 'publicKey') {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${fieldName} must be a non-empty Base58 address`);
  }

  try {
    return new PublicKey(value);
  } catch (error) {
    throw new TypeError(`Invalid ${fieldName}`, { cause: error });
  }
}

function validateCommitment(value) {
  if (!VALID_COMMITMENTS.has(value)) {
    throw new TypeError(
      'commitment must be processed, confirmed or finalized'
    );
  }

  return value;
}

/**
 * Convert a decimal SOL string to exact lamports without floating-point math.
 * Number inputs are deliberately rejected to avoid precision loss.
 *
 * @param {string} amountSol
 * @returns {bigint}
 */
export function parseSolToLamports(amountSol) {
  if (
    typeof amountSol !== 'string' ||
    !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(amountSol)
  ) {
    throw new TypeError(
      'amountSol must be a positive decimal string with at most 9 decimal places'
    );
  }

  const [wholePart, fractionalPart = ''] = amountSol.split('.');
  const lamports =
    BigInt(wholePart) * LAMPORTS_PER_SOL +
    BigInt((fractionalPart + '000000000').slice(0, 9));

  if (lamports <= 0n) {
    throw new RangeError('Transfer amount must be greater than zero');
  }

  if (lamports > MAX_SAFE_LAMPORTS) {
    throw new RangeError('Transfer amount exceeds the supported lamport range');
  }

  return lamports;
}

/**
 * Format lamports as a decimal SOL string without floating-point conversion.
 *
 * @param {bigint|string|number} lamports
 * @returns {string}
 */
export function formatLamports(lamports) {
  const value = BigInt(lamports);

  if (value < 0n) {
    throw new RangeError('Lamports cannot be negative');
  }

  const whole = value / LAMPORTS_PER_SOL;
  const fraction = (value % LAMPORTS_PER_SOL)
    .toString()
    .padStart(9, '0')
    .replace(/0+$/, '');

  return fraction.length > 0 ? `${whole}.${fraction}` : whole.toString();
}

/**
 * Parse incoming native SOL SystemProgram.transfer instructions from a
 * parsed transaction. Exported to support deterministic unit tests.
 */
export function extractIncomingTransfers(parsedTransaction, recipientAddress) {
  const recipient = parsePublicKey(recipientAddress, 'recipientAddress').toBase58();

  if (!parsedTransaction?.meta || parsedTransaction.meta.err !== null) {
    return [];
  }

  const topLevel = parsedTransaction.transaction?.message?.instructions ?? [];
  const inner = (parsedTransaction.meta.innerInstructions ?? [])
    .flatMap((entry) => entry.instructions ?? []);
  const instructions = [...topLevel, ...inner];

  return instructions
    // Parsed inner instructions may be "unknown" and lack `program`/`parsed`.
    .filter((instruction) =>
      instruction?.program === 'system' &&
      instruction?.parsed?.type === 'transfer' &&
      instruction?.parsed?.info &&
      typeof instruction.parsed.info === 'object'
    )
    .map((instruction) => instruction.parsed.info)
    .filter((info) =>
      info &&
      info.destination === recipient &&
      typeof info.source === 'string' &&
      Number.isSafeInteger(info.lamports) &&
      info.lamports > 0
    )
    .map((info) => ({
      from: info.source,
      to: recipient,
      lamports: String(info.lamports),
      amountSol: formatLamports(info.lamports)
    }));
}

async function queryStoredWalletPublicKey(publicKey) {
  const { pool } = await import('../PostgreSQL/walletStorage.js');

  const result = await pool.query(
    'SELECT public_key FROM wallets WHERE public_key = $1 LIMIT 1',
    [publicKey]
  );

  if (result.rowCount === 0) {
    throw new Error('Wallet address was not found in the local wallet database');
  }

  return result.rows[0].public_key;
}

async function getStoredWalletPublicKey(publicKey) {
  try {
    return await queryStoredWalletPublicKey(publicKey);
  } catch (error) {
    if (error.message === 'Wallet address was not found in the local wallet database') {
      error.statusCode = 404;
    }

    throw error;
  }
}

// web3.js silently swallows polling errors for HTTP-only endpoints and keeps
// retrying forever, so the valid blockhash window is enforced here instead of
// leaving a submitted transfer pending without an answer.
const MAX_BLOCKHASH_WAIT_MS = 90_000;
const BLOCKHASH_WINDOW_CHECK_MS = 2_000;

async function confirmWithBlockhashWindow({
  signature,
  latestBlockhash,
  commitmentLevel
}) {
  let blockHeightTimer;
  let settled = false;

  const expired = new Promise((_resolve, reject) => {
    blockHeightTimer = setInterval(async () => {
      if (settled) return;

      try {
        const { value: blockHeight } = await connection.getBlockHeight(commitmentLevel);

        if (
          Number.isSafeInteger(blockHeight) &&
          blockHeight > latestBlockhash.lastValidBlockHeight
        ) {
          const error = new Error(
            `Transaction ${signature} was not confirmed before its blockhash expired`
          );
          error.signature = signature;
          reject(error);
        }
      } catch {
        // Transient RPC errors are ignored while the blockhash is still valid.
      }
    }, BLOCKHASH_WINDOW_CHECK_MS);
    blockHeightTimer.unref?.();
  });

  const timeout = new Promise((_resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new Error(
        `Transaction ${signature} confirmation exceeded ${MAX_BLOCKHASH_WAIT_MS} ms`
      );
      error.signature = signature;
      reject(error);
    }, MAX_BLOCKHASH_WAIT_MS);
    timer.unref?.();
  });

  const confirmation = connection.confirmTransaction(
    {
      signature,
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    },
    commitmentLevel
  );

  // Avoid unhandled rejections if the race settles through another branch.
  confirmation.catch(() => {});

  try {
    return await Promise.race([confirmation, expired, timeout]);
  } finally {
    settled = true;
    clearInterval(blockHeightTimer);
  }
}

/**
 * Return a stored wallet's deposit address. The address is public and can
 * safely be shared with the sender.
 */
export async function getDepositAddress(publicKey) {
  const address = parsePublicKey(publicKey).toBase58();
  const storedAddress = await getStoredWalletPublicKey(address);

  return {
    publicKey: storedAddress,
    network: solanaNetwork
  };
}

/**
 * Read the confirmed native SOL balance of a stored wallet.
 */
export async function getSolBalance(publicKey, requestedCommitment = defaultCommitment) {
  const address = parsePublicKey(publicKey).toBase58();
  const commitmentLevel = validateCommitment(requestedCommitment);
  const storedAddress = await getStoredWalletPublicKey(address);

  const lamports = await connection.getBalance(
    new PublicKey(storedAddress),
    commitmentLevel
  );

  if (!Number.isSafeInteger(lamports) || lamports < 0) {
    throw new Error('RPC returned an invalid SOL balance');
  }

  return {
    publicKey: storedAddress,
    network: solanaNetwork,
    commitment: commitmentLevel,
    lamports: String(lamports),
    sol: formatLamports(lamports)
  };
}

/**
 * Return recent incoming native SOL transfers for a stored wallet.
 * This scans the latest signatures for the address; it is not a complete
 * historical indexer. Use a dedicated indexer for exhaustive history.
 */
export async function getRecentIncomingTransfers(
  publicKey,
  { limit = 10, commitment: requestedCommitment = defaultCommitment } = {}
) {
  const address = parsePublicKey(publicKey).toBase58();
  const commitmentLevel = validateCommitment(requestedCommitment);

  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new RangeError('limit must be an integer between 1 and 50');
  }

  const storedAddress = await getStoredWalletPublicKey(address);
  const recipient = new PublicKey(storedAddress);
  const signatures = await connection.getSignaturesForAddress(
    recipient,
    { limit: Math.min(100, limit * 5) },
    commitmentLevel
  );

  const incoming = [];

  for (const signatureInfo of signatures) {
    if (signatureInfo.err) {
      continue;
    }

    const parsedTransaction = await connection.getParsedTransaction(
      signatureInfo.signature,
      {
        commitment: commitmentLevel,
        maxSupportedTransactionVersion: 0
      }
    );

    if (!parsedTransaction || parsedTransaction.meta?.err) {
      continue;
    }

    const transfers = extractIncomingTransfers(
      parsedTransaction,
      storedAddress
    );

    for (const transfer of transfers) {
      incoming.push({
        ...transfer,
        signature: signatureInfo.signature,
        slot: signatureInfo.slot,
        blockTime: signatureInfo.blockTime ?? null,
        confirmationStatus: signatureInfo.confirmationStatus ?? null
      });

      if (incoming.length >= limit) {
        return incoming;
      }
    }
  }

  return incoming;
}

/**
 * Verify a transaction signature and confirm whether it contains an
 * incoming native SOL transfer to the requested stored wallet.
 */
export async function verifyIncomingTransfer(
  signature,
  recipientPublicKey,
  requestedCommitment = defaultCommitment
) {
  if (
    typeof signature !== 'string' ||
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)
  ) {
    throw new TypeError('Invalid Solana transaction signature');
  }

  const address = parsePublicKey(recipientPublicKey).toBase58();
  const commitmentLevel = validateCommitment(requestedCommitment);
  const storedAddress = await getStoredWalletPublicKey(address);

  const parsedTransaction = await connection.getParsedTransaction(
    signature,
    {
      commitment: commitmentLevel,
      maxSupportedTransactionVersion: 0
    }
  );

  if (!parsedTransaction) {
    return {
      found: false,
      confirmed: false,
      signature,
      publicKey: storedAddress,
      network: solanaNetwork,
      transfers: []
    };
  }

  if (parsedTransaction.meta?.err) {
    return {
      found: true,
      confirmed: false,
      signature,
      publicKey: storedAddress,
      network: solanaNetwork,
      error: parsedTransaction.meta.err,
      transfers: []
    };
  }

  const transfers = extractIncomingTransfers(
    parsedTransaction,
    storedAddress
  );

  const statusResponse = await connection.getSignatureStatuses(
    [signature],
    { searchTransactionHistory: true }
  );

  const status = statusResponse.value[0] ?? null;
  const confirmed = Boolean(
    status &&
    !status.err &&
    (status.confirmationStatus === 'confirmed' ||
      status.confirmationStatus === 'finalized')
  );

  return {
    found: true,
    confirmed,
    confirmationStatus: status?.confirmationStatus ?? null,
    signature,
    publicKey: storedAddress,
    network: solanaNetwork,
    slot: parsedTransaction.slot,
    blockTime: parsedTransaction.blockTime ?? null,
    transfers
  };
}

/**
 * Send native SOL from a wallet stored in PostgreSQL.
 *
 * A confirmation callback is mandatory. It receives a non-secret transfer
 * preview and must resolve to true before the transaction is signed/broadcast.
 *
 * @param {{
 *   fromPublicKey: string,
 *   toPublicKey: string,
 *   amountSol: string,
 *   confirm: (preview: object) => boolean|Promise<boolean>,
 *   commitment?: 'processed'|'confirmed'|'finalized'
 * }} options
 */
export async function sendSol({
  fromPublicKey,
  toPublicKey,
  amountSol,
  confirm,
  commitment: requestedCommitment = defaultCommitment
}) {
  if (typeof confirm !== 'function') {
    throw new TypeError(
      'A confirmation callback is required; transfer will not be sent without explicit approval'
    );
  }

  const senderAddress = parsePublicKey(fromPublicKey, 'fromPublicKey');
  const recipientAddress = parsePublicKey(toPublicKey, 'toPublicKey');
  const commitmentLevel = validateCommitment(requestedCommitment);
  const amountLamports = parseSolToLamports(amountSol);

  if (senderAddress.equals(recipientAddress)) {
    throw new Error('Sending SOL to the same wallet is not allowed');
  }

  const { loadWalletByPublicKey } = await import('../PostgreSQL/walletStorage.js');
  const storedWallet = await loadWalletByPublicKey(senderAddress.toBase58());

  if (!storedWallet) {
    throw new Error('Sender wallet was not found in the wallet database');
  }

  let secretBytes;
  let senderKeypair;

  try {
    secretBytes = Buffer.from(storedWallet.privateKey, 'hex');
    senderKeypair = Keypair.fromSecretKey(Uint8Array.from(secretBytes));

    if (!senderKeypair.publicKey.equals(senderAddress)) {
      throw new Error('Decrypted signing key does not match the sender address');
    }

    const latestBlockhash = await connection.getLatestBlockhash(commitmentLevel);
    const transaction = new Transaction({
      feePayer: senderAddress,
      recentBlockhash: latestBlockhash.blockhash
    }).add(
      SystemProgram.transfer({
        fromPubkey: senderAddress,
        toPubkey: recipientAddress,
        lamports: Number(amountLamports)
      })
    );

    const feeLamports = await connection.getFeeForMessage(
      transaction.compileMessage(),
      commitmentLevel
    );

    if (!Number.isSafeInteger(feeLamports) || feeLamports < 0) {
      throw new Error('Unable to obtain a valid transaction fee estimate');
    }

    const balanceLamports = await connection.getBalance(
      senderAddress,
      commitmentLevel
    );

    if (!Number.isSafeInteger(balanceLamports) || balanceLamports < 0) {
      throw new Error('RPC returned an invalid sender balance');
    }

    const requiredLamports = amountLamports + BigInt(feeLamports);

    if (BigInt(balanceLamports) < requiredLamports) {
      throw new Error(
        `Insufficient SOL: required ${formatLamports(requiredLamports)} SOL including estimated fee, available ${formatLamports(balanceLamports)} SOL`
      );
    }

    const preview = Object.freeze({
      network: solanaNetwork,
      from: senderAddress.toBase58(),
      to: recipientAddress.toBase58(),
      amountLamports: amountLamports.toString(),
      amountSol: formatLamports(amountLamports),
      estimatedFeeLamports: String(feeLamports),
      estimatedFeeSol: formatLamports(feeLamports),
      totalRequiredLamports: requiredLamports.toString(),
      availableLamports: String(balanceLamports),
      commitment: commitmentLevel
    });

    const approved = await confirm(preview);

    if (approved !== true) {
      return {
        sent: false,
        cancelled: true,
        preview
      };
    }

    transaction.sign(senderKeypair);

    const rawTransaction = transaction.serialize();
    const signature = await connection.sendRawTransaction(rawTransaction, {
      skipPreflight: false,
      preflightCommitment: commitmentLevel,
      maxRetries: 3
    });

    let confirmation;

    try {
      confirmation = await confirmWithBlockhashWindow({
        signature,
        latestBlockhash,
        commitmentLevel
      });
    } catch (error) {
      error.signature = signature;
      error.message = `Transaction was submitted but confirmation could not be completed. Check signature ${signature}. ${error.message}`;
      throw error;
    }

    if (confirmation.value.err) {
      const error = new Error('Solana rejected the transaction during confirmation');
      error.signature = signature;
      error.transactionError = confirmation.value.err;
      throw error;
    }

    return {
      sent: true,
      signature,
      network: solanaNetwork,
      from: senderAddress.toBase58(),
      to: recipientAddress.toBase58(),
      amountLamports: amountLamports.toString(),
      amountSol: formatLamports(amountLamports),
      feeLamports: String(feeLamports),
      feeSol: formatLamports(feeLamports),
      slot: confirmation.context.slot,
      confirmationStatus: commitmentLevel
    };
  } finally {
    if (secretBytes) {
      secretBytes.fill(0);
    }

    if (senderKeypair?.secretKey) {
      senderKeypair.secretKey.fill(0);
    }

    if (storedWallet) {
      storedWallet.privateKey = '';
      storedWallet.mnemonic = null;
    }
  }
}

/**
 * Estimate a native SOL transfer without signing or broadcasting it.
 * Amounts are decimal strings to avoid floating-point precision loss.
 */
export async function estimateSolTransfer({
  fromPublicKey,
  toPublicKey,
  amountSol,
  requestedCommitment = defaultCommitment
}) {
  const sender = parsePublicKey(fromPublicKey, 'fromPublicKey');
  const recipient = parsePublicKey(toPublicKey, 'toPublicKey');
  const commitmentLevel = validateCommitment(requestedCommitment);
  const amountLamports = parseSolToLamports(amountSol);

  if (sender.equals(recipient)) {
    throw new Error('Sending SOL to the same wallet is not allowed');
  }

  // Throws (404) when the sender is not a wallet stored in this service.
  await getStoredWalletPublicKey(sender.toBase58());

  const latestBlockhash = await connection.getLatestBlockhash(commitmentLevel);
  const transaction = new Transaction({
    feePayer: sender,
    recentBlockhash: latestBlockhash.blockhash
  }).add(
    SystemProgram.transfer({
      fromPubkey: sender,
      toPubkey: recipient,
      lamports: Number(amountLamports)
    })
  );

  const feeLamports = await connection.getFeeForMessage(
    transaction.compileMessage(),
    commitmentLevel
  );

  if (!Number.isSafeInteger(feeLamports) || feeLamports < 0) {
    throw new Error('Unable to obtain a valid transaction fee estimate');
  }

  const balanceLamports = await connection.getBalance(sender, commitmentLevel);

  if (!Number.isSafeInteger(balanceLamports) || balanceLamports < 0) {
    throw new Error('RPC returned an invalid sender balance');
  }

  const totalLamports = amountLamports + BigInt(feeLamports);

  return {
    network: solanaNetwork,
    from: sender.toBase58(),
    to: recipient.toBase58(),
    amountLamports: amountLamports.toString(),
    amountSol: formatLamports(amountLamports),
    estimatedFeeLamports: String(feeLamports),
    estimatedFeeSol: formatLamports(feeLamports),
    totalRequiredLamports: totalLamports.toString(),
    totalRequiredSol: formatLamports(totalLamports),
    availableLamports: String(balanceLamports),
    availableSol: formatLamports(balanceLamports),
    sufficientBalance: BigInt(balanceLamports) >= totalLamports,
    commitment: commitmentLevel
  };
}


/**
 * Send native SOL with an externally supplied signing keypair.
 *
 * Used by the HD withdrawal flow: the caller (wallet-signer) derives or
 * decrypts the correct child key for the lifetime of the signing callback and
 * passes the keypair here. This function never loads keys from the database
 * and never logs them.
 *
 * The keypair returned by `getKeypair()` is owned by the caller; this function
 * does not zero it.
 *
 * @param {{
 *   fromPublicKey: string,
 *   toPublicKey: string,
 *   amountSol: string,
 *   getKeypair: () => import('@solana/web3.js').Keypair,
 *   commitment?: 'processed'|'confirmed'|'finalized'
 * }} options
 */
export async function sendSolWithSigner({
  fromPublicKey,
  toPublicKey,
  amountSol,
  getKeypair,
  onSigned,
  commitment: requestedCommitment = defaultCommitment
}) {
  if (typeof getKeypair !== 'function') {
    throw new TypeError('A signing key provider is required');
  }

  const senderAddress = parsePublicKey(fromPublicKey, 'fromPublicKey');
  const recipientAddress = parsePublicKey(toPublicKey, 'toPublicKey');
  const commitmentLevel = validateCommitment(requestedCommitment);
  const amountLamports = parseSolToLamports(amountSol);

  if (senderAddress.equals(recipientAddress)) {
    throw new Error('Sending SOL to the same wallet is not allowed');
  }

  const senderKeypair = getKeypair();

  if (!senderKeypair?.publicKey?.equals?.(senderAddress)) {
    throw new Error('Signing key does not match the sender address');
  }

  const latestBlockhash = await connection.getLatestBlockhash(commitmentLevel);
  const transaction = new Transaction({
    feePayer: senderAddress,
    recentBlockhash: latestBlockhash.blockhash
  }).add(
    SystemProgram.transfer({
      fromPubkey: senderAddress,
      toPubkey: recipientAddress,
      lamports: Number(amountLamports)
    })
  );

  const feeLamports = await connection.getFeeForMessage(
    transaction.compileMessage(),
    commitmentLevel
  );

  if (!Number.isSafeInteger(feeLamports) || feeLamports < 0) {
    throw new Error('Unable to obtain a valid transaction fee estimate');
  }

  const balanceLamports = await connection.getBalance(senderAddress, commitmentLevel);

  if (!Number.isSafeInteger(balanceLamports) || balanceLamports < 0) {
    throw new Error('RPC returned an invalid sender balance');
  }

  const requiredLamports = amountLamports + BigInt(feeLamports);

  if (BigInt(balanceLamports) < requiredLamports) {
    throw new Error(
      `Insufficient SOL: required ${formatLamports(requiredLamports)} SOL including estimated fee, available ${formatLamports(balanceLamports)} SOL`
    );
  }

  transaction.sign(senderKeypair);

  if (typeof onSigned === 'function') {
    if (!transaction.signature || transaction.signature.length !== 64) {
      throw new Error('Unable to derive the signed transaction signature');
    }
    await onSigned({
      signature: encodeBase58(transaction.signature),
      blockhash: latestBlockhash.blockhash,
      lastValidBlockHeight: latestBlockhash.lastValidBlockHeight
    });
  }

  const rawTransaction = transaction.serialize();
  let signature;
  try {
    signature = await connection.sendRawTransaction(rawTransaction, {
    skipPreflight: false,
    preflightCommitment: commitmentLevel,
      maxRetries: 3
    });
  } catch (error) {
    error.signature = transaction.signature
      ? encodeBase58(transaction.signature)
      : undefined;
    throw error;
  }

  let confirmation;

  try {
    confirmation = await confirmWithBlockhashWindow({
      signature,
      latestBlockhash,
      commitmentLevel
    });
  } catch (error) {
    error.signature = signature;
    error.message = `Transaction was submitted but confirmation could not be completed. Check signature ${signature}. ${error.message}`;
    throw error;
  }

  if (confirmation.value.err) {
    const error = new Error('Solana rejected the transaction during confirmation');
    error.signature = signature;
    error.transactionError = confirmation.value.err;
    throw error;
  }

  return {
    sent: true,
    signature,
    network: solanaNetwork,
    from: senderAddress.toBase58(),
    to: recipientAddress.toBase58(),
    amountLamports: amountLamports.toString(),
    amountSol: formatLamports(amountLamports),
    feeLamports: String(feeLamports),
    feeSol: formatLamports(feeLamports),
    slot: confirmation.context.slot,
    confirmationStatus: commitmentLevel
  };
}
