/**
 * Liveness, readiness and coarse operational diagnostics.
 *
 * Public responses intentionally omit connection strings, hostnames, RPC URLs,
 * tenant IDs, wallet addresses, credentials and raw error messages.
 */
async function timedProbe(operation, timeoutMs, now) {
  const started = now();
  let timer;
  try {
    const value = await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error('probe_timeout');
          error.code = 'PROBE_TIMEOUT';
          reject(error);
        }, timeoutMs);
        timer.unref?.();
      })
    ]);
    return { ok: true, value, latencyMs: Math.max(0, now() - started) };
  } catch (error) {
    return {
      ok: false,
      code: error.code === 'PROBE_TIMEOUT' ? 'timeout' : 'unavailable',
      latencyMs: Math.max(0, now() - started)
    };
  } finally {
    clearTimeout(timer);
  }
}

function poolSnapshot(pool) {
  if (!pool) return null;
  return {
    total: Number(pool.totalCount ?? 0),
    idle: Number(pool.idleCount ?? 0),
    waiting: Number(pool.waitingCount ?? 0),
    max: Number(pool.options?.max ?? pool.max ?? 0)
  };
}

function workerSnapshot(worker) {
  if (!worker || typeof worker.health !== 'function') {
    return { state: 'not_started', stale: true, hasLock: false };
  }
  const health = worker.health();
  return {
    state: health.state ?? 'unknown',
    stale: health.stale === true,
    hasLock: health.hasLock === true,
    runs: Number(health.runs ?? health.stats?.runs ?? 0),
    successes: Number(health.successes ?? health.stats?.successes ?? 0),
    failures: Number(health.failures ?? health.stats?.failures ?? 0),
    consecutiveFailures: Number(health.consecutiveFailures ?? health.stats?.consecutiveFailures ?? 0),
    lastSuccessAt: health.lastSuccessAt ?? health.stats?.lastSuccessAt ?? null,
    lastErrorAt: health.lastErrorAt ?? health.stats?.lastErrorAt ?? null
  };
}

export function createHealthService({
  pool,
  additionalPools = {},
  metrics = null,
  rpc = null,
  rpcRequired = false,
  scanner = null,
  workerEnabled = false,
  reconciliationWorker = null,
  reconciliationEnabled = false,
  withdrawalReconciliationWorker = null,
  withdrawalReconciliationEnabled = false,
  webhookWorker = null,
  webhookDeliveryEnabled = false,
  sweeperWorker = null,
  sweeperEnabled = false,
  network,
  scope,
  queueDepth = null,
  backlogStats = null,
  probeTimeoutMs = 2_500,
  maxPoolWaiting = 2,
  now = () => Date.now()
}) {
  const startedAt = now();

  return Object.freeze({
    live() {
      return {
        status: 'ok',
        service: 'blackchin-wallet-engine',
        uptimeSeconds: Math.floor((now() - startedAt) / 1000)
      };
    },

    async ready() {
      const checks = {
        database: 'unknown',
        rpc: rpc ? 'unknown' : 'disabled',
        scanner: workerEnabled ? 'unknown' : 'disabled',
        reconciliation: reconciliationEnabled ? 'unknown' : 'disabled',
        withdrawalReconciliation: withdrawalReconciliationEnabled ? 'unknown' : 'disabled',
        webhookDelivery: webhookDeliveryEnabled ? 'unknown' : 'disabled',
        sweeper: sweeperEnabled ? 'unknown' : 'disabled'
      };
      const degraded = [];
      let ready = true;
      let databaseLatencyMs = null;
      let rpcLatencyMs = null;

      const database = await timedProbe(
        () => pool.query('SELECT 1 AS ok'),
        probeTimeoutMs,
        now
      );
      databaseLatencyMs = database.latencyMs;
      checks.database = database.ok && database.value.rows[0]?.ok === 1 ? 'ok' : 'error';
      if (checks.database !== 'ok') ready = false;
      if (databaseLatencyMs > 1_000) degraded.push('database_latency');

      if (rpc) {
        const probe = await timedProbe(() => rpc.getSlot('processed'), probeTimeoutMs, now);
        rpcLatencyMs = probe.latencyMs;
        checks.rpc = probe.ok && Number.isSafeInteger(probe.value) ? 'ok' : probe.code ?? 'error';
        if (rpcRequired && checks.rpc !== 'ok') ready = false;
        if (checks.rpc !== 'ok') degraded.push('rpc_unavailable');
        if (metrics) {
          metrics.setGauge('blackchin_rpc_up', checks.rpc === 'ok' ? 1 : 0, { network: network ?? 'unknown' });
          metrics.setGauge('blackchin_rpc_probe_latency_ms', rpcLatencyMs, { network: network ?? 'unknown' });
        }
        if (rpcLatencyMs > 1_500) degraded.push('rpc_latency');
      } else if (rpcRequired) {
        checks.rpc = 'not_configured';
        ready = false;
      }

      const poolStats = poolSnapshot(pool);
      const pools = { primary: poolStats };
      if (metrics && poolStats) {
        metrics.setGauge('blackchin_database_pool_connections', poolStats.total, { pool: 'primary', state: 'total' });
        metrics.setGauge('blackchin_database_pool_connections', poolStats.idle, { pool: 'primary', state: 'idle' });
        metrics.setGauge('blackchin_database_pool_waiting', poolStats.waiting, { pool: 'primary' });
      }
      if (poolStats?.waiting >= maxPoolWaiting && maxPoolWaiting > 0) {
        degraded.push('database_pool_saturation');
      }
      for (const [name, additionalPool] of Object.entries(additionalPools ?? {})) {
        if (!additionalPool) continue;
        const probe = await timedProbe(
          () => additionalPool.query('SELECT 1 AS ok'),
          probeTimeoutMs,
          now
        );
        pools[name] = poolSnapshot(additionalPool);
        if (metrics && pools[name]) {
          metrics.setGauge('blackchin_database_pool_connections', pools[name].total, { pool: name, state: 'total' });
          metrics.setGauge('blackchin_database_pool_connections', pools[name].idle, { pool: name, state: 'idle' });
          metrics.setGauge('blackchin_database_pool_waiting', pools[name].waiting, { pool: name });
        }
        const checkName = `${name}Database`;
        checks[checkName] = probe.ok && probe.value.rows[0]?.ok === 1 ? 'ok' : 'error';
        if (checks[checkName] !== 'ok') ready = false;
        if (pools[name]?.waiting >= maxPoolWaiting && maxPoolWaiting > 0) {
          degraded.push(`${name}_pool_saturation`);
        }
      }

      const workerChecks = [
        ['scanner', workerEnabled, scanner],
        ['reconciliation', reconciliationEnabled, reconciliationWorker],
        ['withdrawalReconciliation', withdrawalReconciliationEnabled, withdrawalReconciliationWorker],
        ['webhookDelivery', webhookDeliveryEnabled, webhookWorker],
        ['sweeper', sweeperEnabled, sweeperWorker]
      ];
      const workers = {};
      for (const [name, enabled, worker] of workerChecks) {
        if (!enabled) {
          workers[name] = { state: 'disabled', stale: false, hasLock: false };
          continue;
        }
        const snapshot = workerSnapshot(worker);
        workers[name] = snapshot;
        checks[name] = snapshot.state;
        if (metrics) {
          metrics.setGauge('blackchin_worker_up', snapshot.state === 'running' && !snapshot.stale ? 1 : 0, { worker: name });
          metrics.setGauge('blackchin_worker_consecutive_failures', snapshot.consecutiveFailures, { worker: name });
        }
        if (name !== 'webhookDelivery' &&
            (snapshot.state !== 'running' || snapshot.stale || !snapshot.hasLock)) {
          ready = false;
        }
        if (snapshot.consecutiveFailures >= 3 || snapshot.stale) {
          degraded.push(`${name}_degraded`);
        }
      }

      let outboxDue = null;
      let backlogs = null;
      if (typeof queueDepth === 'function') {
        try {
          outboxDue = await queueDepth();
        } catch {
          checks.outbox = 'unavailable';
          degraded.push('outbox_metrics_unavailable');
        }
      }
      if (typeof backlogStats === 'function') {
        try {
          backlogs = await backlogStats();
          if (metrics) {
            for (const [name, value] of Object.entries(backlogs)) {
              if (Number.isFinite(value)) metrics.setGauge(`blackchin_backlog_${name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}`, value);
            }
          }
          if (backlogs.signedWithdrawalsPending > 0) degraded.push('signed_withdrawals_pending');
          if (backlogs.ledgerUnderReview > 0 ||
              backlogs.depositReconciliationUnderReview > 0 ||
              backlogs.withdrawalReconciliationUnderReview > 0) {
            degraded.push('transactions_under_review');
          }
          if (backlogs.webhookPending > 1_000 || backlogs.oldestWebhookAgeSeconds > 300) {
            degraded.push('webhook_backlog');
          }
          if (backlogs.oldestSignedWithdrawalAgeSeconds > 300) {
            degraded.push('signed_withdrawal_age');
          }
        } catch {
          checks.backlogs = 'unavailable';
          degraded.push('backlog_metrics_unavailable');
        }
      }

      return {
        statusCode: ready ? 200 : 503,
        body: {
          ready,
          degraded: [...new Set(degraded)],
          network,
          scope,
          checks,
          latencyMs: { database: databaseLatencyMs, rpc: rpcLatencyMs },
          pool: poolStats,
          pools,
          workers,
          outboxDue,
          backlogs,
          uptimeSeconds: Math.floor((now() - startedAt) / 1000)
        }
      };
    }
  });
}
