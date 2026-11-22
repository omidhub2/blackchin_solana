process.env.API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'k'.repeat(40);

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { buildServer } from '../src/api/server.js';

function makeCredentialDb({ tenantId = '41', scopes = ['wallets:read', 'wallets:write', 'addresses:write', 'deposits:read'] } = {}) {
  const apiKey = 'bc_live_test.secret-value';
  const secretHash = crypto.createHash('sha256').update(apiKey, 'utf8').digest();
  const db = {
    async query(sql) {
      if (String(sql).includes('INSERT INTO rate_limit_counters')) {
        return { rowCount: 1, rows: [{ hit_count: 1, window_ends_at: new Date(Date.now() + 60_000) }] };
      }
      if (String(sql).startsWith('SELECT')) {
        return { rowCount: 1, rows: [{
          credential_id: 'credential-1', tenant_id: tenantId, key_prefix: 'bc_live_test',
          secret_hash: secretHash, scopes, credential_status: 'active', expires_at: null,
          revoked_at: null, credential_created_at: new Date(), tenant_code: 'tenant-test',
          display_name: 'Tenant Test', tenant_status: 'active', metadata: {},
          tenant_created_at: new Date(), tenant_updated_at: new Date()
        }] };
      }
      return { rowCount: 1, rows: [] };
    }
  };
  return { db, apiKey };
}

function makeServices({ tenantId = '41', scopes } = {}) {
  const credential = makeCredentialDb({ tenantId, scopes });
  const calls = [];
  const tenantWallets = {
    async createHdWallet(input) {
      calls.push(['createHdWallet', input]);
      return { wallet: { id: '901', network: 'devnet' }, recovery: { token: 'one-time' } };
    },
    async getHdWallet(id, walletId) {
      calls.push(['getHdWallet', id, walletId]);
      return { id: String(walletId), tenantId: id };
    },
    async updateStatus(...args) { calls.push(['updateStatus', ...args]); return {}; },
    async consumeRecoveryPhrase(input) { calls.push(['consumeRecoveryPhrase', input]); return {}; },
    async listAccounts(...args) { calls.push(['listAccounts', ...args]); return {}; },
    async createAccounts(...args) { calls.push(['createAccounts', ...args]); return {}; },
    async getAccountAtIndex(...args) { calls.push(['getAccountAtIndex', ...args]); return {}; }
  };
  const deposits = {
    async listForTenant(...args) { calls.push(['listForTenant', ...args]); return []; },
    async getForTenant(...args) { calls.push(['getForTenant', ...args]); return { signature: args[1], tenantId: args[0] }; }
  };
  return {
    calls,
    apiKey: credential.apiKey,
    services: { deps: { db: credential.db }, tenantWallets, deposits }
  };
}

test('tenant wallet API authenticates with tenant key without sending the legacy global key', async () => {
  const fake = makeServices();
  const app = buildServer({ logger: false, services: fake.services });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/tenant/hd-wallets',
      headers: { 'x-api-key': fake.apiKey }, payload: { label: 'vault' }
    });
    assert.equal(response.statusCode, 201);
    assert.equal(fake.calls[0][0], 'createHdWallet');
    assert.equal(fake.calls[0][1].tenantId, '41');
    assert.equal(response.headers['cache-control'], 'no-store');
  } finally {
    await app.close();
  }
});

test('tenant wallet API rejects missing credentials and insufficient scopes', async () => {
  const fake = makeServices({ scopes: ['wallets:read'] });
  const app = buildServer({ logger: false, services: fake.services });
  try {
    const missing = await app.inject({ method: 'GET', url: '/api/v1/tenant/hd-wallets/901' });
    assert.equal(missing.statusCode, 401);

    const forbidden = await app.inject({
      method: 'POST', url: '/api/v1/tenant/hd-wallets',
      headers: { 'x-api-key': fake.apiKey }, payload: {}
    });
    assert.equal(forbidden.statusCode, 403);
    assert.equal(forbidden.json().error, 'INSUFFICIENT_SCOPE');
    assert.equal(fake.calls.length, 0);
  } finally {
    await app.close();
  }
});

test('tenant wallet lookup always receives the authenticated tenant id', async () => {
  const fake = makeServices({ tenantId: '77' });
  const app = buildServer({ logger: false, services: fake.services });
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/tenant/hd-wallets/901',
      headers: { 'x-api-key': fake.apiKey }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0], ['getHdWallet', '77', 901]);
  } finally {
    await app.close();
  }
});

test('tenant deposit history is scoped to the authenticated tenant', async () => {
  const fake = makeServices({ tenantId: '88', scopes: ['deposits:read'] });
  const app = buildServer({ logger: false, services: fake.services });
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/tenant/deposits?limit=10&offset=5',
      headers: { 'x-api-key': fake.apiKey }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0], ['listForTenant', '88', { limit: 10, offset: 5 }]);
  } finally {
    await app.close();
  }
});

test('tenant deposit detail lookup cannot omit authenticated tenant scope', async () => {
  const fake = makeServices({ tenantId: '99', scopes: ['deposits:read'] });
  const app = buildServer({ logger: false, services: fake.services });
  try {
    const signature = '5'.repeat(88);
    const response = await app.inject({
      method: 'GET', url: `/api/v1/tenant/deposits/${signature}`,
      headers: { 'x-api-key': fake.apiKey }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(fake.calls[0], ['getForTenant', '99', signature]);
  } finally {
    await app.close();
  }
});
