import test from 'node:test';
import assert from 'node:assert/strict';
import { rateLimitHook } from '../src/api/middleware/rate-limit.js';

test('authenticated tenant rate-limit buckets are isolated by trusted tenant identity', async () => {
  const limit = rateLimitHook({ limit: 1, windowMs: 60_000, keyPrefix: 'tenant-route' });

  await limit({ ip: '203.0.113.10', tenant: { id: '1001' } });
  await limit({ ip: '203.0.113.10', tenant: { id: '1002' } });

  await assert.rejects(
    limit({ ip: '203.0.113.10', tenant: { id: '1001' } }),
    (error) => error.code === 'RATE_LIMITED'
  );
});

test('unauthenticated tenant preflight bucket is still keyed by source IP', async () => {
  const limit = rateLimitHook({ limit: 1, windowMs: 60_000, keyPrefix: 'tenant-auth-preflight' });

  await limit({ ip: '203.0.113.11', headers: {} });
  await assert.rejects(
    limit({ ip: '203.0.113.11', headers: {} }),
    (error) => error.code === 'RATE_LIMITED'
  );
});
