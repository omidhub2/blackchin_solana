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

let server;

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down wallet API...`);

  try {
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

  // Imported after dotenv so the API key and encryption key are configured.
  const { buildServer } = await import('./api/server.js');
  const { createServices } = await import('./core/services.js');

  // Creating services validates ENCRYPTION_KEY and fails closed before the
  // port is opened.
  const services = createServices({ pool });

  server = buildServer({ services });
  await server.listen({ host, port });

  console.log(`Wallet API listening on http://${host}:${port}`);
} catch (error) {
  console.error('[API STARTUP FAILED]', error.message);
  await disconnectPostgres().catch(() => { });
  process.exitCode = 1;
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));
