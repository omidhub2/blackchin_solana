import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  authenticateApiCredential,
  createTenant,
  issueApiCredential,
  revokeApiCredential,
  TENANT_API_SCOPES
} from '../src/infrastructure/database/tenant.repository.js';

function fakeDb(handler) {
  const calls = [];
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql: String(sql), params });
      return handler(String(sql), params, calls.length);
    }
  };
}

const tenantRow = {
  id: '7',
  tenant_code: 'acme-prod',
  display_name: 'Acme',
  status: 'active',
  metadata: {},
  created_at: new Date(),
  updated_at: new Date()
};

test('tenant creation validates input and persists metadata as JSON', async () => {
  const db = fakeDb(async (_sql, params) => ({
    rowCount: 1,
    rows: [{ ...tenantRow, tenant_code: params[0], display_name: params[1], metadata: JSON.parse(params[2]) }]
  }));
  const tenant = await createTenant(db, {
    tenantCode: 'acme-prod',
    displayName: ' Acme ',
    metadata: { environment: 'production' }
  });

  assert.equal(tenant.id, '7');
  assert.equal(tenant.displayName, 'Acme');
  assert.deepEqual(tenant.metadata, { environment: 'production' });
  await assert.rejects(
    createTenant(db, { tenantCode: 'x', displayName: 'Bad' }),
    /tenantCode is invalid/
  );
});

test('credential issuance stores only SHA-256 digest and returns plaintext once', async () => {
  const db = fakeDb(async (_sql, params) => ({
    rowCount: 1,
    rows: [{
      id: '12',
      tenant_id: params[0],
      key_prefix: params[1],
      scopes: params[3],
      status: 'active',
      expires_at: params[4],
      last_used_at: null,
      revoked_at: null,
      created_at: new Date()
    }]
  }));
  const result = await issueApiCredential(db, '7', {
    scopes: ['wallets:read', 'withdrawals:submit']
  });

  assert.match(result.apiKey, /^bc_live_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(result.credential.tenantId, '7');
  assert.deepEqual(result.credential.scopes, ['wallets:read', 'withdrawals:submit']);
  const storedHash = db.calls[0].params[2];
  assert.ok(Buffer.isBuffer(storedHash));
  assert.equal(storedHash.length, 32);
  assert.deepEqual(storedHash, crypto.createHash('sha256').update(result.apiKey).digest());
  assert.equal(db.calls[0].params.some((value) => value === result.apiKey), false);
  assert.deepEqual(TENANT_API_SCOPES.length > 0, true);
});

test('credential authentication rejects unknown prefix and wrong secret', async () => {
  const stored = crypto.createHash('sha256').update('bc_live_prefix.secret').digest();
  const db = fakeDb(async (_sql, params) => ({
    rowCount: 1,
    rows: [{
      credential_id: '12',
      tenant_id: '7',
      key_prefix: params[0],
      secret_hash: stored,
      scopes: ['wallets:read'],
      credential_status: 'active',
      expires_at: null,
      revoked_at: null,
      credential_created_at: new Date(),
      tenant_code: 'acme-prod',
      display_name: 'Acme',
      tenant_status: 'active',
      metadata: {},
      tenant_created_at: new Date(),
      tenant_updated_at: new Date()
    }]
  }));

  assert.equal(await authenticateApiCredential(db, 'bc_live_unknown.secret'), null);
  assert.equal(await authenticateApiCredential(db, 'bc_live_prefix.wrong'), null);
  assert.equal(db.calls.length, 2);
});

test('credential authentication rejects inactive, revoked and expired credentials', async () => {
  for (const overrides of [
    { credential_status: 'revoked' },
    { tenant_status: 'suspended' },
    { tenant_status: 'disabled' },
    { expires_at: new Date(Date.now() - 60_000) },
    { revoked_at: new Date() }
  ]) {
    const stored = crypto.createHash('sha256').update('bc_live_prefix.secret').digest();
    const db = fakeDb(async () => ({
      rowCount: 1,
      rows: [{
        credential_id: '12',
        tenant_id: '7',
        key_prefix: 'bc_live_prefix',
        secret_hash: stored,
        scopes: ['wallets:read'],
        credential_status: 'active',
        expires_at: null,
        revoked_at: null,
        credential_created_at: new Date(),
        tenant_code: 'acme-prod',
        display_name: 'Acme',
        tenant_status: 'active',
        metadata: {},
        tenant_created_at: new Date(),
        tenant_updated_at: new Date(),
        ...overrides
      }]
    }));
    assert.equal(await authenticateApiCredential(db, 'bc_live_prefix.secret'), null);
    assert.equal(db.calls.length, 1);
  }
});

test('successful authentication updates last_used_at and returns trusted tenant context', async () => {
  const stored = crypto.createHash('sha256').update('bc_live_prefix.secret').digest();
  const db = fakeDb(async (sql) => sql.startsWith('SELECT')
    ? {
        rowCount: 1,
        rows: [{
          credential_id: '12',
          tenant_id: '7',
          key_prefix: 'bc_live_prefix',
          secret_hash: stored,
          scopes: ['wallets:read'],
          credential_status: 'active',
          expires_at: null,
          revoked_at: null,
          credential_created_at: new Date(),
          tenant_code: 'acme-prod',
          display_name: 'Acme',
          tenant_status: 'active',
          metadata: {},
          tenant_created_at: new Date(),
          tenant_updated_at: new Date()
        }]
      }
    : { rowCount: 1, rows: [] });

  const identity = await authenticateApiCredential(db, 'bc_live_prefix.secret');
  assert.equal(identity.tenant.id, '7');
  assert.equal(identity.tenant.status, 'active');
  assert.deepEqual(identity.credential.scopes, ['wallets:read']);
  assert.match(db.calls[1].sql, /last_used_at = NOW\(\)/);
});

test('credential revocation is constrained by tenant ownership', async () => {
  const db = fakeDb(async (_sql, params) => ({
    rowCount: 1,
    rows: [{
      id: params[1],
      tenant_id: params[0],
      key_prefix: 'bc_live_prefix',
      scopes: ['wallets:read'],
      status: 'revoked',
      expires_at: null,
      last_used_at: null,
      revoked_at: new Date(),
      created_at: new Date()
    }]
  }));
  const revoked = await revokeApiCredential(db, '7', '12');
  assert.equal(revoked.status, 'revoked');
  assert.deepEqual(db.calls[0].params, ['7', '12']);
  assert.match(db.calls[0].sql, /tenant_id = \$1 AND id = \$2/);
});
