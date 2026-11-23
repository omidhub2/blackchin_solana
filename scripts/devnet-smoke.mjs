import { Keypair } from '@solana/web3.js';
import { connection, solanaNetwork, assertSolanaNetworkIdentity } from '../config/connection.js';
import { sendSolWithSigner } from '../Solana/solTransfer.js';

function zeroize(keypair) {
  if (!keypair) return;
  const internal = keypair._keypair;
  for (const value of [keypair.secretKey, internal?.privateKey, internal?.secretKey]) {
    try { value?.fill?.(0); } catch {}
  }
}

async function requestDevnetAirdrop(publicKey, lamports) {
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await connection.requestAirdrop(publicKey, lamports);
    } catch (error) {
      lastError = error;
      if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 5000));
    }
  }
  throw lastError;
}

if (solanaNetwork !== 'devnet') {
  throw new Error(`Refusing Devnet smoke test on network ${solanaNetwork}`);
}

await assertSolanaNetworkIdentity();

const sender = Keypair.generate();
const recipient = Keypair.generate();

try {
  const airdropSignature = await requestDevnetAirdrop(sender.publicKey, 1_000_000_000);
  const airdropBlockhash = await connection.getLatestBlockhash('confirmed');
  const airdropConfirmation = await connection.confirmTransaction({
    signature: airdropSignature,
    ...airdropBlockhash
  }, 'confirmed');

  if (airdropConfirmation.value.err) {
    throw new Error(`Devnet airdrop failed: ${JSON.stringify(airdropConfirmation.value.err)}`);
  }

  const senderBalanceBefore = await connection.getBalance(sender.publicKey, 'confirmed');
  if (senderBalanceBefore < 1_000_000_000) {
    throw new Error('Devnet airdrop did not fund the ephemeral sender with 1 SOL');
  }

  let persistedSignature = null;
  const transfer = await sendSolWithSigner({
    fromPublicKey: sender.publicKey.toBase58(),
    toPublicKey: recipient.publicKey.toBase58(),
    amountSol: '0.001',
    commitment: 'confirmed',
    getKeypair: () => sender,
    onSigned: async ({ signature }) => {
      persistedSignature = signature;
    },
    rpcConnection: connection
  });

  if (!persistedSignature || transfer.signature !== persistedSignature) {
    throw new Error('Signed transaction identity was not preserved before broadcast');
  }

  const [recipientBalance, signatureStatus] = await Promise.all([
    connection.getBalance(recipient.publicKey, 'confirmed'),
    connection.getSignatureStatuses([transfer.signature], { searchTransactionHistory: true })
  ]);

  if (recipientBalance !== 1_000_000) {
    throw new Error(`Unexpected recipient balance: ${recipientBalance} lamports`);
  }
  if (signatureStatus.value[0]?.err) {
    throw new Error(`Devnet transfer status contains an error: ${JSON.stringify(signatureStatus.value[0].err)}`);
  }
  if (!['confirmed', 'finalized'].includes(signatureStatus.value[0]?.confirmationStatus)) {
    throw new Error('Devnet transfer has not reached confirmed/finalized status');
  }

  process.stdout.write(JSON.stringify({
    result: 'PASS',
    network: solanaNetwork,
    genesisHash: (await connection.getGenesisHash()),
    airdropSignature,
    transferSignature: transfer.signature,
    sender: sender.publicKey.toBase58(),
    recipient: recipient.publicKey.toBase58(),
    amountLamports: transfer.amountLamports,
    feeLamports: transfer.feeLamports,
    slot: transfer.slot,
    confirmationStatus: signatureStatus.value[0].confirmationStatus,
    recipientBalanceLamports: recipientBalance
  }, null, 2) + '\n');
} finally {
  zeroize(sender);
  zeroize(recipient);
}
