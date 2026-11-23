import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';

const enabled = Boolean(process.env.DATABASE_URL);
const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';

test('post-broadcast ledger failure leaves signed reservation recoverable and reconciliation completes exactly once', {
  skip: !enabled && 'requires DATABASE_URL'
}, async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  const client = await pool.connect();
  const suffix = crypto.randomUUID().replaceAll('-', '');
  const key = `phase5_recovery_${suffix}`;
  const signature = '5'.repeat(88);

  try {
    await client.query('BEGIN');

    // This is the durable pre-broadcast boundary: the signed signature has
    // been persisted before sendRawTransaction is invoked.
    await client.query(
      `INSERT INTO api_idempotency_keys (
         idempotency_key, request_hash, status, wallet_public_key, operation,
         network, to_public_key, amount_lamports, transaction_signature
       ) VALUES ($1, $2, 'processing', $3, 'withdrawal', 'devnet', $4, 2500, $5)`,
      [key, crypto.createHash('sha256').update(key).digest('hex'), SENDER, RECIPIENT, signature]
    );

    // Simulate a process/database failure after the chain accepted the
    // transaction but before the ledger + idempotency completion commit.
    await client.query('SAVEPOINT post_broadcast_commit');
    await client.query(
      `INSERT INTO blockchain_transactions (
         signature, direction, wallet_public_key, counterparty,
         amount_lamports, fee_lamports, network, commitment, status,
         idempotency_key
       ) VALUES ($1, 'withdrawal', $2, $3, 2500, 5000, 'devnet', 'confirmed', 'confirmed', $4)`,
      [signature, SENDER, RECIPIENT, key]
    );
    await client.query(
      `UPDATE api_idempotency_keys
          SET status = 'completed', response_json = '{"sent":true}'::jsonb
        WHERE idempotency_key = $1 AND status = 'processing'`,
      [key]
    );
    await client.query('ROLLBACK TO SAVEPOINT post_broadcast_commit');
    await client.query('RELEASE SAVEPOINT post_broadcast_commit');

    const afterFailure = await client.query(
      `SELECT status, transaction_signature
         FROM api_idempotency_keys WHERE idempotency_key = $1`,
      [key]
    );
    const missingLedger = await client.query(
      `SELECT COUNT(*)::int AS count FROM blockchain_transactions
        WHERE signature = $1 AND wallet_public_key = $2 AND direction = 'withdrawal'`,
      [signature, SENDER]
    );
    assert.equal(afterFailure.rows[0].status, 'processing');
    assert.equal(afterFailure.rows[0].transaction_signature, signature);
    assert.equal(missingLedger.rows[0].count, 0);

    // Reconciliation is the only recovery path: it verifies chain evidence,
    // inserts the immutable ledger record, and completes the same reservation
    // in one database transaction. Replaying it cannot create another row.
    await client.query(
      `INSERT INTO blockchain_transactions (
         signature, direction, wallet_public_key, counterparty,
         amount_lamports, fee_lamports, network, commitment, status,
         idempotency_key
       ) VALUES ($1, 'withdrawal', $2, $3, 2500, 5000, 'devnet', 'finalized', 'credited', $4)
       ON CONFLICT (signature, wallet_public_key, direction) DO NOTHING`,
      [signature, SENDER, RECIPIENT, key]
    );
    await client.query(
      `UPDATE api_idempotency_keys
          SET status = 'completed', response_json = '{"sent":true,"reconciled":true}'::jsonb
        WHERE idempotency_key = $1
          AND status = 'processing'
          AND transaction_signature = $2`,
      [key, signature]
    );

    const recovered = await client.query(
      `SELECT i.status, i.transaction_signature, COUNT(t.id)::int AS ledger_count
         FROM api_idempotency_keys i
         LEFT JOIN blockchain_transactions t
           ON t.signature = i.transaction_signature
          AND t.wallet_public_key = i.wallet_public_key
          AND t.direction = 'withdrawal'
        WHERE i.idempotency_key = $1
        GROUP BY i.status, i.transaction_signature`,
      [key]
    );
    assert.equal(recovered.rows[0].status, 'completed');
    assert.equal(recovered.rows[0].transaction_signature, signature);
    assert.equal(recovered.rows[0].ledger_count, 1);

    // Idempotent replay of the same reconciliation write.
    await client.query(
      `INSERT INTO blockchain_transactions (
         signature, direction, wallet_public_key, counterparty,
         amount_lamports, fee_lamports, network, commitment, status,
         idempotency_key
       ) VALUES ($1, 'withdrawal', $2, $3, 2500, 5000, 'devnet', 'finalized', 'credited', $4)
       ON CONFLICT (signature, wallet_public_key, direction) DO NOTHING`,
      [signature, SENDER, RECIPIENT, key]
    );
    const duplicateCount = await client.query(
      `SELECT COUNT(*)::int AS count FROM blockchain_transactions
        WHERE signature = $1 AND wallet_public_key = $2 AND direction = 'withdrawal'`,
      [signature, SENDER]
    );
    assert.equal(duplicateCount.rows[0].count, 1);
    await client.query('ROLLBACK');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
});
