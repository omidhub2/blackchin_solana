process.env.API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'k'.repeat(40);

import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';
import { buildServer } from '../src/api/server.js';

function harness(scopes = ['withdrawals:estimate', 'withdrawals:write']) {
  const apiKey = 'bc_live_tenantwithdraw.secret';
  const secretHash = crypto.createHash('sha256').update(apiKey).digest();
  const calls = [];
  const db = {
    async query(sql) {
      if (String(sql).toLowerCase().includes('rate_limit_counters')) return { rowCount: 1, rows: [{ hit_count: '1', window_ends_at: new Date(Date.now() + 60_000).toISOString() }] };
      if (String(sql).startsWith('SELECT')) return {
        rowCount: 1,
        rows: [{
          credential_id: 'credential-1', tenant_id: '42', key_prefix: 'bc_live_tenantwithdraw',
          secret_hash: secretHash, scopes, credential_status: 'active', expires_at: null,
          revoked_at: null, credential_created_at: new Date(), tenant_code: 'tenant-42',
          display_name: 'Tenant 42', tenant_status: 'active', metadata: {},
          tenant_created_at: new Date(), tenant_updated_at: new Date()
        }]
      };
      return { rows: [], rowCount: 1 };
    }
  };
  const tenantWithdrawals = {
    async estimate(input) { calls.push(['estimate', input]); return { network: 'devnet', sufficientBalance: true }; },
    async submit(input) { calls.push(['submit', input]); return { sent: true, signature: 'sig', replayed: false }; },
    async list(input) { calls.push(['list', input]); return { items: [], ...input }; },
    async get(input) { calls.push(['get', input]); return { status: 'processing', ...input }; }
  };
  return { apiKey, calls, services: { deps: { db }, tenantWithdrawals } };
}

const sender = Keypair.generate().publicKey.toBase58();
const recipient = Keypair.generate().publicKey.toBase58();

test('tenant withdrawal estimate uses authenticated tenant identity', async () => {
  const h = harness();
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/tenant/withdrawals/estimate',
      headers: { 'x-api-key': h.apiKey },
      payload: { fromPublicKey: sender, toPublicKey: recipient, amountSol: '0.25' }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.calls[0], ['estimate', {
      tenantId: '42', fromPublicKey: sender, toPublicKey: recipient, amountSol: '0.25'
    }]);
  } finally { await app.close(); }
});

test('tenant withdrawal submit requires idempotency key and a partner approval reference', async () => {
  const h = harness();
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/tenant/withdrawals',
      headers: { 'x-api-key': h.apiKey, 'idempotency-key': 'tenant-withdrawal-key-001' },
      payload: { fromPublicKey: sender, toPublicKey: recipient, amountSol: '0.25', approvalReference: 'partner-approval-001' }
    });
    assert.equal(response.statusCode, 201);
    assert.equal(h.calls[0][0], 'submit');
    assert.equal(h.calls[0][1].tenantId, '42');
    assert.equal(h.calls[0][1].idempotencyKey, 'tenant-withdrawal-key-001');
    assert.equal(h.calls[0][1].approvalReference, 'partner-approval-001');
    assert.equal(h.calls[0][1].credentialId, 'credential-1');
  } finally { await app.close(); }
});

test('tenant withdrawal history is scoped to the authenticated tenant', async () => {
  const h = harness(['withdrawals:read']);
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/tenant/withdrawals?limit=10&offset=5',
      headers: { 'x-api-key': h.apiKey }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.calls[0], ['list', { tenantId: '42', limit: 10, offset: 5 }]);
  } finally { await app.close(); }
});

test('tenant withdrawal detail lookup receives authenticated tenant and idempotency key', async () => {
  const h = harness(['withdrawals:read']);
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'GET', url: '/api/v1/tenant/withdrawals/tenant-withdrawal-key-001',
      headers: { 'x-api-key': h.apiKey }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.calls[0], ['get', { tenantId: '42', idempotencyKey: 'tenant-withdrawal-key-001' }]);
  } finally { await app.close(); }
});
test('tenant withdrawal routes enforce operation scopes', async () => {
  const h = harness(['withdrawals:estimate']);
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'POST', url: '/api/v1/tenant/withdrawals',
      headers: { 'x-api-key': h.apiKey, 'idempotency-key': 'tenant-withdrawal-key-001' },
      payload: { fromPublicKey: sender, toPublicKey: recipient, amountSol: '0.25', approvalReference: 'partner-approval-001' }
    });
    assert.equal(response.statusCode, 403);
    assert.equal(h.calls.length, 0);
  } finally { await app.close(); }
});
