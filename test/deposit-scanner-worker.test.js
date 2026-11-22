import test from 'node:test';
import assert from 'node:assert/strict';

import { createDepositScannerWorker } from '../src/workers/deposit-scanner.worker.js';

test('worker retries lock acquisition without becoming permanently idle', async () => {
  let lockAttempts = 0;
  let scans = 0;
  let releasedClients = 0;

  const worker = createDepositScannerWorker({
    scanner: {
      metrics: {},
      async scan() {
        scans += 1;
        return { signatures: 0, recorded: 0, duplicates: 0, failed: 0 };
      }
    },
    cursors: {
      async acquireScannerLock() {
        lockAttempts += 1;
        return lockAttempts === 1 ? null : { async release() {} };
      }
    },
    pool: {
      async connect() {
        return {
          release() {
            releasedClients += 1;
          }
        };
      }
    },
    network: 'devnet',
    scope: 'all',
    intervalMs: 1_000,
    minBackoffMs: 1_000,
    maxBackoffMs: 2_000
  });

  try {
    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 1_150));

    assert.equal(lockAttempts, 2);
    assert.equal(scans, 1);
    assert.equal(releasedClients, 1);
    assert.equal(worker.state, 'running');
    assert.equal(worker.hasLock, true);
  } finally {
    await worker.stop();
  }
});


test('worker applies exponential backoff after a scan failure', async () => {
  let scans = 0;
  let releasedClients = 0;

  const worker = createDepositScannerWorker({
    scanner: {
      metrics: {},
      async scan() {
        scans += 1;
        if (scans === 1) {
          const error = new Error('temporary RPC failure');
          error.code = 'RPC_ERROR';
          throw error;
        }
        return { signatures: 0, recorded: 0, duplicates: 0, failed: 0 };
      }
    },
    cursors: {
      async acquireScannerLock() {
        return { async release() {} };
      }
    },
    pool: {
      async connect() {
        return {
          release() {
            releasedClients += 1;
          }
        };
      }
    },
    network: 'devnet',
    scope: 'all',
    intervalMs: 1_000,
    minBackoffMs: 1_000,
    maxBackoffMs: 4_000
  });

  try {
    await worker.start();
    await new Promise((resolve) => setTimeout(resolve, 1_250));

    assert.equal(scans, 1, 'the failed scan must not retry on the normal interval');
    assert.equal(worker.stats.consecutiveFailures, 1);

    await new Promise((resolve) => setTimeout(resolve, 1_000));

    assert.equal(scans, 2, 'the retry should run after the doubled backoff');
    assert.equal(worker.stats.consecutiveFailures, 0);
    assert.equal(worker.stats.successes, 1);
    assert.equal(releasedClients, 0, 'the advisory-lock connection remains held while running');
  } finally {
    await worker.stop();
  }
});
