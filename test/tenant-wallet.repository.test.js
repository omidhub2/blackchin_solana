import test from 'node:test';
import assert from 'node:assert/strict';

import {
  findHdWalletByIdForTenant,
  findAccountByPublicKeyForTenant,
  findAccountAtIndexForTenant,
  listAccountsByHdWalletForTenant,
  countAccountsByHdWalletForTenant,
  updateAccountStatusForTenant
} from '../src/infrastructure/database/tenant-wallet.repository.js';

function executor(rows = []) {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows, rowCount: rows.length };
    }
  };
}

test('tenant HD wallet lookup always constrains both tenant and wallet id', async () => {
  const db = executor([]);
  assert.equal(await findHdWalletByIdForTenant(db, 7, '42'), null);
  assert.match(db.calls[0].sql, /tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(db.calls[0].values, ['7', '42']);
});

test('tenant account lookup always constrains tenant and public key', async () => {
  const db = executor([]);
  assert.equal(await findAccountByPublicKeyForTenant(db, '7', 'address'), null);
  assert.match(db.calls[0].sql, /tenant_id = \$1 AND public_key = \$2/);
  assert.deepEqual(db.calls[0].values, ['7', 'address']);
});

test('tenant account index and list queries include tenant_id', async () => {
  const db = executor([]);
  await findAccountAtIndexForTenant(db, 7, '42', 0);
  await listAccountsByHdWalletForTenant(db, 7, '42');
  assert.match(db.calls[0].sql, /tenant_id = \$1 AND hd_wallet_id = \$2/);
  assert.match(db.calls[1].sql, /WHERE tenant_id = \$1 AND hd_wallet_id = \$2/);
});

test('tenant count and status update remain tenant constrained', async () => {
  const db = executor([{ total: '3' }]);
  assert.equal(await countAccountsByHdWalletForTenant(db, 7, '42'), 3);
  assert.match(db.calls[0].sql, /tenant_id = \$1 AND hd_wallet_id = \$2/);

  await updateAccountStatusForTenant(db, 7, 'address', 'disabled');
  assert.match(db.calls[1].sql, /WHERE tenant_id = \$1 AND public_key = \$2/);
  assert.deepEqual(db.calls[1].values, ['7', 'address', 'disabled']);
});

test('tenant repository rejects missing, zero, and malformed tenant identifiers', async () => {
  const db = executor([]);
  for (const tenantId of [undefined, null, 0, '0', '-1', 'abc', '']) {
    await assert.rejects(
      findAccountByPublicKeyForTenant(db, tenantId, 'address'),
      /tenantId must be a positive integer/
    );
  }
  assert.equal(db.calls.length, 0);
});


test('tenant HD wallet creation persists tenant ownership explicitly', async () => {
  const db = executor([]);
  await import('../src/infrastructure/database/tenant-wallet.repository.js').then(({ insertHdWalletForTenant }) =>
    insertHdWalletForTenant(db, 9, {
      network: 'devnet', derivationScheme: 'bip39+slip10-ed25519/v1',
      derivationPathTemplate: "m/44'/501'/{accountIndex}'/0'",
      mnemonicEncrypted: 'ciphertext', mnemonicIv: 'iv', mnemonicAuthTag: 'tag',
      encryptionKeyVersion: 1
    })
  );
  assert.match(db.calls[0].sql, /INSERT INTO hd_wallets \(\s*tenant_id,/);
  assert.equal(db.calls[0].values[0], '9');
});

test('tenant HD wallet status and recovery token mutations constrain tenant and wallet', async () => {
  const {
    updateHdWalletStatusForTenant, storeRecoveryTokenForTenant,
    redeemRecoveryTokenForTenant
  } = await import('../src/infrastructure/database/tenant-wallet.repository.js');
  const db = executor([]);
  await updateHdWalletStatusForTenant(db, 9, 41, 'disabled');
  assert.match(db.calls[0].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(db.calls[0].values, ['9', 41, 'disabled']);

  await storeRecoveryTokenForTenant(db, 9, 41, {
    tokenHash: 'a'.repeat(64), expiresAt: new Date(Date.now() + 60_000)
  });
  assert.match(db.calls[1].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(db.calls[1].values.slice(0, 2), ['9', 41]);

  await redeemRecoveryTokenForTenant(db, 9, 41, 'b'.repeat(64));
  assert.match(db.calls[2].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(db.calls[2].values, ['9', 41, 'b'.repeat(64)]);
});

test('tenant account allocation locks and updates only the tenant-owned HD root', async () => {
  const {
    allocateAccountIndexesForTenant, rewindAccountIndexForTenant
  } = await import('../src/infrastructure/database/tenant-wallet.repository.js');
  const row = {
    id: '41', owner_id: null, label: null, network: 'devnet',
    derivation_scheme: 'bip39+slip10-ed25519/v1',
    derivation_path_template: "m/44'/501'/{accountIndex}'/0'",
    next_account_index: 3, status: 'active', phrase_provisioned_at: null,
    recovery_token_hash: null, recovery_token_expires_at: null,
    created_at: new Date(), updated_at: new Date(),
    encryption_key_version: 1, mnemonic_encrypted: 'enc',
    mnemonic_iv: 'iv', mnemonic_auth_tag: 'tag'
  };
  const calls = [];
  const client = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('FOR UPDATE')) return { rows: [row], rowCount: 1 };
      if (sql.includes('RETURNING id, owner_id')) {
        return { rows: [{ ...row, next_account_index: values[2] }], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    }
  };
  const allocation = await allocateAccountIndexesForTenant(client, 9, 41, 2);
  assert.deepEqual(allocation.indexes, [3, 4]);
  assert.match(calls[1].sql, /WHERE tenant_id = \$1 AND id = \$2 FOR UPDATE/);
  assert.deepEqual(calls[1].values, ['9', 41]);
  assert.match(calls[2].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(calls[2].values, ['9', 41, 5]);

  await rewindAccountIndexForTenant(client, 9, 41, 3);
  assert.match(calls[3].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.match(calls[3].sql, /wallet_accounts\s+WHERE tenant_id = \$1 AND hd_wallet_id = \$2/);
});

test('tenant child account insertion verifies parent ownership and writes tenant_id', async () => {
  const { insertWalletAccountsForTenant } =
    await import('../src/infrastructure/database/tenant-wallet.repository.js');
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      if (sql.includes('SELECT network, derivation_scheme')) {
        return { rows: [{ network: 'devnet', derivation_scheme: 'bip39+slip10-ed25519/v1' }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
  await insertWalletAccountsForTenant(db, 9, [{
    hdWalletId: 41, publicKey: 'address', accountIndex: 0,
    derivationPath: "m/44'/501'/0'/0'", network: 'devnet',
    scheme: 'bip39+slip10-ed25519/v1'
  }]);
  assert.match(calls[0].sql, /WHERE tenant_id = \$1 AND id = \$2/);
  assert.deepEqual(calls[0].values, ['9', '41']);
  assert.match(calls[1].sql, /INSERT INTO wallet_accounts \(\s*tenant_id,/);
  assert.equal(calls[1].values[0], '9');
});

test('tenant child insertion rejects an HD root owned by another tenant before insert', async () => {
  const { insertWalletAccountsForTenant } =
    await import('../src/infrastructure/database/tenant-wallet.repository.js');
  const db = executor([]);
  await assert.rejects(
    insertWalletAccountsForTenant(db, 9, [{
      hdWalletId: 41, publicKey: 'address', accountIndex: 0,
      derivationPath: "m/44'/501'/0'/0'", network: 'devnet',
      scheme: 'bip39+slip10-ed25519/v1'
    }]),
    (error) => error.code === 'HD_WALLET_NOT_FOUND'
  );
  assert.equal(db.calls.length, 1);
});
