import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createTenantContextSigner,
  createTenantScopedDatabase
} from '../src/infrastructure/security/tenant-context.js';

function fakePool() {
  const calls = [];
  let releases = 0;
  return {
    calls,
    get releases() { return releases; },
    async connect() {
      return {
        async query(sql, values) {
          calls.push({ sql: String(sql), values });
          return { rows: [{ ok: true }], rowCount: 1 };
        },
        release() { releases += 1; }
      };
    }
  };
}

const signer = createTenantContextSigner('a'.repeat(64), {
  now: () => 1_800_000_000_000,
  nonce: () => 'b'.repeat(32)
});

test('tenant context signer binds numeric tenant and credential IDs to a deterministic HMAC', () => {
  const signed = signer.create({ tenantId: '42', credentialId: '9' });
  const claims = JSON.parse(signed.payload);

  assert.deepEqual(claims, {
    version: 1,
    tenantId: '42',
    credentialId: '9',
    issuedAt: 1_800_000_000,
    nonce: 'b'.repeat(32)
  });
  assert.match(signed.signature, /^[a-f0-9]{64}$/);
  assert.throws(() => signer.create({ tenantId: 'tenant-42', credentialId: '9' }), /positive integer/);
  assert.throws(() => signer.create({ tenantId: '42', credentialId: '0' }), /positive integer/);
});

test('tenant database wraps every standalone query in a transaction with SET LOCAL ROLE and signed context', async () => {
  const pool = fakePool();
  const context = signer.create({ tenantId: '42', credentialId: '9' });
  const db = createTenantScopedDatabase(pool, context);

  const result = await db.query('SELECT 1 AS ok');

  assert.deepEqual(result.rows, [{ ok: true }]);
  assert.equal(pool.releases, 1);
  assert.deepEqual(pool.calls.map((call) => call.sql), [
    'BEGIN',
    'SET LOCAL ROLE blackchin_tenant_runtime',
    "SELECT\n       set_config('app.tenant_context', $1, true),\n       set_config('app.tenant_context_signature', $2, true)",
    'SELECT 1 AS ok',
    'COMMIT'
  ]);
  assert.deepEqual(pool.calls[2].values, [context.payload, context.signature]);
});

test('tenant database preserves explicit multi-query transactions and applies context once', async () => {
  const pool = fakePool();
  const context = signer.create({ tenantId: '42', credentialId: '9' });
  const db = createTenantScopedDatabase(pool, context);
  const client = await db.connect();

  await client.query('BEGIN');
  await client.query('SELECT 1');
  await client.query('SELECT 2');
  await client.query('COMMIT');
  client.release();

  assert.equal(pool.releases, 1);
  assert.equal(pool.calls.filter((call) => call.sql.includes('set_config')).length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'SET LOCAL ROLE blackchin_tenant_runtime').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'BEGIN').length, 1);
  assert.equal(pool.calls.filter((call) => call.sql === 'COMMIT').length, 1);
});

test('tenant database rolls back failed standalone queries and releases the connection', async () => {
  let releases = 0;
  const calls = [];
  const pool = {
    async connect() {
      return {
        async query(sql) {
          calls.push(String(sql));
          if (String(sql) === 'SELECT explode') throw new Error('query failed');
          return { rows: [], rowCount: 0 };
        },
        release() { releases += 1; }
      };
    }
  };
  const db = createTenantScopedDatabase(pool, signer.create({ tenantId: '42', credentialId: '9' }));

  await assert.rejects(() => db.query('SELECT explode'), /query failed/);
  assert.ok(calls.includes('ROLLBACK'));
  assert.equal(releases, 1);
});

test('tenant database rejects malformed signed context before acquiring a connection', async () => {
  const pool = fakePool();
  assert.throws(
    () => createTenantScopedDatabase(pool, { payload: '{}', signature: 'bad' }),
    /signed tenant context/
  );
  assert.equal(pool.releases, 0);
});
