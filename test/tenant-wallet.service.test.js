import test from 'node:test';
import assert from 'node:assert/strict';

import { createTenantWalletService } from '../src/core/tenant-wallets/tenant-wallet.service.js';
import { createCipher, createEnvKeyProvider } from '../src/infrastructure/security/hd-envelope.js';
import { validateHdMnemonic } from '../src/blockchain/solana/hd/derivation.js';

const keyProvider = createEnvKeyProvider({ ENCRYPTION_KEY: 'e'.repeat(64) });
const cipher = createCipher(keyProvider);

function buildPool() {
  const calls = [];
  let row = null;
  const query = async (sql, values = []) => {
    calls.push({ sql, values });
    if (sql.includes('INSERT INTO hd_wallets')) {
      row = {
        id: '101', tenant_id: values[0], owner_id: values[1], label: values[2],
        network: values[3], derivation_scheme: values[4],
        derivation_path_template: values[5], mnemonic_encrypted: values[6],
        mnemonic_iv: values[7], mnemonic_auth_tag: values[8],
        encryption_key_version: values[9], next_account_index: 0,
        status: values[10], phrase_provisioned_at: null,
        recovery_token_hash: null, recovery_token_expires_at: null,
        created_at: new Date(), updated_at: new Date()
      };
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('SET mnemonic_encrypted = $3')) {
      if (!row || row.tenant_id !== values[0] || row.id !== String(values[1])) {
        return { rows: [], rowCount: 0 };
      }
      Object.assign(row, {
        mnemonic_encrypted: values[2], mnemonic_iv: values[3],
        mnemonic_auth_tag: values[4], encryption_key_version: values[5], status: 'active'
      });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SET recovery_token_hash = $3')) {
      if (!row || row.tenant_id !== values[0] || row.id !== String(values[1])) {
        return { rows: [], rowCount: 0 };
      }
      row.recovery_token_hash = values[2];
      row.recovery_token_expires_at = values[3];
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (sql.includes('SET phrase_provisioned_at = NOW()')) {
      if (!row || row.tenant_id !== values[0] || row.id !== String(values[1]) ||
          row.recovery_token_hash !== values[2] || row.phrase_provisioned_at !== null) {
        return { rows: [], rowCount: 0 };
      }
      row.phrase_provisioned_at = new Date();
      row.recovery_token_hash = null;
      row.recovery_token_expires_at = null;
      return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (sql.includes('FROM hd_wallets') && sql.includes('WHERE tenant_id = $1 AND id = $2')) {
      const found = row && row.tenant_id === values[0] && row.id === String(values[1]) ? row : null;
      return { rows: found ? [found] : [], rowCount: found ? 1 : 0 };
    }
    return { rows: [], rowCount: 0 };
  };
  return {
    calls,
    query,
    async connect() {
      return { query, release() {} };
    }
  };
}

function buildService(db) {
  return createTenantWalletService({
    db, cipher, keyProvider, network: 'devnet',
    now: () => new Date('2026-11-22T12:00:00.000Z')
  });
}

test('tenant wallet service creates encrypted HD roots and tenant-bound recovery tokens', async () => {
  const db = buildPool();
  const service = buildService(db);
  const { wallet, recovery } = await service.createHdWallet({
    tenantId: 12, label: 'tenant vault'
  });

  assert.equal(wallet.id, '101');
  assert.equal(wallet.status, 'active');
  assert.equal(wallet.label, 'tenant vault');
  assert.equal(wallet.network, 'devnet');
  assert.equal(recovery.wordCount, 24);
  assert.equal(typeof recovery.token, 'string');
  assert.equal(db.calls.some((call) =>
    call.sql.includes('INSERT INTO hd_wallets') && call.values[0] === '12'
  ), true);
  assert.equal(db.calls.some((call) =>
    call.sql.includes('WHERE tenant_id = $1 AND id = $2')
  ), true);

  const mnemonic = await service.revealMnemonicForSigning(12, wallet.id);
  assert.equal(validateHdMnemonic(mnemonic), true);
  assert.equal((await service.getHdWallet(13, wallet.id)).id, undefined);
});

test('tenant recovery phrase redemption is single-use and tenant constrained', async () => {
  const db = buildPool();
  const service = buildService(db);
  const { wallet, recovery } = await service.createHdWallet({ tenantId: 12 });

  await assert.rejects(
    () => service.consumeRecoveryPhrase({
      tenantId: 13, hdWalletId: wallet.id, token: recovery.token, confirm: true
    }),
    (error) => error.code === 'HD_WALLET_NOT_FOUND'
  );

  const redeemed = await service.consumeRecoveryPhrase({
    tenantId: 12, hdWalletId: wallet.id, token: recovery.token, confirm: true
  });
  assert.equal(validateHdMnemonic(redeemed.mnemonic), true);

  await assert.rejects(
    () => service.consumeRecoveryPhrase({
      tenantId: 12, hdWalletId: wallet.id, token: recovery.token, confirm: true
    }),
    (error) => error.code === 'RECOVERY_PHRASE_ALREADY_PROVISIONED'
  );
});

test('tenant service refuses missing tenant context before database access', async () => {
  const db = buildPool();
  const service = buildService(db);
  await assert.rejects(
    () => service.createHdWallet({ label: 'must not be global' }),
    /tenantId must be a positive integer/
  );
  assert.equal(db.calls.length, 0);
});
