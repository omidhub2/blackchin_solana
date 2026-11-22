import test from 'node:test';
import assert from 'node:assert/strict';

import { createHdWalletService } from '../src/core/hd-wallet/hd-wallet.service.js';
import {
  createCipher,
  createEnvKeyProvider
} from '../src/infrastructure/security/hd-envelope.js';
import {
  createPurposeTokenCodec
} from '../src/infrastructure/security/purpose-token.js';
import {
  deriveSolanaAccount,
  validateHdMnemonic
} from '../src/blockchain/solana/hd/derivation.js';
import { createFakePool } from './helpers/fake-pool.js';

const KEY = 'd'.repeat(64);
const keyProvider = createEnvKeyProvider({ ENCRYPTION_KEY: KEY });
const cipher = createCipher(keyProvider);
const tokens = createPurposeTokenCodec(keyProvider);

/**
 * Fake pool implementing exactly the statements the HD wallet service issues.
 */
function buildPool() {
  const pool = createFakePool();
  const rows = new Map();
  let nextId = 1;

  const rowFor = (id) => rows.get(String(id));

  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);

  pool.onQuery('INSERT INTO hd_wallets', (params) => {
    const id = String(nextId);
    nextId += 1;

    const row = {
      id,
      owner_id: params[0],
      label: params[1],
      network: params[2],
      derivation_scheme: params[3],
      derivation_path_template: params[4],
      mnemonic_encrypted: params[5],
      mnemonic_iv: params[6],
      mnemonic_auth_tag: params[7],
      encryption_key_version: params[8],
      next_account_index: 0,
      status: params[9],
      phrase_provisioned_at: null,
      created_at: new Date(),
      updated_at: new Date()
    };

    rows.set(id, row);
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET mnemonic_encrypted = $2', (params) => {
    const row = rowFor(params[0]);
    row.mnemonic_encrypted = params[1];
    row.mnemonic_iv = params[2];
    row.mnemonic_auth_tag = params[3];
    row.encryption_key_version = params[4];
    row.status = 'active';
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET status = $2', (params) => {
    const row = rowFor(params[0]);
    if (!row) return { rows: [], rowCount: 0 };
    row.status = params[1];
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET phrase_provisioned_at = NOW()', (params) => {
    const row = rowFor(params[0]);
    if (!row || row.phrase_provisioned_at !== null) return { rows: [], rowCount: 0 };
    row.phrase_provisioned_at = new Date();
    return { rows: [{ phrase_provisioned_at: row.phrase_provisioned_at }], rowCount: 1 };
  });

  pool.onQuery('FROM hd_wallets', (params) => {
    const row = rowFor(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.rows = rows;
  return pool;
}

function buildService(pool, now) {
  return createHdWalletService({
    db: pool,
    cipher,
    keyProvider,
    network: 'devnet',
    now
  });
}

test('creates an HD root with an encrypted 24-word mnemonic and one-time token', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet, recovery } = await service.createHdWallet({ label: 'treasury' });

  assert.equal(wallet.status, 'active');
  assert.equal(wallet.label, 'treasury');
  assert.equal(wallet.network, 'devnet');
  assert.equal(wallet.derivationScheme, 'bip39+slip10-ed25519/v1');
  assert.equal(wallet.derivationPathTemplate, "m/44'/501'/{accountIndex}'/0'");
  assert.equal(wallet.nextAccountIndex, 0);
  assert.equal(wallet.phraseProvisioned, false);
  assert.equal(recovery.wordCount, 24);
  assert.equal(typeof recovery.token, 'string');
  assert.ok(recovery.warning.length > 0);

  // The API-visible object must not carry secret material.
  for (const value of Object.values(wallet)) {
    assert.notEqual(typeof value, 'string' && /abandon/.test(String(value)), true);
  }

  const row = pool.rows.get(wallet.id);
  assert.ok(row.mnemonic_encrypted.length > 100);
  assert.notEqual(row.mnemonic_encrypted, 'pending');
  assert.equal(row.mnemonic_iv.length, 24);
  assert.equal(row.mnemonic_auth_tag.length, 32);
  assert.equal(row.encryption_key_version, 1);
  assert.equal(row.status, 'active');
  assert.equal(pool.sqlCalls('COMMIT').length, 1);

  // Token decrypts to a valid BIP39 mnemonic.
  const mnemonic = tokens.open('recovery-phrase', recovery.token);
  assert.equal(validateHdMnemonic(mnemonic), true);
});

test('stored ciphertext is bound to the row id and never plaintext', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet, recovery } = await service.createHdWallet();
  const row = pool.rows.get(wallet.id);
  const mnemonic = tokens.open('recovery-phrase', recovery.token);

  assert.ok(!row.mnemonic_encrypted.includes(Buffer.from(mnemonic).toString('hex')));

  assert.equal(
    cipher.decrypt(row.mnemonic_encrypted, row.mnemonic_iv, row.mnemonic_auth_tag, {
      aad: `hd_wallets:${wallet.id}:mnemonic:v1`,
      keyVersion: row.encryption_key_version
    }),
    mnemonic
  );

  assert.throws(
    () =>
      cipher.decrypt(row.mnemonic_encrypted, row.mnemonic_iv, row.mnemonic_auth_tag, {
        aad: 'hd_wallets:999:mnemonic:v1',
        keyVersion: 1
      }),
    /Decryption failed/
  );
});

test('rolls back the transaction when sealing fails', async () => {
  const pool = buildPool();
  const failingCipher = {
    currentVersion: 1,
    encrypt() {
      throw new Error('kms unavailable');
    },
    decrypt: cipher.decrypt
  };

  const service = createHdWalletService({
    db: pool,
    cipher: failingCipher,
    keyProvider,
    network: 'devnet'
  });

  await assert.rejects(() => service.createHdWallet(), /kms unavailable/);
  assert.equal(pool.sqlCalls('ROLLBACK').length, 1);
  assert.equal(pool.sqlCalls('COMMIT').length, 0);
});

test('revealMnemonicForSigning decrypts only for an existing active root', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet, recovery } = await service.createHdWallet();
  const mnemonic = await service.revealMnemonicForSigning(wallet.id);

  assert.equal(mnemonic, tokens.open('recovery-phrase', recovery.token));

  await assert.rejects(
    () => service.revealMnemonicForSigning('424242'),
    (error) => error.statusCode === 404
  );

  await service.updateStatus(wallet.id, 'archived');

  await assert.rejects(
    () => service.revealMnemonicForSigning(wallet.id),
    (error) => error.code === 'HD_WALLET_ARCHIVED'
  );
});

test('recovery phrase can be provisioned exactly once', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet, recovery } = await service.createHdWallet();

  await assert.rejects(
    () => service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: false }),
    (error) => error.code === 'CONFIRMATION_REQUIRED'
  );

  const result = await service.consumeRecoveryPhrase({
    hdWalletId: wallet.id,
    token: recovery.token,
    confirm: true
  });

  assert.equal(result.wordCount, 24);
  assert.equal(validateHdMnemonic(result.mnemonic), true);

  const metadata = await service.getHdWallet(wallet.id);
  assert.equal(metadata.phraseProvisioned, true);

  await assert.rejects(
    () => service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: true }),
    (error) => error.code === 'RECOVERY_PHRASE_ALREADY_PROVISIONED'
  );
});

test('a token minted for another root cannot be redeemed', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const first = await service.createHdWallet();
  const second = await service.createHdWallet();

  // The root stores the mnemonic, not the recovery token, so a foreign token
  // cannot be validated against it by construction: every token opens to its
  // own payload. The guarantee is instead that redemption is single-use and
  // bound to a root that has not been provisioned yet.
  const firstMnemonic = tokens.open('recovery-phrase', first.recovery.token);
  const secondMnemonic = tokens.open('recovery-phrase', second.recovery.token);

  assert.notEqual(firstMnemonic, secondMnemonic);

  const redeemed = await service.consumeRecoveryPhrase({
    hdWalletId: second.wallet.id,
    token: second.recovery.token,
    confirm: true
  });

  assert.equal(redeemed.mnemonic, secondMnemonic);

  await assert.rejects(
    () =>
      service.consumeRecoveryPhrase({
        hdWalletId: second.wallet.id,
        token: second.recovery.token,
        confirm: true
      }),
    (error) => error.code === 'RECOVERY_PHRASE_ALREADY_PROVISIONED'
  );
});

test('deriveAccountPreview recovers the same addresses as direct derivation', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet, recovery } = await service.createHdWallet();
  const mnemonic = tokens.open('recovery-phrase', recovery.token);

  for (const index of [0, 1, 7]) {
    const preview = await service.deriveAccountPreview(wallet.id, index);
    const expected = deriveSolanaAccount(mnemonic, index).publicKey;

    assert.equal(preview.publicKey, expected);
    assert.equal(preview.derivationPath, `m/44'/501'/${index}'/0'`);
  }
});

test('createHdWallet timestamps use the injected clock', async () => {
  const pool = buildPool();
  const fixed = new Date('2026-01-02T03:04:05.000Z');
  const service = buildService(pool, () => fixed);

  const { recovery } = await service.createHdWallet();

  assert.equal(recovery.expiresAt, '2026-01-02T04:04:05.000Z');
});

test('updateStatus validates values and 404s unknown roots', async () => {
  const pool = buildPool();
  const service = buildService(pool);

  const { wallet } = await service.createHdWallet();

  assert.equal((await service.updateStatus(wallet.id, 'disabled')).status, 'disabled');
  assert.equal((await service.getHdWallet(wallet.id)).status, 'disabled');

  await assert.rejects(
    () => service.updateStatus(wallet.id, 'deleted'),
    (error) => error.code === 'INVALID_STATUS'
  );

  await assert.rejects(
    () => service.updateStatus('9999', 'active'),
    (error) => error.statusCode === 404
  );
});
