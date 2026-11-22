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
