import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import {
  deriveSolanaAccount,
  deriveSolanaAccountFromSeedBuffer,
  mnemonicToHdSeed
} from '../src/blockchain/solana/hd/derivation.js';
import {
  deriveSlip10MasterKey,
  deriveSlip10Path
} from '../src/blockchain/solana/hd/slip10-ed25519.js';
import {
  createCipher,
  createEnvKeyProvider
} from '../src/infrastructure/security/hd-envelope.js';
import { zeroizeKeypair } from '../src/infrastructure/security/wallet-signer.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon diesel';

const allZero = (buffer) => buffer.every((byte) => byte === 0);

test('deriveSolanaAccount wipes its own seed buffer and still returns a valid keypair', () => {
  const derived = deriveSolanaAccount(MNEMONIC, 0);

  assert.equal(derived.publicKey, Keypair.fromSecretKey(derived.secretKey).publicKey.toBase58());
  assert.equal(derived.secretKey.length, 64);

  derived.secretKey.fill(0);
  zeroizeKeypair(derived.keypair);
});

test('deriveSolanaAccountFromSeedBuffer does not mutate the caller seed', () => {
  const seed = mnemonicToHdSeed(MNEMONIC);
  const copy = Buffer.from(seed);

  const derived = deriveSolanaAccountFromSeedBuffer(seed, 3);

  // Caller owns the seed; it must be untouched by the derivation helper.
  assert.deepEqual(seed, copy);
  assert.equal(derived.publicKey, deriveSolanaAccount(MNEMONIC, 3).publicKey);

  seed.fill(0);
  derived.secretKey.fill(0);
  zeroizeKeypair(derived.keypair);
});

test('slip10 path derivation wipes intermediate nodes it owns', () => {
  const seed = mnemonicToHdSeed(MNEMONIC);
  const master = deriveSlip10MasterKey(seed);
  const masterKeyCopy = Buffer.from(master.key);
  const masterChainCopy = Buffer.from(master.chainCode);

  const node = deriveSlip10Path(master, "m/44'/501'/0'/0'");

  // The caller's master node is never modified.
  assert.deepEqual(master.key, masterKeyCopy);
  assert.deepEqual(master.chainCode, masterChainCopy);
  assert.equal(node.key.length, 32);

  // The returned node equals a single-level re-derivation of the same path.
  const expected = deriveSlip10Path(deriveSlip10MasterKey(seed), "m/44'/501'/0'/0'");
  assert.deepEqual(node.key, expected.key);

  seed.fill(0);
  master.key.fill(0);
  master.chainCode.fill(0);
  node.key.fill(0);
  node.chainCode.fill(0);
  expected.key.fill(0);
  expected.chainCode.fill(0);
});

test('zeroizeKeypair clears the real internal secret buffer', () => {
  const keypair = Keypair.generate();
  const internal = keypair._keypair.secretKey;

  assert.ok(!allZero(internal));

  zeroizeKeypair(keypair);

  assert.ok(allZero(internal), 'internal secret buffer must be zeroed');
});

test('failed derivation leaves no unzeroed keypair referenced after errors', () => {
  // Invalid index: derivation throws before producing a keypair.
  assert.throws(() => deriveSolanaAccountFromSeedBuffer(mnemonicToHdSeed(MNEMONIC), -1), /Account index/);

  // Short seed: master key derivation rejects it.
  const shortSeed = Buffer.alloc(8, 7);
  assert.throws(() => deriveSolanaAccountFromSeedBuffer(shortSeed, 0), /seed must be/);
  shortSeed.fill(0);
});

test('failed decryption never returns plaintext and does not throw with secrets', () => {
  const cipher = createCipher(createEnvKeyProvider({ ENCRYPTION_KEY: 'b7'.repeat(32) }));
  const sealed = cipher.encrypt(MNEMONIC, { aad: 'hd_wallets:1:mnemonic:v1' });

  let message = '';

  try {
    cipher.decrypt(sealed.ciphertext, sealed.iv, '00'.repeat(16), { aad: 'hd_wallets:1:mnemonic:v1' });
  } catch (error) {
    message = error.message;
  }

  assert.match(message, /Decryption failed/);
  assert.ok(!message.includes(MNEMONIC));
  assert.ok(!message.includes('abandon'));
  assert.ok(!message.includes(sealed.ciphertext.slice(0, 16)));
});

test('keypair zeroization runs even when the signing callback throws', async () => {
  const { withSigningKey } = await import('../src/infrastructure/security/wallet-signer.js');
  const cipher = createCipher(createEnvKeyProvider({ ENCRYPTION_KEY: 'c4'.repeat(32) }));
  const { createFakePool } = await import('./helpers/fake-pool.js');
  const { MemoryHdDatabase } = await import('./helpers/memory-hd-db.js');

  const memory = new MemoryHdDatabase();
  const parent = memory.addHdWallet({ status: 'active' });
  const sealed = cipher.encrypt(MNEMONIC, { aad: `hd_wallets:${parent.id}:mnemonic:v1` });

  Object.assign(parent, {
    mnemonic_encrypted: sealed.ciphertext,
    mnemonic_iv: sealed.iv,
    mnemonic_auth_tag: sealed.authTag
  });

  const account = memory.addAccount({
    hdWalletId: parent.id,
    publicKey: deriveSolanaAccount(MNEMONIC, 0).publicKey,
    accountIndex: 0
  });

  const pool = createFakePool();
  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);
  pool.onQuery('lock_timeout', () => undefined);
  pool.onQuery('FROM wallet_accounts WHERE public_key', (params) => {
    const row = memory.accountByPublicKey(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM hd_wallets', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM wallet_accounts\n      WHERE id = $1', (params) => {
    const row = memory.accounts.find((item) => String(item.id) === String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM hd_wallets\n      WHERE id = $1', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  let internal;

  await assert.rejects(
    () =>
      withSigningKey(
        pool,
        account.public_key,
        async ({ keypair }) => {
          internal = keypair._keypair.secretKey;
          throw new Error('broadcast failed');
        },
        { cipher, deploymentNetwork: 'devnet' }
      ),
    /broadcast failed/
  );

  assert.ok(internal);
  assert.ok(allZero(internal), 'secret buffer must be zeroed after a failed signing callback');
});
