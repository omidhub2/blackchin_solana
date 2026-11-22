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
