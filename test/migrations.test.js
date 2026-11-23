import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';

import {
  calculateChecksum,
  createMigrationPlan,
  loadMigrationFiles,
  runMigrations
} from '../scripts/migrate.js';

test('calculates stable SHA-256 checksums', () => {
  const sql = 'SELECT 1;';
  const expected = crypto.createHash('sha256').update(sql).digest('hex');

  assert.equal(calculateChecksum(sql), expected);
  assert.throws(() => calculateChecksum(null), /must be a string/);
});

test('loads migration files in numeric version order', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackchin-migrations-'));

  try {
    await writeFile(path.join(directory, '0010_add_index.sql'), 'SELECT 10;');
    await writeFile(path.join(directory, '0002_create_table.sql'), 'SELECT 2;');
    await writeFile(path.join(directory, '0003_add_column.sql'), 'SELECT 3;');
    await writeFile(path.join(directory, 'README.md'), 'ignored');

    const files = await loadMigrationFiles(directory);

    assert.deepEqual(
      files.map((file) => file.version),
      ['0002', '0003', '0010']
    );
    assert.ok(files.every((file) => /^[a-f0-9]{64}$/.test(file.checksum)));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects invalid migration names and duplicate versions', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackchin-migrations-'));

  try {
    await writeFile(path.join(directory, 'bad-name.sql'), 'SELECT 1;');
    await assert.rejects(loadMigrationFiles(directory), /Invalid migration filename/);

    await rm(path.join(directory, 'bad-name.sql'));
    await writeFile(path.join(directory, '0001_first.sql'), 'SELECT 1;');
    await writeFile(path.join(directory, '0001_second.sql'), 'SELECT 2;');

    await assert.rejects(loadMigrationFiles(directory), /Duplicate migration version/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('plans pending and applied migrations', () => {
  const files = [
    {
      version: '0001',
      filename: '0001_first.sql',
      checksum: 'a'.repeat(64)
    },
    {
      version: '0002',
      filename: '0002_second.sql',
      checksum: 'b'.repeat(64)
    }
  ];

  const plan = createMigrationPlan(files, [{
    version: '0001',
    filename: '0001_first.sql',
    checksum: 'a'.repeat(64),
    applied_at: '2026-01-01T00:00:00.000Z'
  }]);

  assert.equal(plan.applied.length, 1);
  assert.equal(plan.pending.length, 1);
  assert.equal(plan.pending[0].version, '0002');
});

test('fails closed on checksum drift or missing applied migration file', () => {
  const files = [{
    version: '0001',
    filename: '0001_first.sql',
    checksum: 'b'.repeat(64)
  }];

  assert.throws(
    () => createMigrationPlan(files, [{
      version: '0001',
      filename: '0001_first.sql',
      checksum: 'a'.repeat(64)
    }]),
    (error) => error.code === 'MIGRATION_DRIFT'
  );

  assert.throws(
    () => createMigrationPlan([], [{
      version: '0009',
      filename: '0009_removed.sql',
      checksum: 'a'.repeat(64)
    }]),
    (error) => error.code === 'MIGRATION_DRIFT'
  );
});

test('runs each migration and its history insert in one transaction', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'blackchin-migrations-'));
  const statements = [];

  try {
    await writeFile(
      path.join(directory, '0001_test.sql'),
      'CREATE TABLE migration_test (id integer);'
    );

    const client = {
      async query(sql, params) {
        statements.push({ sql: String(sql).trim(), params });

        if (String(sql).includes('FROM schema_migrations')) {
          return { rows: [], rowCount: 0 };
        }

        return { rows: [], rowCount: 0 };
      },
      release() {
        statements.push({ sql: 'RELEASE' });
      }
    };

    const fakePool = {
      async connect() {
        return client;
      }
    };

    const result = await runMigrations({
      pool: fakePool,
      migrationsDir: directory,
      logger: { info() {}, error() {} }
    });

    assert.equal(result.applied.length, 1);
    assert.ok(statements.some((item) => item.sql === 'BEGIN'));
    assert.ok(statements.some((item) => item.sql.includes('CREATE TABLE migration_test')));
    assert.ok(statements.some((item) => item.sql.startsWith('INSERT INTO schema_migrations')));
    assert.ok(statements.some((item) => item.sql === 'COMMIT'));
    assert.ok(statements.some((item) => item.sql === 'RELEASE'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('hardening migrations parse into ordered, checksummed versions', async () => {
  const files = await loadMigrationFiles();
  const versions = files.map((file) => file.version);

  assert.ok(versions.includes('0004'));
  assert.ok(versions.includes('0005'));
  assert.ok(versions.includes('0006'));
  assert.ok(versions.includes('0007'));
  assert.ok(versions.includes('0008'));
  assert.ok(versions.includes('0009'));
  assert.ok(versions.includes('0010'));
  assert.ok(versions.includes('0011'));
  assert.ok(versions.includes('0012'));
  assert.ok(versions.includes('0013'));
  assert.ok(versions.includes('0014'));
  assert.equal(new Set(versions).size, versions.length);
  assert.deepEqual(versions, [...versions].sort());

  for (const file of files) {
    assert.match(file.checksum, /^[a-f0-9]{64}$/);
  }
});

test('0005 ledger immutability is additive and re-runnable', async () => {
  const sql = await readFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '..',
      'migrations',
      '0005_ledger_immutability.sql'
    ),
    'utf8'
  );

  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.doesNotMatch(sql, /ALTER TABLE[\s\S]*DROP COLUMN/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS/i);
  assert.match(sql, /CREATE TRIGGER trg_blockchain_transactions_no_delete/i);
});


test('0007 adds append-only deposit reconciliation history without touching balances', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0007_deposit_reconciliation.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS deposit_reconciliation_cursors/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS deposit_reconciliation_events/i);
  assert.match(sql, /CREATE TRIGGER trg_deposit_reconciliation_events_immutable\s+BEFORE UPDATE OR DELETE ON deposit_reconciliation_events/i);
  assert.match(sql, /RAISE EXCEPTION[\s\S]{0,200}check_violation/i);
  assert.match(sql, /REFERENCES blockchain_transactions\(id\) ON DELETE RESTRICT/i);
  assert.match(sql, /outcome IN \('consistent', 'under_review', 'recovered', 'rpc_error'\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+(?:wallets|wallet_accounts|hd_wallets)/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});

test('0008 adds append-only withdrawal reconciliation evidence without a monetary ledger', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0008_withdrawal_reconciliation.sql'),
    'utf8'
  );

  assert.match(sql, /ALTER TABLE api_idempotency_keys[\s\S]*ADD COLUMN IF NOT EXISTS network/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS to_public_key/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS amount_lamports/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS withdrawal_reconciliation_cursors/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS withdrawal_reconciliation_events/i);
  assert.match(sql, /REFERENCES api_idempotency_keys\(idempotency_key\) ON DELETE RESTRICT/i);
  assert.match(sql, /CREATE TRIGGER trg_withdrawal_reconciliation_events_immutable\s+BEFORE UPDATE OR DELETE ON withdrawal_reconciliation_events/i);
  assert.doesNotMatch(sql, /UPDATE\s+(?:wallets|wallet_accounts|hd_wallets)/i);
  assert.doesNotMatch(sql, /CREATE TABLE[^;]*(?:balance|reservation|ledger)/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});


test('0009 adds tenant registry and nullable ownership foundation without guessing legacy ownership', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0009_tenant_foundation.sql'),
    'utf8'
  );

  assert.match(sql, /DO \$\$[\s\S]*?\$\$;/i);
  assert.doesNotMatch(sql, /\bDO \$(?:\r?\n|\s)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenants/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_api_credentials/i);
  assert.match(sql, /secret_hash BYTEA NOT NULL[\s\S]*octet_length\(secret_hash\) = 32/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS tenant_id BIGINT/i);
  assert.match(sql, /fk_wallet_accounts_tenant_hd_wallet/i);
  assert.match(sql, /fk_blockchain_transactions_tenant_hd_wallet/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION prevent_tenant_reassignment/i);
  assert.match(sql, /BEFORE UPDATE OF tenant_id ON tenant_api_credentials/i);
  assert.match(sql, /BEFORE UPDATE OF tenant_id ON wallets/i);
  assert.match(sql, /BEFORE UPDATE OF tenant_id ON hd_wallets/i);
  assert.match(sql, /BEFORE UPDATE OF tenant_id ON blockchain_transactions/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
  assert.match(sql, /Existing rows remain unassigned/i);
});

test('0011 separates tenant idempotency namespaces while preserving legacy key uniqueness', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0011_tenant_idempotency_namespace.sql'),
    'utf8'
  );
  assert.match(sql, /WHERE tenant_id IS NULL/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS tenant_credential_id BIGINT/i);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS approval_reference VARCHAR\(128\)/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, tenant_credential_id\)/i);
  assert.match(sql, /ON api_idempotency_keys\(idempotency_key\)/i);
  assert.match(sql, /ON api_idempotency_keys\(tenant_id, idempotency_key\)/i);
  assert.doesNotMatch(sql, /UPDATE\s+api_idempotency_keys\s+SET\s+tenant_id/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});
test('0010 binds Solana withdrawal reconciliation evidence to tenant identity without reassigning legacy rows', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0010_tenant_withdrawal_reconciliation.sql'),
    'utf8'
  );

  assert.match(sql, /ADD COLUMN IF NOT EXISTS tenant_id BIGINT/i);
  assert.match(sql, /CREATE UNIQUE INDEX IF NOT EXISTS uq_api_idempotency_tenant_key/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, idempotency_key\)/i);
  assert.match(sql, /REFERENCES api_idempotency_keys\(tenant_id, idempotency_key\)/i);
  assert.match(sql, /MATCH SIMPLE semantics intentionally allow historical rows/i);
  assert.match(sql, /idx_withdrawal_reconciliation_events_tenant_checked/i);
  assert.doesNotMatch(sql, /UPDATE\s+withdrawal_reconciliation_events/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
  assert.match(sql, /globally unique idempotency_key constraint is deliberately retained/i);
});


test('0012 creates fail-closed tenant withdrawal policy, approval and append-only audit foundations', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0012_tenant_withdrawal_policy_foundation.sql'),
    'utf8'
  );
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_withdrawal_policies/i);
  assert.match(sql, /RETURNS TRIGGER AS \$policy\$/i);
  assert.match(sql, /enabled BOOLEAN NOT NULL DEFAULT FALSE/i);
  assert.match(sql, /emergency_frozen BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(sql, /max_daily_lamports NUMERIC\(30, 0\)/i);
  assert.match(sql, /max_weekly_count INTEGER/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_withdrawal_destinations/i);
  assert.match(sql, /status IN \('pending', 'active', 'revoked'\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_withdrawal_approvals/i);
  assert.match(sql, /FOREIGN KEY \(tenant_id, credential_id\)/i);
  assert.match(sql, /UNIQUE \(issuer, issuer_event_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_withdrawal_policy_events/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON tenant_withdrawal_policy_events/i);
  assert.match(sql, /BEFORE UPDATE ON tenant_withdrawal_approvals/i);
  assert.match(sql, /network IN \('devnet', 'testnet', 'mainnet-beta'\)/i);
  assert.match(sql, /Deliberately do not create policy rows for existing tenants/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
});

test('0013 adds dashboard identity, durable operational events, tenant webhooks and hot wallets', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0013_dashboard_realtime_platform.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS dashboard_users/i);
  assert.match(sql, /password_hash TEXT NOT NULL/i);
  assert.match(sql, /role IN \('admin', 'operator', 'viewer'\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS dashboard_sessions/i);
  assert.match(sql, /token_hash BYTEA NOT NULL CHECK \(octet_length\(token_hash\) = 32\)/i);
  assert.match(sql, /csrf_token_hash BYTEA NOT NULL/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS operational_events/i);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON operational_events/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS tenant_webhook_endpoints/i);
  assert.match(sql, /secret_encrypted TEXT NOT NULL/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS hot_wallets/i);
  assert.match(sql, /signing_enabled BOOLEAN NOT NULL DEFAULT TRUE/i);
  assert.match(sql, /prevent_hot_wallet_rebinding/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE|DELETE FROM/i);
  assert.doesNotMatch(sql, /(?:customer|partner)_balance/i);
});

test('0014 installs signed tenant context validation and restrictive RLS policies', async () => {
  const sql = await readFile(
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations', '0014_signed_tenant_rls.sql'),
    'utf8'
  );

  assert.match(sql, /CREATE TABLE IF NOT EXISTS private\.tenant_context_secrets/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION private\.current_tenant_id\(\)/i);
  assert.match(sql, /SECURITY DEFINER/i);
  assert.match(sql, /public\.hmac\(/i);
  assert.match(sql, /c\.status = 'active'/i);
  assert.match(sql, /c\.revoked_at IS NULL/i);
  assert.match(sql, /c\.expires_at IS NULL OR c\.expires_at > statement_timestamp\(\)/i);
  assert.match(sql, /CREATE ROLE blackchin_tenant_runtime/i);
  assert.match(sql, /NOSUPERUSER[\s\S]*NOBYPASSRLS/i);
  assert.match(sql, /ENABLE ROW LEVEL SECURITY/i);
  assert.match(sql, /AS RESTRICTIVE FOR ALL TO blackchin_tenant_runtime/i);
  assert.match(sql, /USING \(tenant_id = private\.current_tenant_id\(\)\)/i);
  assert.match(sql, /WITH CHECK \(tenant_id = private\.current_tenant_id\(\)\)/i);
  assert.doesNotMatch(sql, /FORCE ROW LEVEL SECURITY/i);
  assert.doesNotMatch(sql, /UPDATE\s+(?:wallets|wallet_accounts|hd_wallets)[\s\S]*SET tenant_id/i);
  assert.doesNotMatch(sql, /DROP TABLE|TRUNCATE/i);
});
