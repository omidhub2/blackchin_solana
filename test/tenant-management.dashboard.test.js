process.env.API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'k'.repeat(40);

import test from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from '../src/api/server.js';

function harness(role = 'admin') {
  const queries = [];
  const tenant = {
    id: '23',
    tenant_code: 'acme-prod',
    display_name: 'Acme Production',
    status: 'pending',
    metadata: {},
    created_at: new Date(),
    updated_at: new Date()
  };
  const db = {
    async query(sql, params = []) {
      const query = String(sql);
      queries.push({ query, params });
      if (query.includes('rate_limit_counters')) {
        return {
          rowCount: 1,
          rows: [{ hit_count: '1', window_ends_at: new Date(Date.now() + 60_000).toISOString() }]
        };
      }
      if (query.startsWith('INSERT INTO tenants')) {
        return { rowCount: 1, rows: [{ ...tenant, tenant_code: params[0], display_name: params[1] }] };
      }
      if (query.startsWith('UPDATE tenants')) {
        return { rowCount: 1, rows: [{ ...tenant, status: params[1] }] };
      }
      if (query.includes('INSERT INTO operational_events')) {
        return { rowCount: 1, rows: [] };
      }
      return { rowCount: 0, rows: [] };
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
    dashboard: { async overview() { return { lastEventId: 0 }; } }
  };
  return { queries, services };
}

const headers = {
  cookie: 'bc_dashboard_session=valid-session',
  'x-csrf-token': 'valid-csrf'
};

test('tenant creation is admin-only, CSRF protected and starts pending', async () => {
  const h = harness('admin');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboard/tenants',
      headers,
      payload: { tenantCode: 'acme-prod', displayName: 'Acme Production' }
    });
    assert.equal(response.statusCode, 201);
    assert.equal(response.json().tenant.status, 'pending');
    assert.equal(response.json().tenant.id, '23');
    assert.ok(h.queries.some(({ query }) => query.includes('INSERT INTO tenants')));
    assert.ok(h.queries.some(({ query }) => query.includes('INSERT INTO operational_events')));
  } finally {
    await app.close();
  }
});

test('tenant creation rejects non-admin dashboard roles', async () => {
  const h = harness('operator');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/dashboard/tenants',
      headers,
      payload: { tenantCode: 'acme-prod', displayName: 'Acme Production' }
    });
    assert.equal(response.statusCode, 403);
    assert.equal(h.queries.some(({ query }) => query.startsWith('INSERT INTO tenants')), false);
  } finally {
    await app.close();
  }
});

test('tenant status changes are admin-only and audited', async () => {
  const h = harness('admin');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/dashboard/tenants/23/status',
      headers,
      payload: { status: 'active' }
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().tenant.status, 'active');
    assert.ok(h.queries.some(({ query }) => query.startsWith('UPDATE tenants')));
    assert.ok(h.queries.some(({ query }) => query.includes('INSERT INTO operational_events')));
  } finally {
    await app.close();
  }
});

test('tenant status endpoint rejects unsupported states', async () => {
  const h = harness('admin');
  const app = buildServer({ logger: false, services: h.services });
  try {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/v1/dashboard/tenants/23/status',
      headers,
      payload: { status: 'pending' }
    });
    assert.equal(response.statusCode, 400);
    assert.equal(h.queries.some(({ query }) => query.startsWith('UPDATE tenants')), false);
  } finally {
    await app.close();
  }
});
