import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectToPostgres, disconnectPostgres, pool } =
  await import('../PostgreSQL/walletStorage.js');

const tenantDatabaseUrl = process.env.TENANT_DATABASE_URL || null;
let tenantPool = null;
if (tenantDatabaseUrl) {
  let tenantUrl;
  try {
    tenantUrl = new URL(tenantDatabaseUrl);
  } catch (error) {
    throw new Error('TENANT_DATABASE_URL is not a valid URL', { cause: error });
  }
  if (!['postgres:', 'postgresql:'].includes(tenantUrl.protocol) ||
      !tenantUrl.hostname || !tenantUrl.username || !tenantUrl.pathname || tenantUrl.pathname === '/') {
    throw new Error('TENANT_DATABASE_URL must include a PostgreSQL host, username and database name');
  }
  const tenantHost = tenantUrl.hostname.replace(/^\\[|\\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(tenantHost) &&
      tenantUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Remote TENANT_DATABASE_URL must explicitly use sslmode=verify-full');
  }
  const pgModule = await import('pg');
  tenantPool = new pgModule.default.Pool({
    connectionString: tenantDatabaseUrl,
    max: 10,
    min: 0,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    application_name: 'blackchin-tenant-api'
  });
  tenantPool.on('error', (error) => {
    console.error('[TENANT POSTGRESQL POOL ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });
  });
}

const host = process.env.API_HOST || '127.0.0.1';
const port = Number(process.env.API_PORT || 3000);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be a valid TCP port');
}

const scannerEnabled = process.env.DEPOSIT_SCANNER_ENABLED === 'true';
const scannerNetwork = process.env.SOLANA_NETWORK || 'devnet';
const scannerScope = process.env.DEPOSIT_SCANNER_SCOPE || 'all';
const scannerIntervalMs = Number(process.env.DEPOSIT_SCANNER_INTERVAL_MS || 15_000);
const reconciliationEnabled = process.env.DEPOSIT_RECONCILIATION_ENABLED === 'true';
const reconciliationIntervalMs = Number(process.env.DEPOSIT_RECONCILIATION_INTERVAL_MS || 60_000);
const withdrawalReconciliationEnabled = process.env.WITHDRAWAL_RECONCILIATION_ENABLED === 'true';
const withdrawalReconciliationIntervalMs = Number(process.env.WITHDRAWAL_RECONCILIATION_INTERVAL_MS || 60_000);
const webhookDeliveryEnabled = process.env.WEBHOOK_DELIVERY_ENABLED === 'true';
const webhookDeliveryIntervalMs = Number(process.env.WEBHOOK_DELIVERY_INTERVAL_MS || 5_000);
const legacyWebhookEndpoint = process.env.WEBHOOK_ENDPOINT || null;
const legacyWebhookSecret = process.env.WEBHOOK_SECRET || null;
const depositWorkersEnabled = scannerEnabled || reconciliationEnabled;
const depositWorkerDatabaseUrl = process.env.DEPOSIT_WORKER_DATABASE_URL || null;
let depositWorkerPool = null;

if (depositWorkersEnabled) {
  if (!depositWorkerDatabaseUrl) {
    throw new Error('DEPOSIT_WORKER_DATABASE_URL is required when the deposit scanner or deposit reconciliation worker is enabled');
  }
  let workerUrl;
  try {
    workerUrl = new URL(depositWorkerDatabaseUrl);
  } catch (error) {
    throw new Error('DEPOSIT_WORKER_DATABASE_URL is not a valid URL', { cause: error });
  }
  if (!['postgres:', 'postgresql:'].includes(workerUrl.protocol) ||
      !workerUrl.hostname || !workerUrl.username || !workerUrl.pathname || workerUrl.pathname === '/') {
    throw new Error('DEPOSIT_WORKER_DATABASE_URL must include a PostgreSQL host, username and database name');
  }
  const workerHost = workerUrl.hostname.replace(/^\[|\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(workerHost) &&
      workerUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Remote DEPOSIT_WORKER_DATABASE_URL must explicitly use sslmode=verify-full');
  }
  const pgModule = await import('pg');
  depositWorkerPool = new pgModule.default.Pool({
    connectionString: depositWorkerDatabaseUrl,
    max: 8,
    min: 0,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: 'blackchin-deposit-worker'
  });
  depositWorkerPool.on('error', (error) => {
    console.error('[DEPOSIT WORKER POSTGRESQL POOL ERROR]', {
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });
  });
}

if (!Number.isSafeInteger(scannerIntervalMs) || scannerIntervalMs < 1_000) {
  throw new Error('DEPOSIT_SCANNER_INTERVAL_MS must be an integer >= 1000');
}
if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs < 5_000) {
  throw new Error('DEPOSIT_RECONCILIATION_INTERVAL_MS must be an integer >= 5000');
}
if (!Number.isSafeInteger(withdrawalReconciliationIntervalMs) || withdrawalReconciliationIntervalMs < 5_000) {
  throw new Error('WITHDRAWAL_RECONCILIATION_INTERVAL_MS must be an integer >= 5000');
}
if (!Number.isSafeInteger(webhookDeliveryIntervalMs) || webhookDeliveryIntervalMs < 1_000) {
  throw new Error('WEBHOOK_DELIVERY_INTERVAL_MS must be an integer >= 1000');
}
if (webhookDeliveryEnabled && !legacyWebhookEndpoint && !legacyWebhookSecret) {
  // Tenant endpoints are resolved per event. A legacy platform endpoint is
  // optional; without either, events are discarded with an explicit reason.
  console.warn('Webhook delivery is enabled without a legacy WEBHOOK_ENDPOINT; only tenant-configured endpoints will receive events.');
}

let server;
let worker;
let reconciliationWorker;
let withdrawalReconciliationWorker;
let webhookWorker;
const webhookWorkerRef = { current: null };
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}; shutting down wallet API...`);

  try {
    // Stop background work first so no scan writes after the pool starts
    // draining, then close HTTP, then the pool.
    if (webhookWorker) await webhookWorker.stop();
    if (withdrawalReconciliationWorker) await withdrawalReconciliationWorker.stop();
    if (reconciliationWorker) await reconciliationWorker.stop();
    if (worker) await worker.stop();
    if (server) await server.close();
    if (tenantPool) await tenantPool.end();
    if (depositWorkerPool) await depositWorkerPool.end();
    await disconnectPostgres();
    process.exitCode = 0;
  } catch (error) {
    console.error('[SHUTDOWN ERROR]', error.message);
    process.exitCode = 1;
  }
}

try {
  await connectToPostgres();

  let tenantContextSigner = null;
  if (tenantPool) {
    const tenantContextKey = process.env.TENANT_CONTEXT_HMAC_KEY;
    if (!tenantContextKey) {
      throw new Error('TENANT_CONTEXT_HMAC_KEY is required when TENANT_DATABASE_URL is configured');
    }
    const {
      createTenantContextSigner,
      provisionTenantContextSecret,
      assertTenantRuntimeRole
    } = await import('./infrastructure/security/tenant-context.js');
    await provisionTenantContextSecret(pool, tenantContextKey);
    await assertTenantRuntimeRole(tenantPool);
    tenantContextSigner = createTenantContextSigner(tenantContextKey);
  }

  if (depositWorkerPool) {
    const { assertDepositWorkerRuntimeRole } =
      await import('./infrastructure/security/deposit-worker-role.js');
    const workerIdentity = await assertDepositWorkerRuntimeRole(depositWorkerPool);
    console.log('[DEPOSIT WORKER DATABASE READY]', workerIdentity);
  }

  // Fail fast if the schema migrations have not been applied.
  await pool.query('SELECT idempotency_key FROM api_idempotency_keys LIMIT 0');
  await pool.query('SELECT next_account_index FROM hd_wallets LIMIT 0');
  await pool.query('SELECT account_index FROM wallet_accounts LIMIT 0');
  await pool.query('SELECT direction FROM blockchain_transactions LIMIT 0');
  await pool.query('SELECT last_signature FROM deposit_scanner_cursors LIMIT 0');
  await pool.query('SELECT event_id FROM webhook_outbox LIMIT 0');
  await pool.query('SELECT bucket_key FROM rate_limit_counters LIMIT 0');
  await pool.query('SELECT last_transaction_id FROM deposit_reconciliation_cursors LIMIT 0');
  await pool.query('SELECT checked_at FROM deposit_reconciliation_events LIMIT 0');
  await pool.query('SELECT last_id FROM withdrawal_reconciliation_cursors LIMIT 0');
  await pool.query('SELECT tenant_credential_id, approval_reference FROM api_idempotency_keys LIMIT 0');
  await pool.query('SELECT enabled, emergency_frozen, policy_version FROM tenant_withdrawal_policies LIMIT 0');
  await pool.query('SELECT approval_reference, issuer_event_id, status FROM tenant_withdrawal_approvals LIMIT 0');
  await pool.query('SELECT decision, reason_code FROM tenant_withdrawal_policy_events LIMIT 0');
  await pool.query('SELECT password_hash, role FROM dashboard_users LIMIT 0');
  await pool.query('SELECT token_hash, csrf_token_hash FROM dashboard_sessions LIMIT 0');
  await pool.query('SELECT event_type, payload FROM operational_events LIMIT 0');
  await pool.query('SELECT endpoint_url, secret_encrypted FROM tenant_webhook_endpoints LIMIT 0');
  await pool.query('SELECT public_key, signing_enabled FROM hot_wallets LIMIT 0');

  // Imported after dotenv so the API key and encryption key are configured.
  const { buildServer } = await import('./api/server.js');
  const { createServices, createTenantRequestServices } = await import('./core/services.js');
  const { createDepositScannerWorker } = await import('./workers/deposit-scanner.worker.js');
  const { acquireReconciliationLock } = await import('./infrastructure/database/deposit-reconciliation.repository.js');
  const { acquireWithdrawalReconciliationLock } = await import('./infrastructure/database/withdrawal-reconciliation.repository.js');
  const { createHealthService } = await import('./core/health.service.js');
  const { createMetricsService } = await import('./core/metrics.service.js');
  const { getOperationalBacklog } = await import('./infrastructure/database/observability.repository.js');
  const { recordOperationalEventSafe } = await import('./infrastructure/database/operational-event.repository.js');
  const metrics = createMetricsService();

  // Creating services validates ENCRYPTION_KEY and fails closed before the
  // port is opened.
  const services = createServices({ pool, webhookWorkerRef });
  const depositWorkerServices = depositWorkerPool
    ? createServices({ db: depositWorkerPool, pool: depositWorkerPool })
    : null;

  const workerAlertCooldown = new Map();
  const workerLogger = (component) => (message, meta = {}) => {
    console.log(JSON.stringify({
      time: new Date().toISOString(),
      component,
      message,
      ...meta
    }));
    const critical = message === 'scanner.lock_lost' ||
      message === 'scanner.lock_error' ||
      (message === 'scanner.run_failed' && Number(meta.consecutiveFailures ?? 0) >= 3);
    if (message === 'scanner.run_failed') {
      metrics.increment('blackchin_worker_failures_total', 1, { worker: component });
    }
    metrics.setGauge('blackchin_worker_consecutive_failures', Number(meta.consecutiveFailures ?? 0), {
      worker: component
    });
    if (!critical) return;
    const last = workerAlertCooldown.get(component) ?? 0;
    if (Date.now() - last < 60_000) return;
    workerAlertCooldown.set(component, Date.now());
    void recordOperationalEventSafe(pool, {
      eventType: 'system.health_changed',
      network: scannerNetwork,
      payload: {
        component,
        event: message,
        code: meta.code ?? null,
        consecutiveFailures: Number(meta.consecutiveFailures ?? 0)
      }
    }).catch(() => {});
  };

  if (webhookDeliveryEnabled) {
    const { createWebhookDeliveryWorker } = await import('./workers/webhook-delivery.worker.js');
    const outbox = await import('./infrastructure/database/webhook-outbox.repository.js');
    const { recordOperationalEventSafe } = await import('./infrastructure/database/operational-event.repository.js');
    const log = (message, meta) => console.log(JSON.stringify({
      time: new Date().toISOString(),
      message,
      ...meta
    }));

    const worker = createWebhookDeliveryWorker({
      db: pool,
      outbox,
      resolveDestination: async (event) => {
        if (event.tenantId) {
          const tenantDestination = await services.webhookEndpoints.resolveForDelivery({
            tenantId: event.tenantId,
            eventType: event.eventType
          });
          if (tenantDestination) return tenantDestination;
        }
        if (legacyWebhookEndpoint && legacyWebhookSecret) {
          return { endpointUrl: legacyWebhookEndpoint, secret: legacyWebhookSecret };
        }
        return null;
      },
      onDelivered: (event, meta) => recordOperationalEventSafe(pool, {
        eventType: 'webhook.delivered',
        tenantId: event.tenantId,
        network: event.network,
        walletPublicKey: event.walletPublicKey,
        hdWalletId: event.hdWalletId,
        payload: {
          webhookEventId: event.eventId,
          webhookEventType: event.eventType,
          httpStatus: meta.httpStatus
        }
      }, log),
      onFailed: (event, meta) => recordOperationalEventSafe(pool, {
        eventType: 'webhook.failed',
        tenantId: event.tenantId,
        network: event.network,
        walletPublicKey: event.walletPublicKey,
        hdWalletId: event.hdWalletId,
        payload: {
          webhookEventId: event.eventId,
          webhookEventType: event.eventType,
          reason: meta.reason ?? meta.error ?? null
        }
      }, log),
      log
    });

    let running = false;
    let stopped = false;
    let inFlight = null;
    const timer = setInterval(() => {
      if (running || shuttingDown || stopped) return;
      running = true;
      inFlight = worker.runOnce()
        .catch((error) => {
          log('webhook.worker_error', { code: error.code ?? 'UNKNOWN' });
        })
        .finally(() => {
          running = false;
          inFlight = null;
        });
    }, webhookDeliveryIntervalMs);
    timer.unref?.();

    webhookWorker = {
      metrics: worker.metrics,
      runOnce: worker.runOnce,
      health() {
        const lastRun = worker.metrics.lastRunAt ? new Date(worker.metrics.lastRunAt).getTime() : null;
        return {
          state: stopped ? 'stopped' : 'running',
          stale: lastRun === null ? false : Date.now() - lastRun > webhookDeliveryIntervalMs * 4,
          hasLock: true,
          runs: worker.metrics.runs,
          failures: worker.metrics.lastError ? 1 : 0,
          lastSuccessAt: worker.metrics.lastRunAt
        };
      },
      async stop() {
        clearInterval(timer);
        if (inFlight) await inFlight;
        stopped = true;
      }
    };
    webhookWorkerRef.current = webhookWorker;
  }

  if (scannerEnabled) {
    worker = createDepositScannerWorker({
      scanner: depositWorkerServices.depositScanner,
      cursors: depositWorkerServices.deps.cursors,
      pool: depositWorkerPool,
      network: scannerNetwork,
      scope: scannerScope,
      intervalMs: scannerIntervalMs,
      log: workerLogger('deposit_scanner')
    });
  }

  if (reconciliationEnabled) {
    reconciliationWorker = createDepositScannerWorker({
      scanner: depositWorkerServices.depositReconciliation,
      cursors: {
        acquireScannerLock: (client, { network }) => acquireReconciliationLock(client, network)
      },
      pool: depositWorkerPool,
      network: scannerNetwork,
      scope: 'deposit-reconciliation',
      intervalMs: reconciliationIntervalMs,
      log: workerLogger('deposit_reconciliation')
    });
  }

  if (withdrawalReconciliationEnabled) {
    withdrawalReconciliationWorker = createDepositScannerWorker({
      scanner: services.withdrawalReconciliation,
      cursors: {
        acquireScannerLock: (client, { network }) => acquireWithdrawalReconciliationLock(client, network)
      },
      pool,
      network: scannerNetwork,
      scope: 'withdrawal-reconciliation',
      intervalMs: withdrawalReconciliationIntervalMs,
      log: workerLogger('withdrawal_reconciliation')
    });
  }

  const health = createHealthService({
    pool,
    rpc: services.deps.rpc,
    rpcRequired: process.env.HEALTH_RPC_REQUIRED !== 'false',
    scanner: worker,
    workerEnabled: scannerEnabled,
    reconciliationWorker,
    reconciliationEnabled,
    withdrawalReconciliationWorker,
    withdrawalReconciliationEnabled,
    webhookWorker,
    webhookDeliveryEnabled,
    network: scannerNetwork,
    scope: scannerScope,
    queueDepth: async () => {
      const { countPending } = await import('./infrastructure/database/webhook-outbox.repository.js');
      return countPending(pool);
    },
    backlogStats: () => getOperationalBacklog(pool)
  });

  server = buildServer({
    services,
    health,
    metrics,
    tenantPool,
    tenantContextSigner,
    createTenantServices: (tenantDb) => createTenantRequestServices(services, tenantDb)
  });
  await server.listen({ host, port });

  if (worker) {
    await worker.start();
    console.log(`Deposit scanner started (network=${scannerNetwork}, scope=${scannerScope})`);
  } else {
    console.log('Deposit scanner disabled (DEPOSIT_SCANNER_ENABLED is not "true")');
  }
  if (withdrawalReconciliationWorker) {
    await withdrawalReconciliationWorker.start();
    console.log(`Withdrawal reconciliation started (network=${scannerNetwork})`);
  } else {
    console.log('Withdrawal reconciliation disabled (WITHDRAWAL_RECONCILIATION_ENABLED is not "true")');
  }
  if (reconciliationWorker) {
    await reconciliationWorker.start();
    console.log(`Deposit reconciliation started (network=${scannerNetwork})`);
  } else {
    console.log('Deposit reconciliation disabled (DEPOSIT_RECONCILIATION_ENABLED is not "true")');
  }
  if (webhookWorker) {
    console.log(`Webhook delivery worker started (interval=${webhookDeliveryIntervalMs}ms)`);
  } else {
    console.log('Webhook delivery disabled (WEBHOOK_DELIVERY_ENABLED is not "true")');
  }

  console.log(`Wallet API listening on http://${host}:${port}`);
} catch (error) {
  console.error('[API STARTUP FAILED]', error.message);
  if (tenantPool) await tenantPool.end().catch(() => { });
  if (depositWorkerPool) await depositWorkerPool.end().catch(() => { });
  await disconnectPostgres().catch(() => { });
  process.exitCode = 1;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
