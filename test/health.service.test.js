import test from 'node:test';
import assert from 'node:assert/strict';

import { createHealthService } from '../src/core/health.service.js';

function pool() {
  return { async query() { return { rows: [{ ok: 1 }] }; } };
}

function workerHealth(overrides = {}) {
  return {
    state: 'running',
    hasLock: true,
    stale: false,
    health() { return { ...this }; },
    ...overrides
  };
}

test('readiness is 503 when scanner worker does not own its lock', async () => {
  const health = createHealthService({
    pool: pool(),
    scanner: workerHealth({ hasLock: false }),
    workerEnabled: true
  });

  const result = await health.ready();

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.ready, false);
});

test('readiness is 503 when scanner worker success is stale', async () => {
  const health = createHealthService({
    pool: pool(),
    scanner: workerHealth({ stale: true }),
    workerEnabled: true
  });

  const result = await health.ready();

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.ready, false);
});

test('readiness is 200 when enabled workers are running, locked and fresh', async () => {
  const health = createHealthService({
    pool: pool(),
    scanner: workerHealth(),
    workerEnabled: true,
    reconciliationWorker: workerHealth(),
    reconciliationEnabled: true,
    withdrawalReconciliationWorker: workerHealth(),
    withdrawalReconciliationEnabled: true
  });

  const result = await health.ready();

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.ready, true);
});
