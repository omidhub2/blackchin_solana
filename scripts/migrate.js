import crypto from 'node:crypto';
import path from 'node:path';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import dotenv from 'dotenv';
import pg from 'pg';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');
const DEFAULT_MIGRATIONS_DIR = path.join(PROJECT_ROOT, 'migrations');
const LOCK_NAME = 'blackchin-wallet-engine:migrations:v1';

dotenv.config({ path: path.join(PROJECT_ROOT, '.env') });

const MIGRATION_FILENAME = /^(\d{4,})_([a-z0-9][a-z0-9_-]*)\.sql$/i;

export function calculateChecksum(sql) {
  if (typeof sql !== 'string') {
    throw new TypeError('Migration SQL must be a string');
  }

  return crypto.createHash('sha256').update(sql, 'utf8').digest('hex');
}

export async function loadMigrationFiles(migrationsDir = DEFAULT_MIGRATIONS_DIR) {
  const entries = await readdir(migrationsDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.sql')) continue;

    const match = entry.name.match(MIGRATION_FILENAME);
    if (!match) {
      throw new Error(
        `Invalid migration filename "${entry.name}". Expected NNNN_description.sql`
      );
    }

    const version = match[1];

    files.push({
      version,
      filename: entry.name,
      sql: await readFile(path.join(migrationsDir, entry.name), 'utf8')
    });
  }

  files.sort((a, b) => {
    const versionOrder = BigInt(a.version) < BigInt(b.version)
      ? -1
      : BigInt(a.version) > BigInt(b.version)
        ? 1
        : 0;

    return versionOrder || a.filename.localeCompare(b.filename);
  });

  for (let index = 1; index < files.length; index += 1) {
    if (files[index - 1].version === files[index].version) {
      throw new Error(
        `Duplicate migration version ${files[index].version}: ${files[index - 1].filename}, ${files[index].filename}`
      );
    }
  }

  return files.map((file) => ({
    ...file,
    checksum: calculateChecksum(file.sql)
  }));
}

export function createMigrationPlan(migrationFiles, appliedRows) {
  const filesByVersion = new Map(
    migrationFiles.map((file) => [file.version, file])
  );
  const appliedByVersion = new Map(
    appliedRows.map((row) => [String(row.version), row])
  );

  const drift = [];

  for (const [version, applied] of appliedByVersion) {
    const file = filesByVersion.get(version);

    if (!file) {
      drift.push({
        version,
        filename: applied.filename,
        reason: 'applied_migration_file_missing'
      });
      continue;
    }

    if (file.filename !== applied.filename) {
      drift.push({
        version,
        filename: file.filename,
        reason: 'applied_filename_changed'
      });
      continue;
    }

    if (file.checksum !== applied.checksum) {
      drift.push({
        version,
        filename: file.filename,
        reason: 'checksum_mismatch'
      });
    }
  }

  if (drift.length > 0) {
    const details = drift
      .map((item) => `${item.version} (${item.filename}): ${item.reason}`)
      .join('; ');

    const error = new Error(
      `Migration history drift detected: ${details}. Never edit an applied migration; create a new migration instead.`
    );
    error.code = 'MIGRATION_DRIFT';
    error.drift = drift;
    throw error;
  }

  const pending = migrationFiles.filter(
    (file) => !appliedByVersion.has(file.version)
  );

  const applied = migrationFiles
    .filter((file) => appliedByVersion.has(file.version))
    .map((file) => ({
      version: file.version,
      filename: file.filename,
      appliedAt: appliedByVersion.get(file.version).applied_at
    }));

  return { applied, pending, drift: [] };
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version VARCHAR(32) PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      checksum CHAR(64) NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function readAppliedMigrations(client) {
  const result = await client.query(`
    SELECT version, filename, checksum, applied_at
    FROM schema_migrations
    ORDER BY version;
  `);

  return result.rows;
}

/**
 * Apply pending SQL migrations under a PostgreSQL advisory lock.
 * Each migration and its history row commit atomically.
 */
export async function runMigrations({
  pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR,
  logger = console
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  const migrationFiles = await loadMigrationFiles(migrationsDir);
  const client = await pool.connect();
  let lockAcquired = false;

  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtext($1)::bigint)',
      [LOCK_NAME]
    );
    lockAcquired = true;

    await ensureMigrationTable(client);

    const appliedRows = await readAppliedMigrations(client);
    const plan = createMigrationPlan(migrationFiles, appliedRows);

    for (const migration of plan.pending) {
      logger.info?.(
        `Applying migration ${migration.version}: ${migration.filename}`
      );

      await client.query('BEGIN');

      try {
        await client.query(migration.sql);

        await client.query(
          `
            INSERT INTO schema_migrations (
              version,
              filename,
              checksum
            )
            VALUES ($1, $2, $3)
          `,
          [
            migration.version,
            migration.filename,
            migration.checksum
          ]
        );

        await client.query('COMMIT');

        plan.applied.push({
          version: migration.version,
          filename: migration.filename,
          appliedAt: new Date().toISOString()
        });

        logger.info?.(
          `Applied migration ${migration.version}: ${migration.filename}`
        );
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        error.message =
          `Migration ${migration.filename} failed: ${error.message}`;
        throw error;
      }
    }

    return {
      applied: plan.applied,
      pending: [],
      drift: []
    };
  } finally {
    if (lockAcquired) {
      await client.query(
        'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
        [LOCK_NAME]
      ).catch((error) => {
        logger.error?.('Could not release PostgreSQL migration lock:', error.message);
      });
    }

    client.release();
  }
}

export async function getMigrationStatus({
  pool,
  migrationsDir = DEFAULT_MIGRATIONS_DIR
}) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }

  const migrationFiles = await loadMigrationFiles(migrationsDir);
  const client = await pool.connect();

  try {
    await client.query(
      'SELECT pg_advisory_lock(hashtext($1)::bigint)',
      [LOCK_NAME]
    );

    await ensureMigrationTable(client);
    const appliedRows = await readAppliedMigrations(client);
    return createMigrationPlan(migrationFiles, appliedRows);
  } finally {
    await client.query(
      'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
      [LOCK_NAME]
    ).catch(() => {});
    client.release();
  }
}

async function main() {
  const command = process.argv[2] ?? 'up';

  if (!['up', 'status'].includes(command)) {
    throw new Error('Usage: node scripts/migrate.js [up|status]');
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error('DATABASE_URL is not configured');
  }

  const { Pool } = pg;
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    connectionTimeoutMillis: 30_000,
    idleTimeoutMillis: 10_000,
    keepAlive: true,
    application_name: 'blackchin-db-migrations'
  });

  try {
    if (command === 'status') {
      const status = await getMigrationStatus({ pool });

      console.log('\nDATABASE MIGRATION STATUS');
      console.table([
        ...status.applied.map((item) => ({
          version: item.version,
          filename: item.filename,
          status: 'applied'
        })),
        ...status.pending.map((item) => ({
          version: item.version,
          filename: item.filename,
          status: 'pending'
        }))
      ]);

      if (status.pending.length === 0) {
        console.log('All migrations are applied.');
      }
      return;
    }

    const result = await runMigrations({ pool });

    console.log('\nMIGRATION SUMMARY');
    console.table(result.applied.map((item) => ({
      version: item.version,
      filename: item.filename,
      status: 'applied'
    })));

    if (result.applied.length === 0) {
      console.log('Database is already up to date.');
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    console.error('[MIGRATION FAILED]', error.message);
    process.exitCode = 1;
  });
}
