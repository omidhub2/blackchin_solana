import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const enabled = Boolean(process.env.DATABASE_URL);

test('PostgreSQL enforces immutable ledger identity and monotonic status transitions', {
  skip: !enabled && 'requires DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
  let tenantId;
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const wallet = `ledger_wallet_${suffix}`;
  const signature = `ledger_signature_${suffix}`;

  try {
    const tenant = await pool.query(
      `INSERT INTO tenants (tenant_code, display_name, status)
       VALUES ($1, $1, 'active') RETURNING id`,
      [`ledger_${suffix.slice(0, 24)}`]
    );
    tenantId = String(tenant.rows[0].id);

    const inserted = await pool.query(
      `INSERT INTO blockchain_transactions (
         tenant_id, signature, direction, wallet_public_key, amount_lamports,
         fee_lamports, network, status
       ) VALUES ($1, $2, 'deposit', $3, 5000, 100, 'devnet', 'detected')
       RETURNING id`,
      [tenantId, signature, wallet]
    );
    const id = inserted.rows[0].id;

    await assert.rejects(
      () => pool.query(
        'UPDATE blockchain_transactions SET amount_lamports = 6000 WHERE id = $1',
        [id]
      ),
      (error) => error.code === '23514'
    );
    await assert.rejects(
      () => pool.query(
        'UPDATE blockchain_transactions SET tenant_id = NULL WHERE id = $1',
        [id]
      ),
      (error) => error.code === '23514'
    );

    const advanced = await pool.query(
      "UPDATE blockchain_transactions SET status = 'confirmed' WHERE id = $1 RETURNING status",
      [id]
    );
    assert.equal(advanced.rows[0].status, 'confirmed');

    await assert.rejects(
      () => pool.query(
        "UPDATE blockchain_transactions SET status = 'detected' WHERE id = $1",
        [id]
      ),
      (error) => error.code === '23514'
    );
    await assert.rejects(
      () => pool.query('DELETE FROM blockchain_transactions WHERE id = $1', [id]),
      (error) => error.code === '23514'
    );
  } finally {
    if (tenantId) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await pool.end();
  }
});

test('PostgreSQL serializes processing withdrawals per source wallet and tenant', {
  skip: !enabled && 'requires DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
  let tenantId;
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const walletA = `withdrawal_wallet_a_${suffix}`;
  const walletB = `withdrawal_wallet_b_${suffix}`;
  const keys = [];

  try {
    const tenant = await pool.query(
      `INSERT INTO tenants (tenant_code, display_name, status)
       VALUES ($1, $1, 'active') RETURNING id`,
      [`withdrawal_${suffix.slice(0, 24)}`]
    );
    tenantId = String(tenant.rows[0].id);

    async function reserve(key, source) {
      return pool.query(
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
    keys.push(firstKey, secondKey, thirdKey);

    await reserve(firstKey, walletA);
    await assert.rejects(
      () => reserve(secondKey, walletA),
      (error) => error.code === '23505'
    );

    const otherWallet = await reserve(thirdKey, walletB);
    assert.equal(otherWallet.rowCount, 1);

    await pool.query(
      "UPDATE api_idempotency_keys SET status = 'failed' WHERE tenant_id = $1 AND idempotency_key = $2",
      [tenantId, firstKey]
    );
    const retryAfterSafeFailure = await reserve(secondKey, walletA);
    assert.equal(retryAfterSafeFailure.rowCount, 1);

    await assert.rejects(
      () => pool.query(
        "UPDATE api_idempotency_keys SET transaction_signature = 'replacement' WHERE tenant_id = $1 AND idempotency_key = $2",
        [tenantId, firstKey]
      ),
      (error) => error.code === '23514'
    );
  } finally {
    if (tenantId) {
      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
    }
    await pool.end();
  }
});
