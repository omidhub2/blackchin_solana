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


test('readiness fails when required Solana RPC probe is unavailable', async () => {
  const health = createHealthService({
    pool: pool(),
    rpc: { async getSlot() { throw new Error('rpc down'); } },
    rpcRequired: true
  });
  const result = await health.ready();
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.checks.rpc, 'unavailable');
  assert.ok(result.body.degraded.includes('rpc_unavailable'));
});

test('readiness exposes pool pressure and operational backlogs without failing liveness', async () => {
  const saturatedPool = {
    totalCount: 5,
    idleCount: 0,
    waitingCount: 3,
    options: { max: 5 },
    async query() { return { rows: [{ ok: 1 }] }; }
  };
  const health = createHealthService({
    pool: saturatedPool,
    rpc: { async getSlot() { return 123; } },
    rpcRequired: true,
    backlogStats: async () => ({
      webhookPending: 1200,
      signedWithdrawalsPending: 2,
      ledgerUnderReview: 1,
      depositReconciliationUnderReview: 0,
      withdrawalReconciliationUnderReview: 1,
      oldestWebhookAgeSeconds: 450,
      oldestSignedWithdrawalAgeSeconds: 600
    })
  });
  const result = await health.ready();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.pool.waiting, 3);
  assert.equal(result.body.backlogs.signedWithdrawalsPending, 2);
  assert.ok(result.body.degraded.includes('database_pool_saturation'));
  assert.ok(result.body.degraded.includes('signed_withdrawals_pending'));
  assert.ok(result.body.degraded.includes('transactions_under_review'));
  assert.ok(result.body.degraded.includes('webhook_backlog'));
  assert.ok(result.body.degraded.includes('signed_withdrawal_age'));
});

test('readiness reports webhook worker health and stale state without leaking its last error', async () => {
  const health = createHealthService({
    pool: pool(),
    webhookDeliveryEnabled: true,
    webhookWorker: {
      health() {
        return {
          state: 'running', stale: true, hasLock: true,
          runs: 4, failures: 2, consecutiveFailures: 2,
          lastErrorMessage: 'sensitive internal details'
        };
      }
    }
  });
  const result = await health.ready();
  assert.equal(result.statusCode, 200);
  assert.equal(result.body.workers.webhookDelivery.stale, true);
  assert.ok(result.body.degraded.includes('webhookDelivery_degraded'));
  assert.equal(JSON.stringify(result.body).includes('sensitive internal details'), false);
});
