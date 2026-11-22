import test from 'node:test';
import assert from 'node:assert/strict';

import { withTenantSigningKey } from '../src/infrastructure/security/wallet-signer.js';
import { lockRowsForSigning } from '../src/infrastructure/security/lifecycle-policy.js';

const PUBLIC_KEY = '11111111111111111111111111111111';

test('tenant signer does not resolve a wallet outside the authenticated tenant', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    },
    async connect() {
      throw new Error('A foreign or missing wallet must be rejected before row locking');
    }
  };

  await assert.rejects(
    () => withTenantSigningKey(
      db,
      '42',
      PUBLIC_KEY,
      async () => assert.fail('Signing callback must not run'),
      { cipher: { decrypt() { throw new Error('Decrypt must not run'); } }, deploymentNetwork: 'devnet' }
    ),
    (error) => error.code === 'WALLET_ACCOUNT_NOT_FOUND'
  );

  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /tenant_id\s*=\s*\$1/);
  assert.deepEqual(calls[0].params, ['42', PUBLIC_KEY]);
});

test('signing row locks constrain both child and HD root to the authenticated tenant', async () => {
  const calls = [];
  const client = {
    async query(sql, params) {
      calls.push({ sql: String(sql), params });
      return { rows: [], rowCount: 0 };
    }
  };

  await lockRowsForSigning(client, {
    accountId: '101',
    hdWalletId: '51',
    tenantId: '42'
  });

  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.match(call.sql, /tenant_id\s*=\s*\$2/);
    assert.deepEqual(call.params, [call === calls[0] ? '101' : '51', '42']);
  }
});
