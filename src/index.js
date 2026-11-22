import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { connectToPostgres, disconnectPostgres, pool } =
  await import('../PostgreSQL/walletStorage.js');

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

if (!Number.isSafeInteger(scannerIntervalMs) || scannerIntervalMs < 1_000) {
  throw new Error('DEPOSIT_SCANNER_INTERVAL_MS must be an integer >= 1000');
}
if (!Number.isSafeInteger(reconciliationIntervalMs) || reconciliationIntervalMs < 5_000) {
  throw new Error('DEPOSIT_RECONCILIATION_INTERVAL_MS must be an integer >= 5000');
}

let server;
let worker;
let reconciliationWorker;
let shuttingDown = false;

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;

  console.log(`Received ${signal}; shutting down wallet API...`);

  try {
    // Stop background work first so no scan writes after the pool starts
    // draining, then close HTTP, then the pool.
    if (reconciliationWorker) await reconciliationWorker.stop();
    if (worker) await worker.stop();
    if (server) await server.close();
    await disconnectPostgres();
    process.exitCode = 0;
  } catch (error) {
    console.error('[SHUTDOWN ERROR]', error.message);
    process.exitCode = 1;
  }
}

try {
  await connectToPostgres();

  // Fail fast if the schema migrations have not been applied.
  await pool.query('SELECT idempotency_key FROM api_idempotency_keys LIMIT 0');
  await pool.query('SELECT next_account_index FROM hd_wallets LIMIT 0');
  await pool.query('SELECT account_index FROM wallet_accounts LIMIT 0');
  await pool.query('SELECT direction FROM blockchain_transactions LIMIT 0');
  await pool.query('SELECT last_signature FROM deposit_scanner_cursors LIMIT 0');
  await pool.query('SELECT event_id FROM webhook_outbox LIMIT 0');
  await pool.query('SELECT bucket_key FROM rate_limit_counters LIMIT 0');
  await pool.query('SELECT last_transaction_id FROM deposit_reconciliation_cursors LIMIT 0');

  // Imported after dotenv so the API key and encryption key are configured.
  const { buildServer } = await import('./api/server.js');
  const { createServices } = await import('./core/services.js');
  const { createDepositScannerWorker } = await import('./workers/deposit-scanner.worker.js');
  const { acquireReconciliationLock } = await import('./infrastructure/database/deposit-reconciliation.repository.js');
  const { createHealthService } = await import('./core/health.service.js');

  // Creating services validates ENCRYPTION_KEY and fails closed before the
  // port is opened.
  const services = createServices({ pool });

  if (scannerEnabled) {
    worker = createDepositScannerWorker({
      scanner: services.depositScanner,
      cursors: services.deps.cursors,
      pool,
      network: scannerNetwork,
      scope: scannerScope,
      intervalMs: scannerIntervalMs,
      log: (message, meta) => console.log(JSON.stringify({ time: new Date().toISOString(), message, ...meta }))
    });
  }

  if (reconciliationEnabled) {
    reconciliationWorker = createDepositScannerWorker({
      scanner: services.depositReconciliation,
      cursors: {
        acquireScannerLock: (client, { network }) => acquireReconciliationLock(client, network)
      },
      pool,
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

  const health = createHealthService({
    pool,
    scanner: worker,
    workerEnabled: scannerEnabled,
    reconciliationWorker,
    reconciliationEnabled,
    network: scannerNetwork,
    scope: scannerScope
  });

  server = buildServer({ services, health });
  await server.listen({ host, port });

  if (worker) {
    await worker.start();
    console.log(`Deposit scanner started (network=${scannerNetwork}, scope=${scannerScope})`);
  } else {
    console.log('Deposit scanner disabled (DEPOSIT_SCANNER_ENABLED is not "true")');
  }
  if (reconciliationWorker) {
    await reconciliationWorker.start();
    console.log(`Deposit reconciliation started (network=${scannerNetwork})`);
  } else {
    console.log('Deposit reconciliation disabled (DEPOSIT_RECONCILIATION_ENABLED is not "true")');
  }

  console.log(`Wallet API listening on http://${host}:${port}`);
} catch (error) {
  console.error('[API STARTUP FAILED]', error.message);
  await disconnectPostgres().catch(() => { });
  process.exitCode = 1;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
