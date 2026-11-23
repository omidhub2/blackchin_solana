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

if (solanaNetwork !== 'devnet') {
  throw new Error(`Refusing Devnet smoke test on network ${solanaNetwork}`);
}

await assertSolanaNetworkIdentity();

const encodedSecret = process.env.DEVNET_SMOKE_SECRET_KEY;
if (typeof encodedSecret !== 'string' || encodedSecret.length === 0) {
  const [slot, latestBlockhash] = await Promise.all([
    connection.getSlot('confirmed'),
    connection.getLatestBlockhash('confirmed')
  ]);
  process.stdout.write(JSON.stringify({
    result: 'READ_ONLY_PREFLIGHT_PASS',
    network: solanaNetwork,
    genesisHash: await connection.getGenesisHash(),
    slot,
    latestBlockhash,
    transfer: 'SKIPPED_NO_DEVNET_SMOKE_SECRET'
  }, null, 2) + '\n');
  process.exit(0);
}

const secretBytes = Buffer.from(encodedSecret, 'base64');
if (secretBytes.length !== 64) {
  secretBytes.fill(0);
  throw new Error('DEVNET_SMOKE_SECRET_KEY must decode to a 64-byte Solana secret key');
}

let sender;
try {
  sender = Keypair.fromSecretKey(secretBytes);
} finally {
  secretBytes.fill(0);
}
const recipient = Keypair.generate();

try {
  const senderBalanceBefore = await connection.getBalance(sender.publicKey, 'confirmed');
  if (senderBalanceBefore < 1_000_000) {
    throw new Error('The dedicated Devnet smoke wallet is not funded; request Devnet SOL from the official faucet.');
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
    genesisHash: await connection.getGenesisHash(),
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
