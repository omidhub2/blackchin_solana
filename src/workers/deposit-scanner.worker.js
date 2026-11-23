/**
 * Deposit scanner worker lifecycle.
 *
 * - One scanner per (network, scope) across the whole cluster, enforced with a
 *   PostgreSQL session advisory lock (`pg_try_advisory_lock`) held on a
 *   dedicated connection for the life of the run.
 * - Fixed interval polling with exponential backoff after errors.
 * - Graceful shutdown: stops scheduling, waits for the in-flight run, releases
 *   the advisory lock and the dedicated connection.
 * - Structured logs contain no keys, mnemonics or tokens.
 */

export const WORKER_STATES = Object.freeze(['idle', 'running', 'stopping', 'stopped', 'failed']);

/**
 * @param {object} options
 * @param {{ scan: (plan: {network: string, scope: string}) => Promise<object>, metrics: object }} options.scanner
 * @param {{ acquireScannerLock: Function }} options.cursors
 * @param {object} options.pool              PostgreSQL pool (for the lock connection)
 * @param {string} options.network
 * @param {string} options.scope
 * @param {number} [options.intervalMs]
 * @param {number} [options.minBackoffMs]
 * @param {number} [options.maxBackoffMs]
 * @param {(message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createDepositScannerWorker({
  scanner,
  cursors,
  pool,
  network,
  scope,
  intervalMs = 15_000,
  minBackoffMs = 5_000,
  maxBackoffMs = 120_000,
  log = () => { },
  now = () => Date.now()
}) {
  if (!scanner || typeof scanner.scan !== 'function') {
    throw new TypeError('A scanner implementation is required');
  }

  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1_000) {
    throw new TypeError('intervalMs must be at least 1000');
  }

  let state = 'idle';
  let timer = null;
  let inFlight = null;
  let backoffMs = minBackoffMs;
  let lockClient = null;
  let lock = null;
  let lockLost = false;
  let consecutiveFailures = 0;

  const stats = {
    startedAt: null,
    stoppedAt: null,
    runs: 0,
    successes: 0,
    failures: 0,
    lastRunAt: null,
    lastSuccessAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    consecutiveFailures: 0
  };

  function invalidateLock(error) {
    if (lockLost) return;
    lockLost = true;
    lock = null;
    const lostClient = lockClient;
    lockClient = null;
    // Destroy the connection so it cannot be reused by the pool after its
    // advisory-lock session has become uncertain.
    if (lostClient) lostClient.release(true);
    log('scanner.lock_lost', { network, scope, message: error?.message ?? 'lock connection ended' });
  }

  async function assertOwnership() {
    if (lockLost || !lock || !lockClient) {
      const error = new Error('Worker no longer owns its PostgreSQL advisory lock');
      error.code = 'WORKER_LOCK_LOST';
      throw error;
    }
    try {
      await lockClient.query('SELECT 1');
    } catch (cause) {
      invalidateLock(cause);
      const error = new Error('Worker advisory-lock connection is no longer usable');
      error.code = 'WORKER_LOCK_LOST';
      error.cause = cause;
      throw error;
    }
    if (lockLost) {
      const error = new Error('Worker advisory lock was lost');
      error.code = 'WORKER_LOCK_LOST';
      throw error;
    }
  }

  function nextDelayMs() {
    return consecutiveFailures > 0 ? backoffMs : intervalMs;
  }

  function schedule(delayMs) {
    if (state === 'stopping' || state === 'stopped') return;

    timer = setTimeout(() => {
      timer = null;

      if (state === 'stopping' || state === 'stopped') return;

      inFlight = runOnce()
        .catch(() => { })
        .finally(() => {
          inFlight = null;
          schedule(nextDelayMs());
        });
    }, delayMs);

    timer.unref?.();
  }

  async function runOnce() {
    if (state !== 'running') return { skipped: 'not_running' };

    if (!lock) {
      lockLost = false;
      // (Re)acquire ownership. Without it this instance must not scan, so two
      // replicas can never double-process the same cursor.
      let candidate;
      try {
        candidate = await pool.connect();
        lock = await cursors.acquireScannerLock(candidate, { network, scope });
      } catch (error) {
        if (candidate) candidate.release(true);
        lock = null;
        stats.failures += 1;
        stats.lastErrorAt = new Date(now()).toISOString();
        stats.lastErrorMessage = error.message;
        consecutiveFailures += 1;
        stats.consecutiveFailures = consecutiveFailures;
        backoffMs = Math.min(maxBackoffMs, Math.max(minBackoffMs, backoffMs * 2));
        log('scanner.lock_error', {
          network, scope, code: error.code ?? 'UNKNOWN',
          message: error.message, backoffMs
        });
        return { error: error.code ?? 'LOCK_ERROR' };
      }

      if (!lock) {
        candidate.release();
        log('scanner.lock_not_acquired', { network, scope });

        // Another replica owns this scanner. This is contention, not a failed
        // scan; retry on the normal cadence without marking health degraded.
        return { skipped: 'lock_not_acquired' };
      }

      lockClient = candidate;
      candidate.on?.('error', invalidateLock);
      candidate.on?.('end', () => invalidateLock(new Error('PostgreSQL lock connection ended')));
      log('scanner.lock_acquired', { network, scope });
    }

    stats.runs += 1;
    stats.lastRunAt = new Date(now()).toISOString();

    try {
      await assertOwnership();
      const summary = await scanner.scan({ network, scope, assertOwnership });
      if (summary?.stopped === 'transaction_unavailable') {
        const error = new Error('Solana RPC has not made a scanned transaction available yet');
        error.code = 'TRANSACTION_UNAVAILABLE';
        throw error;
      }

      stats.successes += 1;
      stats.lastSuccessAt = stats.lastRunAt;
      consecutiveFailures = 0;
      stats.consecutiveFailures = 0;
      stats.lastErrorMessage = null;
      backoffMs = minBackoffMs;

      log('scanner.run_completed', {
        network,
        scope,
        signatures: summary.signatures,
        recorded: summary.recorded,
        duplicates: summary.duplicates,
        failed: summary.failed
      });

      return summary;
    } catch (error) {
      stats.failures += 1;
      stats.lastErrorAt = new Date(now()).toISOString();
      stats.lastErrorMessage = error.message;
      consecutiveFailures += 1;
      stats.consecutiveFailures = consecutiveFailures;

      backoffMs = Math.min(maxBackoffMs, backoffMs * 2);

      log('scanner.run_failed', {
        network,
        scope,
        code: error.code ?? 'UNKNOWN',
        message: error.message,
        backoffMs
      });

      return { error: error.code ?? 'UNKNOWN' };
    }
  }

  return Object.freeze({
    get state() {
      return state;
    },

    get isRunning() {
      return state === 'running';
    },

    get hasLock() {
      return lock !== null;
    },

    stats,

    /**
     * Start polling. Idempotent: repeated calls while running are ignored.
     */
    async start() {
      if (state === 'running') return { started: false };

      state = 'running';
      stats.startedAt = new Date(now()).toISOString();
      log('scanner.started', { network, scope, intervalMs });

      // First run immediately, then on the normal cadence.
      inFlight = runOnce()
        .catch(() => { })
        .finally(() => {
          inFlight = null;
          schedule(nextDelayMs());
        });

      return { started: true };
    },

    /**
     * Stop gracefully: no new runs, wait for the in-flight one, release locks.
     */
    async stop() {
      if (state === 'stopped') return { stopped: true };

      state = 'stopping';

      if (timer) {
        clearTimeout(timer);
        timer = null;
      }

      if (inFlight) {
        await inFlight.catch(() => { });
      }

      if (lock) {
        await lock.release().catch(() => { });
        lock = null;
      }

      if (lockClient) {
        lockClient.release();
        lockClient = null;
      }

      state = 'stopped';
      stats.stoppedAt = new Date(now()).toISOString();
      log('scanner.stopped', { network, scope });

      return { stopped: true };
    },

    /**
     * Execute a single scan run (used by tests and manual operations).
     * Does not touch the scheduler or the advisory lock.
     */
    async runOnce() {
      if (inFlight) return inFlight;
      const previous = state;
      if (state === 'stopping' || state === 'stopped') {
        return { skipped: 'not_running' };
      }
      state = 'running';
      inFlight = runOnce()
        .finally(async () => {
          inFlight = null;
          if (previous === 'idle' && state === 'running') {
            if (lock) {
              await lock.release().catch(() => {});
              lock = null;
            }
            if (lockClient) {
              lockClient.release();
              lockClient = null;
            }
            state = 'idle';
          }
        });
      return inFlight;
    },

    /**
     * Health snapshot for /health/ready.
     */
    health() {
      const stale = stats.lastSuccessAt === null
        ? true
        : now() - new Date(stats.lastSuccessAt).getTime() > intervalMs * 4 + maxBackoffMs;

      return {
        network,
        scope,
        state,
        hasLock: lock !== null,
        stale,
        ...stats,
        metrics: scanner.metrics ?? null
      };
    }
  });
}
