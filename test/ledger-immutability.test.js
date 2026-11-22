/**
 * Ledger immutability — static guarantees.
 *
 * The UPDATE trigger from migration 0004 is re-installed by 0005 together with
 * a DELETE guard. These tests pin the *contract* the database rules must
 * implement, and pin that the application never issues a DELETE or touches
 * identity/monetary columns.
 *
 * The rules themselves can only be exercised by PostgreSQL; run the
 * integration suite (`npm run test:ledger`) against a disposable database.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createFakePool } from './helpers/fake-pool.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = path.join(ROOT, 'migrations');
const REPOSITORY = path.join(
  ROOT,
  'src',
  'infrastructure',
  'database',
  'blockchain-transaction.repository.js'
);

const IDENTITY_COLUMNS = [
  'signature',
  'direction',
  'wallet_public_key',
  'amount_lamports',
  'fee_lamports',
  'network'
];

const LIFECYCLE_COLUMNS = [
  'status',
  'commitment',
  'slot',
  'block_time',
  'failure_reason',
  'metadata',
  'updated_at'
];

async function loadSql(...files) {
  const parts = await Promise.all(
    files.map((file) => readFile(path.join(MIGRATIONS, file), 'utf8'))
  );

  return parts.join('\n');
}

test('migration 0005 installs an UPDATE guard and a DELETE guard', async () => {
  const sql = await loadSql('0004_hardening.sql', '0005_ledger_immutability.sql');

  assert.match(
    sql,
    /CREATE TRIGGER trg_blockchain_transactions_immutable\s+BEFORE UPDATE ON blockchain_transactions/i
  );
  assert.match(
    sql,
    /CREATE TRIGGER trg_blockchain_transactions_no_delete\s+BEFORE DELETE ON blockchain_transactions/i
  );

  // Both guards must abort the statement (no swallowed EXCEPTION blocks).
  assert.doesNotMatch(sql, /EXCEPTION\s+WHEN/i);
  assert.match(sql, /RAISE EXCEPTION[\s\S]{0,200}check_violation/i);
});

test('the UPDATE guard protects identity and monetary columns', async () => {
  const sql = await loadSql('0005_ledger_immutability.sql');
  const guard = sql.slice(
    sql.indexOf('FUNCTION enforce_blockchain_transaction_immutability'),
    sql.indexOf('LANGUAGE plpgsql')
  );

  for (const column of IDENTITY_COLUMNS) {
    assert.match(guard, new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM OLD\\.${column}`, 'i'));
  }

  // Lifecycle columns must NOT be part of the rejection predicate, otherwise
  // legitimate status advancement (detected -> confirming -> confirmed) breaks.
  for (const column of LIFECYCLE_COLUMNS) {
    assert.doesNotMatch(guard, new RegExp(`NEW\\.${column}\\s+IS DISTINCT FROM`, 'i'));
  }
});

test('migration 0005 is additive and safe to re-run', async () => {
  const sql = await loadSql('0005_ledger_immutability.sql');

  assert.doesNotMatch(sql, /DROP TABLE/i);
  assert.doesNotMatch(sql, /ALTER TABLE[\s\S]*DROP COLUMN/i);
  assert.doesNotMatch(sql, /TRUNCATE/i);
  assert.match(sql, /CREATE OR REPLACE FUNCTION/i);
  assert.match(sql, /DROP TRIGGER IF EXISTS/i);
});

test('legitimate lifecycle updates succeed and keep identity columns intact', async () => {
  const calls = [];
  const pool = createFakePool();

  pool.onQuery('UPDATE blockchain_transactions', (params, call) => {
    calls.push({ params, sql: call.sql });
    return { rows: [{ id: params[0], status: params[1] }], rowCount: 1 };
  });

  const { updateTransactionStatus } = await import(
    `file://${REPOSITORY.replace(/\\/g, '/')}`
  );

  const updated = await updateTransactionStatus(pool, '42', {
    status: 'confirmed',
    commitment: 'confirmed',
    slot: 123,
    failureReason: null,
    metadata: { reconciled: true }
  });

  assert.equal(calls.length, 1);
  assert.ok(updated);

  const { sql, params } = calls[0];

  // The statement only writes lifecycle columns.
  for (const column of IDENTITY_COLUMNS) {
    assert.doesNotMatch(sql, new RegExp(`SET[\\s\\S]*${column}\\s*=\\s*\\$`, 'i'));
  }

  assert.match(sql, /status\s*=\s*\$2/i);
  assert.equal(params[1], 'confirmed');
});

test('the application never deletes ledger rows or binds identity columns', async () => {
  const repository = await readFile(REPOSITORY, 'utf8');

  assert.doesNotMatch(repository, /DELETE\s+FROM\s+blockchain_transactions/i);

  // Exactly one UPDATE site exists (the lifecycle updater); identity and
  // monetary columns are never part of a SET clause there.
  const updateSites = repository.match(/UPDATE\s+blockchain_transactions/gi) ?? [];
  assert.equal(updateSites.length, 1);

  // The only mutation is the lifecycle UPDATE above, built from an explicit
  // column list that excludes identity/monetary fields.
  const lifecycleStatement = repository.slice(
    repository.indexOf('export async function updateTransactionStatus'),
    repository.indexOf('export async function listTransactionsByWallet')
  );

  for (const column of IDENTITY_COLUMNS) {
    assert.doesNotMatch(
      lifecycleStatement,
      new RegExp(`${column}\\s*=\\s*COALESCE|${column}\\s*=\\s*\\$`, 'i')
    );
  }
});
