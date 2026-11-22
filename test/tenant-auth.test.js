import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import { createTenantAuthHook, requireTenantScope } from '../src/api/middleware/tenant-auth.js';

function replyStub() {
  return {
    statusCode: 200,
    payload: null,
    code(statusCode) {
      this.statusCode = statusCode;
      return this;
    },
    send(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function credentialDb({ tenantStatus = 'active', credentialStatus = 'active', expiresAt = null } = {}) {
  const apiKey = 'bc_live_prefix.secret';
  const secretHash = crypto.createHash('sha256').update(apiKey).digest();
  return {
    async query(sql) {
      if (String(sql).startsWith('SELECT')) {
        return {
          rowCount: 1,
          rows: [{
            credential_id: 'credential-9',
            tenant_id: 'tenant-4',
            key_prefix: 'bc_live_prefix',
            secret_hash: secretHash,
            scopes: ['wallets:read', 'transactions:read'],
            credential_status: credentialStatus,
            expires_at: expiresAt,
            revoked_at: credentialStatus === 'revoked' ? new Date() : null,
            credential_created_at: new Date(),
            tenant_code: 'acme',
            display_name: 'Acme',
            tenant_status: tenantStatus,
            metadata: {},
            tenant_created_at: new Date(),
            tenant_updated_at: new Date()
          }]
        };
      }
      return { rowCount: 1, rows: [] };
    }
  };
}

test('tenant auth rejects a missing API credential', async () => {
  const hook = createTenantAuthHook({ db: credentialDb() });
  const reply = replyStub();
  const request = { headers: {} };

  await hook(request, reply);

  assert.equal(reply.statusCode, 401);
  assert.equal(reply.payload.error, 'UNAUTHORIZED');
  assert.equal(request.tenant, undefined);
});

test('tenant auth attaches trusted tenant identity and credential scopes', async () => {
  const hook = createTenantAuthHook({ db: credentialDb() });
  const reply = replyStub();
  const request = { headers: { 'x-api-key': 'bc_live_prefix.secret' } };

  await hook(request, reply);

  assert.equal(reply.payload, null);
  assert.deepEqual(request.tenant, {
    id: 'tenant-4',
    code: 'acme',
    status: 'active',
    credentialId: 'credential-9',
    scopes: ['wallets:read', 'transactions:read']
  });
  assert.equal(Object.isFrozen(request.tenant), true);
  assert.equal(Object.isFrozen(request.tenant.scopes), true);
});

test('tenant auth rejects suspended tenants and revoked credentials', async () => {
  for (const db of [
    credentialDb({ tenantStatus: 'suspended' }),
    credentialDb({ credentialStatus: 'revoked' })
  ]) {
    const hook = createTenantAuthHook({ db });
    const reply = replyStub();
    const request = { headers: { 'x-api-key': 'bc_live_prefix.secret' } };

    await hook(request, reply);

    assert.equal(reply.statusCode, 401);
    assert.equal(request.tenant, undefined);
  }
});

test('tenant scope guard distinguishes missing context from insufficient scope', async () => {
  const guard = requireTenantScope('withdrawals:submit');
  const missingReply = replyStub();

  await guard({ tenant: null }, missingReply);
  assert.equal(missingReply.statusCode, 401);
  assert.equal(missingReply.payload.error, 'TENANT_CONTEXT_REQUIRED');

  const scopeReply = replyStub();
  await guard({ tenant: { id: 'tenant-4', scopes: ['wallets:read'] } }, scopeReply);
  assert.equal(scopeReply.statusCode, 403);
  assert.equal(scopeReply.payload.error, 'INSUFFICIENT_SCOPE');

  const allowedReply = replyStub();
  await guard({ tenant: { id: 'tenant-4', scopes: ['withdrawals:submit'] } }, allowedReply);
  assert.equal(allowedReply.payload, null);
});

test('tenant auth requires a database query executor', () => {
  assert.throws(() => createTenantAuthHook({ db: null }), /database query executor/);
});
