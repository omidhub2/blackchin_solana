import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const enabled = Boolean(process.env.DATABASE_URL);

async function expectSqlError(client, action, code) {
  const savepoint = `expected_error_${crypto.randomBytes(5).toString('hex')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  let caught;
  try {
    await action();
  } catch (error) {
    caught = error;
  }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  assert.ok(caught, `expected PostgreSQL error ${code}`);
  assert.equal(caught.code, code);
}

test('PostgreSQL enforces immutable ledger identity and monotonic status transitions', {
  skip: !enabled && 'requires DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll('-', '');
  try {
    await client.query('BEGIN');
    const tenant = await client.query(
      `INSERT INTO tenants (tenant_code, display_name, status)
       VALUES ($1, $1, 'active') RETURNING id`,
      [`ledger_${suffix.slice(0, 24)}`]
    );
    const inserted = await client.query(
      `INSERT INTO blockchain_transactions (
         tenant_id, signature, direction, wallet_public_key, amount_lamports,
         fee_lamports, network, status
       ) VALUES ($1, $2, 'deposit', $3, 5000, 100, 'devnet', 'detected')
       RETURNING id`,
      [tenant.rows[0].id, `ledger_signature_${suffix}`, `ledger_wallet_${suffix}`]
    );
    const id = inserted.rows[0].id;

    await expectSqlError(client,
      () => client.query('UPDATE blockchain_transactions SET amount_lamports = 6000 WHERE id = $1', [id]),
      '23514');
    await expectSqlError(client,
      () => client.query('UPDATE blockchain_transactions SET tenant_id = NULL WHERE id = $1', [id]),
      '23514');

    const advanced = await client.query(
      "UPDATE blockchain_transactions SET status = 'confirmed' WHERE id = $1 RETURNING status",
      [id]
    );
    assert.equal(advanced.rows[0].status, 'confirmed');

    await expectSqlError(client,
      () => client.query("UPDATE blockchain_transactions SET status = 'detected' WHERE id = $1", [id]),
      '23514');
    await expectSqlError(client,
      () => client.query('DELETE FROM blockchain_transactions WHERE id = $1', [id]),
      '23514');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});

test('PostgreSQL serializes processing withdrawals per source wallet and tenant', {
  skip: !enabled && 'requires DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll('-', '');
  try {
    await client.query('BEGIN');
    const tenant = await client.query(
      `INSERT INTO tenants (tenant_code, display_name, status)
       VALUES ($1, $1, 'active') RETURNING id`,
      [`withdrawal_${suffix.slice(0, 24)}`]
    );
    const tenantId = tenant.rows[0].id;
    const walletA = `withdrawal_wallet_a_${suffix}`;
    const walletB = `withdrawal_wallet_b_${suffix}`;

    async function reserve(key, source) {
      return client.query(
        `INSERT INTO api_idempotency_keys (
           tenant_id, idempotency_key, request_hash, status,
           wallet_public_key, operation, network, to_public_key, amount_lamports
         ) VALUES ($1, $2, $3, 'processing', $4, 'withdrawal', 'devnet', $5, 1000)
         RETURNING id`,
        [tenantId, key, crypto.createHash('sha256').update(key).digest('hex'), source, 'recipient']
      );
    }

    const firstKey = `withdrawal_a_${suffix}`;
    const secondKey = `withdrawal_b_${suffix}`;
    const thirdKey = `withdrawal_c_${suffix}`;

    await reserve(firstKey, walletA);
    await expectSqlError(client, () => reserve(secondKey, walletA), '23505');

    const otherWallet = await reserve(thirdKey, walletB);
    assert.equal(otherWallet.rowCount, 1);

    await client.query(
      "UPDATE api_idempotency_keys SET status = 'failed' WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, firstKey]
    );
    const retryAfterSafeFailure = await reserve(secondKey, walletA);
    assert.equal(retryAfterSafeFailure.rowCount, 1);

    await expectSqlError(client,
      () => client.query(
        "UPDATE api_idempotency_keys SET transaction_signature = 'replacement' WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, firstKey]
      ),
      '23514');

    await client.query(
      `UPDATE api_idempotency_keys
          SET transaction_signature = 'signature_once',
              status = 'completed',
              response_json = '{"ok":true}'::jsonb
        WHERE tenant_id = $1 AND idempotency_key = $2`,
      [tenantId, secondKey]
    );
    await expectSqlError(client,
      () => client.query(
        "UPDATE api_idempotency_keys SET transaction_signature = 'signature_twice' WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, secondKey]
      ),
      '23514');
    await expectSqlError(client,
      () => client.query(
        "UPDATE api_idempotency_keys SET response_json = '{\"ok\":false}'::jsonb WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, secondKey]
      ),
      '23514');
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
