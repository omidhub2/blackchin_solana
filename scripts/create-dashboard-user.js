/**
 * Create a dashboard operator.
 *
 * Usage:
 *   node scripts/create-dashboard-user.js --email=ops@example.com \
 *     --password='<12+ chars>' --name='Operations' --role=admin
 *
 * Prefer passing the password through the environment
 * (DASHBOARD_USER_PASSWORD) so it does not appear in shell history.
 * Never run this against a production database without a backup and an
 * approved change record.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

import { createDashboardAuthService } from '../src/core/dashboard/dashboard-auth.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

function parseArgs(argv) {
  const args = {};
  for (const entry of argv) {
    if (!entry.startsWith('--')) continue;
    const index = entry.indexOf('=');
    if (index === -1) {
      args[entry.slice(2)] = true;
    } else {
      args[entry.slice(2, index)] = entry.slice(index + 1);
    }
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const email = args.email ?? process.env.DASHBOARD_USER_EMAIL;
  const password = args.password ?? process.env.DASHBOARD_USER_PASSWORD;
  const displayName = args.name ?? process.env.DASHBOARD_USER_NAME ?? 'Dashboard Operator';
  const role = args.role ?? process.env.DASHBOARD_USER_ROLE ?? 'admin';

  if (!email || !password) {
    throw new Error(
      'Provide --email and --password (or DASHBOARD_USER_EMAIL / DASHBOARD_USER_PASSWORD)'
    );
  }

  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL,
    max: 1,
    connectionTimeoutMillis: 30_000,
    application_name: 'blackchin-dashboard-user'
  });

  try {
    const auth = createDashboardAuthService({ db: pool });
    const user = await auth.createUser({ email, password, displayName, role });
    console.log(JSON.stringify({
      created: true,
      id: user.id,
      email: user.email,
      role: user.role
    }, null, 2));
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error('[DASHBOARD USER CREATION FAILED]', error.message);
  process.exitCode = 1;
});