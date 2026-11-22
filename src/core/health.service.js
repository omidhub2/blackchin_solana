/**
 * Readiness and liveness reporting.
 *
 * `GET /health` stays public and minimal (liveness). `GET /health/ready` is
 * unauthenticated too, but only reports coarse status — never URLs,
 * credentials, keys or internal hostnames.
 */

export function createHealthService({
  pool,
  scanner = null,
  workerEnabled = false,
  network,
  scope,
  queueDepth = null,
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

    /**
     * Ready = database reachable AND (scanner disabled OR scanner healthy).
     * Returns 200 when ready, 503 otherwise.
     */
    async ready() {
      const checks = { database: 'unknown', scanner: workerEnabled ? 'unknown' : 'disabled' };
      let ready = true;

      try {
        const result = await pool.query('SELECT 1 AS ok');
        checks.database = result.rows[0]?.ok === 1 ? 'ok' : 'error';
        ready = ready && checks.database === 'ok';
      } catch {
        checks.database = 'error';
        ready = false;
      }

      let outboxPending = null;

      if (typeof queueDepth === 'function') {
        try {
          outboxPending = await queueDepth();
        } catch {
          checks.outbox = 'unavailable';
        }
      }

      if (workerEnabled) {
        if (!scanner) {
          checks.scanner = 'not_started';
          ready = false;
        } else {
          const health = scanner.health();
          checks.scanner = health.state;
          checks.scannerStale = health.stale;

          if (health.state === 'stopped' || health.state === 'failed') {
            ready = false;
          }
        }
      }

      return {
        statusCode: ready ? 200 : 503,
        body: {
          ready,
          network,
          scope,
          checks,
          outboxDue: outboxPending,
          uptimeSeconds: Math.floor((now() - startedAt) / 1000)
        }
      };
    }
  });
}
