import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';

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
