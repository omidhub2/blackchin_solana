process.env.API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'k'.repeat(40);

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/api/server.js';

function harness(role = 'admin') {
  const calls = [];
  const policyCalls = [];
  const db = {
    async query(sql, params = []) {
      const query = String(sql);
      if (query.includes('rate_limit_counters')) {
        return { rowCount: 1, rows: [{ hit_count: '1', window_ends_at: new Date(Date.now() + 60_000).toISOString() }] };
      }
      calls.push({ query, params });
      return { rowCount: 1, rows: [] };
    }
  };
  const tenantWithdrawalPolicy = {
    async configurePolicy(input) {
      policyCalls.push(['configurePolicy', input]);
      return { tenantId: input.tenantId, enabled: input.enabled, emergencyFrozen: true, policyVersion: '2' };
    },
    async freeze(input) {
      policyCalls.push(['freeze', input]);
      return { tenantId: input.tenantId, emergencyFrozen: true, freezeReason: input.reason, policyVersion: '3' };
    },
    async unfreeze(input) {
      policyCalls.push(['unfreeze', input]);
      return { tenantId: input.tenantId, emergencyFrozen: false, policyVersion: '4' };
    },
    async issueApproval(input) {
      policyCalls.push(['issueApproval', input]);
      return { tenantId: input.tenantId, credentialId: input.credentialId, approvalReference: input.approvalReference, amountLamports: input.amountLamports, status: 'approved' };
    }
  };
  const services = {
    deps: { db },
    dashboardAuth: {
      async authenticate(token) {
        if (token !== 'valid-session') return null;
        return {
          sessionId: 'session-1',
          csrfTokenHash: Buffer.from('csrf'),
          expiresAt: new Date(Date.now() + 60_000),
          user: { id: '1', email: 'admin@example.com', role, status: 'active' }
        };
      },
      verifyCsrf(_session, token) { return token === 'valid-csrf'; },
      async logout() {}
    },
    tenantWithdrawalPolicy,
    dashboard: { async overview() { return { lastEventId: 0 }; } }
  };
  return { calls, policyCalls, services };
}

function headers() {
  return {
    cookie: 'bc_dashboard_session=valid-session',
    'x-csrf-token': 'valid-csrf'
  };
}

test('only dashboard admins can configure tenant withdrawal policy', async () => {
  const h = harness('viewer');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/dashboard/tenants/42/withdrawal-policy',
      headers: headers(),
      payload: {
        enabled: true,
        maxSingleLamports: '100000000',
        maxDailyLamports: '500000000',
        maxWeeklyLamports: '2000000000',
        maxDailyCount: 5,
        maxWeeklyCount: 20
      }
    });
    assert.equal(response.statusCode, 403);
    assert.equal(h.policyCalls.length, 0);
  } finally {
    await app.close();
  }
});

test('admin policy configuration is tenant-scoped and requires CSRF', async () => {
  const h = harness('admin');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const noCsrf = await app.inject({
      method: 'PUT',
      url: '/api/v1/dashboard/tenants/42/withdrawal-policy',
      headers: { cookie: 'bc_dashboard_session=valid-session' },
      payload: {
        enabled: true,
        maxSingleLamports: '100000000',
        maxDailyLamports: '500000000',
        maxWeeklyLamports: '2000000000',
        maxDailyCount: 5,
        maxWeeklyCount: 20
      }
    });
    assert.equal(noCsrf.statusCode, 403);
    assert.equal(h.policyCalls.length, 0);

    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/dashboard/tenants/42/withdrawal-policy',
      headers: headers(),
      payload: {
        enabled: true,
        maxSingleLamports: '100000000',
        maxDailyLamports: '500000000',
        maxWeeklyLamports: '2000000000',
        maxDailyCount: 5,
        maxWeeklyCount: 20
      }
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(h.policyCalls[0], ['configurePolicy', {
      tenantId: 42,
      enabled: true,
      maxSingleLamports: '100000000',
      maxDailyLamports: '500000000',
      maxWeeklyLamports: '2000000000',
      maxDailyCount: 5,
      maxWeeklyCount: 20,
      updatedBy: 'admin@example.com'
    }]);
  } finally {
    await app.close();
  }
});

test('admin withdrawal approval endpoint hashes the exact lamport amount', async () => {
  const h = harness('admin');
  const app = buildServer({ logger: false, services: h.services });
  const wallet = '11111111111111111111111111111111';
  const destination = 'Stake11111111111111111111111111111111111111';
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboard/tenants/42/withdrawal-approvals',
      headers: headers(),
      payload: {
        credentialId: '7',
        approvalReference: 'approval-tenant-0001',
        walletPublicKey: wallet,
        destinationPublicKey: destination,
        network: 'devnet',
        amountSol: '0.1',
        expiresInSeconds: 300
      }
    });
    assert.equal(response.statusCode, 201);
    const issued = h.policyCalls.find(([name]) => name === 'issueApproval');
    assert.equal(issued[1].amountLamports, '100000000');
    assert.equal(issued[1].tenantId, 42);
    assert.equal(issued[1].credentialId, 7);
    assert.match(issued[1].requestHash, /^[a-f0-9]{64}$/);
  } finally {
    await app.close();
  }
});
