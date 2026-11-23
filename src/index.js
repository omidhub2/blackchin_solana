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
const sweeperEnabled = process.env.SWEEPER_ENABLED === 'true';
const sweeperExecutionEnabled = process.env.SWEEPER_EXECUTION_ENABLED === 'true';
const sweeperIntervalMs = Number(process.env.SWEEPER_INTERVAL_MS || 60_000);
const sweeperDatabaseUrl = process.env.SWEEPER_DATABASE_URL || null;
let sweeperPool = null;
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

if (sweeperEnabled) {
  if (!sweeperDatabaseUrl) {
    throw new Error('SWEEPER_DATABASE_URL is required when SWEEPER_ENABLED is true');
  }
  let sweeperUrl;
  try {
    sweeperUrl = new URL(sweeperDatabaseUrl);
  } catch (error) {
    throw new Error('SWEEPER_DATABASE_URL is not a valid URL', { cause: error });
  }
  if (!['postgres:', 'postgresql:'].includes(sweeperUrl.protocol) ||
      !sweeperUrl.hostname || !sweeperUrl.username || !sweeperUrl.pathname || sweeperUrl.pathname === '/') {
    throw new Error('SWEEPER_DATABASE_URL must include a PostgreSQL host, username and database name');
  }
  const sweeperHost = sweeperUrl.hostname.replace(/^\\[|\\]$/g, '');
  if (!['localhost', '127.0.0.1', '::1'].includes(sweeperHost) &&
      sweeperUrl.searchParams.get('sslmode') !== 'verify-full') {
    throw new Error('Remote SWEEPER_DATABASE_URL must explicitly use sslmode=verify-full');
  }
  const pgModule = await import('pg');
  sweeperPool = new pgModule.default.Pool({
    connectionString: sweeperDatabaseUrl,
    max: 4,
    min: 0,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    keepAlive: true,
    application_name: 'blackchin-sweeper'
  });
  sweeperPool.on('error', (error) => {
    console.error('[SWEEPER POSTGRESQL POOL ERROR]', {
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
if (!Number.isSafeInteger(sweeperIntervalMs) || sweeperIntervalMs < 5_000) {
  throw new Error('SWEEPER_INTERVAL_MS must be an integer >= 5000');
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
let sweeperWorker;
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
    if (sweeperWorker) await sweeperWorker.stop();
    if (withdrawalReconciliationWorker) await withdrawalReconciliationWorker.stop();
    if (reconciliationWorker) await reconciliationWorker.stop();
    if (worker) await worker.stop();
    if (server) await server.close();
    if (tenantPool) await tenantPool.end();
    if (depositWorkerPool) await depositWorkerPool.end();
    if (sweeperPool) await sweeperPool.end();
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
  if (sweeperPool) {
    const { assertSweeperRuntimeRole } =
      await import('./infrastructure/security/sweeper-worker-role.js');
    const sweeperIdentity = await assertSweeperRuntimeRole(sweeperPool);
    console.log('[SWEEPER DATABASE READY]', sweeperIdentity);
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
  await pool.query('SELECT destination_public_key, execution_enabled FROM sweep_policies LIMIT 0');
  await pool.query('SELECT transaction_signature, idempotency_key FROM sweep_jobs LIMIT 0');
  await pool.query('SELECT outcome, signature FROM sweep_events LIMIT 0');

  // Imported after dotenv so the API key and encryption key are configured.
  const { buildServer } = await import('./api/server.js');
  const { createServices, createTenantRequestServices } = await import('./core/services.js');
  const { createDepositScannerWorker } = await import('./workers/deposit-scanner.worker.js');
  const { acquireReconciliationLock } = await import('./infrastructure/database/deposit-reconciliation.repository.js');
  const { acquireWithdrawalReconciliationLock } = await import('./infrastructure/database/withdrawal-reconciliation.repository.js');
  const { createHealthService } = await import('./core/health.service.js');
  const { createSweeperService } = await import('./core/sweeper/sweeper.service.js');
  const { createSweeperWorker } = await import('./workers/sweeper.worker.js');

  // Creating services validates ENCRYPTION_KEY and fails closed before the
  // port is opened.
  const services = createServices({ pool, webhookWorkerRef });
  const depositWorkerServices = depositWorkerPool
    ? createServices({ db: depositWorkerPool, pool: depositWorkerPool })
    : null;

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
    const timer = setInterval(async () => {
      if (running || shuttingDown) return;
      running = true;
      try {
        await worker.runOnce();
      } catch (error) {
        log('webhook.worker_error', { message: error.message });
      } finally {
        running = false;
      }
    }, webhookDeliveryIntervalMs);
    timer.unref?.();

    webhookWorker = {
      metrics: worker.metrics,
      runOnce: worker.runOnce,
      async stop() {
        clearInterval(timer);
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
      log: (message, meta) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...meta }))
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
      log: (message, meta) => console.log(JSON.stringify({
        time: new Date().toISOString(),
        message: message.replace('scanner.', 'deposit_reconciliation.'),
        ...meta
      }))
    });
  }

  if (sweeperEnabled) {
    const sweeperService = createSweeperService({
      db: sweeperPool,
      rpc: services.deps.rpc,
      cipher: services.deps.cipher,
      network: scannerNetwork,
      commitment: services.deps.commitment,
      executionEnabled: sweeperExecutionEnabled,
      log: (event, meta) => console.log(JSON.stringify({
        time: new Date().toISOString(), event, ...meta
      }))
    });
    sweeperWorker = createSweeperWorker({
      sweeper: sweeperService,
      pool: sweeperPool,
      network: scannerNetwork,
      intervalMs: sweeperIntervalMs,
      log: (event, meta) => console.log(JSON.stringify({
        time: new Date().toISOString(), event, ...meta
      }))
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
      log: (message, meta) => console.log(JSON.stringify({
        time: new Date().toISOString(),
        message: message.replace('scanner.', 'withdrawal_reconciliation.'),
        ...meta
      }))
    });
  }

  const health = createHealthService({
    pool,
    scanner: worker,
    workerEnabled: scannerEnabled,
    reconciliationWorker,
    reconciliationEnabled,
    withdrawalReconciliationWorker,
    withdrawalReconciliationEnabled,
    sweeperWorker,
    sweeperEnabled,
    network: scannerNetwork,
    scope: scannerScope,
    queueDepth: async () => {
      const { countPending } = await import('./infrastructure/database/webhook-outbox.repository.js');
      return countPending(pool);
    }
  });

  server = buildServer({
    services,
    health,
    tenantPool,
    tenantContextSigner,
    createTenantServices: (tenantDb) => createTenantRequestServices(services, tenantDb)
  });
  await server.listen({ host, port });

  if (sweeperWorker) {
    await sweeperWorker.start();
    console.log(`Sweeper worker started (network=${scannerNetwork}, interval=${sweeperIntervalMs}ms, execution=${sweeperExecutionEnabled ? 'enabled' : 'disabled'})`);
  } else {
    console.log('Sweeper worker disabled (SWEEPER_ENABLED is not "true")');
  }
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
  if (sweeperPool) await sweeperPool.end().catch(() => { });
  await disconnectPostgres().catch(() => { });
  process.exitCode = 1;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
