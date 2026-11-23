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
          async query(sql) {
            assert.equal(sql, 'SELECT 1');
            return { rows: [{ '?column?': 1 }] };
          },
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
          async query(sql) {
            assert.equal(sql, 'SELECT 1');
            return { rows: [{ '?column?': 1 }] };
          },
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


test('manual runOnce calls share the same single-flight scan and release the lock', async () => {
  let scans = 0;
  let releases = 0;
  let finishScan;
  const scanGate = new Promise((resolve) => { finishScan = resolve; });
  const worker = createDepositScannerWorker({
    scanner: {
      metrics: {},
      async scan() {
        scans += 1;
        await scanGate;
        return { signatures: 1, recorded: 1, duplicates: 0, failed: 0 };
      }
    },
    cursors: { async acquireScannerLock() { return { async release() { releases += 1; } }; } },
    pool: {
      async connect() {
        return {
          async query() { return { rows: [{ '?column?': 1 }] }; },
          release() {}
        };
      }
    },
    network: 'devnet', scope: 'all'
  });

  const first = worker.runOnce();
  const second = worker.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(scans, 1, 'concurrent manual calls must not start a second scan');
  finishScan();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.recorded, 1);
  assert.equal(b.recorded, 1);
  assert.equal(releases, 1);
  assert.equal(worker.state, 'idle');
  assert.equal(worker.hasLock, false);
});

test('transaction-unavailable scanner result is a worker failure and enters backoff', async () => {
  let scans = 0;
  const worker = createDepositScannerWorker({
    scanner: {
      metrics: {},
      async scan() {
        scans += 1;
        return { signatures: 1, recorded: 0, duplicates: 0, failed: 0, stopped: 'transaction_unavailable' };
      }
    },
    cursors: { async acquireScannerLock() { return { async release() {} }; } },
    pool: {
      async connect() {
        return {
          async query() { return { rows: [{ '?column?': 1 }] }; },
          release() {}
        };
      }
    },
    network: 'devnet', scope: 'all',
    minBackoffMs: 1000, maxBackoffMs: 4000
  });

  await worker.runOnce();
  assert.equal(scans, 1);
  assert.equal(worker.stats.failures, 1);
  assert.equal(worker.stats.consecutiveFailures, 1);
  assert.equal(worker.stats.lastErrorMessage, 'Solana RPC has not made a scanned transaction available yet');
  assert.equal(worker.state, 'idle');
});

test('worker connection failures are counted and do not run the scanner', async () => {
  let scans = 0;
  const worker = createDepositScannerWorker({
    scanner: { metrics: {}, async scan() { scans += 1; return {}; } },
    cursors: { async acquireScannerLock() { return { async release() {} }; } },
    pool: { async connect() { const error = new Error('database unavailable'); error.code = 'ECONNREFUSED'; throw error; } },
    network: 'devnet', scope: 'all',
    minBackoffMs: 1000, maxBackoffMs: 4000
  });

  const result = await worker.runOnce();
  assert.equal(result.error, 'ECONNREFUSED');
  assert.equal(scans, 0);
  assert.equal(worker.stats.failures, 1);
  assert.equal(worker.stats.consecutiveFailures, 1);
  assert.equal(worker.hasLock, false);
});


test('two independent worker instances cannot scan the same network scope concurrently', async () => {
  let lockHeld = false;
  let scans = 0;
  let releaseFirstScan;
  const gate = new Promise((resolve) => { releaseFirstScan = resolve; });

  const pool = {
    async connect() {
      return {
        async query() { return { rows: [{ '?column?': 1 }] }; },
        release() {}
      };
    }
  };
  const cursors = {
    async acquireScannerLock() {
      if (lockHeld) return null;
      lockHeld = true;
      return {
        async release() {
          lockHeld = false;
        }
      };
    }
  };
  const scanner = {
    metrics: {},
    async scan() {
      scans += 1;
      await gate;
      return { signatures: 1, recorded: 1, duplicates: 0, failed: 0 };
    }
  };
  const options = { scanner, cursors, pool, network: 'devnet', scope: 'all' };
  const first = createDepositScannerWorker(options);
  const second = createDepositScannerWorker(options);

  const firstRun = first.runOnce();
  await new Promise((resolve) => setImmediate(resolve));
  const secondResult = await second.runOnce();

  assert.deepEqual(secondResult, { skipped: 'lock_not_acquired' });
  assert.equal(scans, 1);
  assert.equal(first.hasLock, true);
  assert.equal(second.hasLock, false);

  releaseFirstScan();
  const result = await firstRun;
  assert.equal(result.recorded, 1);
  assert.equal(lockHeld, false);
  assert.equal(first.hasLock, false);
});

test('stop waits for an in-flight scan before releasing its advisory lock', async () => {
  let finishScan;
  let released = 0;
  const gate = new Promise((resolve) => { finishScan = resolve; });
  const worker = createDepositScannerWorker({
    scanner: {
      metrics: {},
      async scan() {
        await gate;
        return { signatures: 1, recorded: 1, duplicates: 0, failed: 0 };
      }
    },
    cursors: {
      async acquireScannerLock() {
        return { async release() { released += 1; } };
      }
    },
    pool: {
      async connect() {
        return {
          async query() { return { rows: [{ '?column?': 1 }] }; },
          release() {}
        };
      }
    },
    network: 'devnet',
    scope: 'withdrawal-reconciliation'
  });

  await worker.start();
  await new Promise((resolve) => setImmediate(resolve));
  const stopping = worker.stop();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 0, 'lock must remain held until the scan has finished');

  finishScan();
  await stopping;
  assert.equal(released, 1);
  assert.equal(worker.state, 'stopped');
  assert.equal(worker.hasLock, false);
});
