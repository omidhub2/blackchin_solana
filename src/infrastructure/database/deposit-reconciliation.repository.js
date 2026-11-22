/**
 * Durable reconciliation cursor and append-only verification history.
 */
import { mapBlockchainTransaction } from './blockchain-transaction.repository.js';

export async function ensureReconciliationCursor(db, network) {
  const result = await db.query(
    `INSERT INTO deposit_reconciliation_cursors (network)
     VALUES ($1) ON CONFLICT (network) DO UPDATE
     SET updated_at = deposit_reconciliation_cursors.updated_at
     RETURNING network, last_transaction_id, status`,
    [network]
  );
  const row = result.rows[0];
  return {
    network: row.network,
    lastTransactionId: String(row.last_transaction_id),
    status: row.status
  };
}

export async function listReconciliationCandidates(db, network, afterId, limit) {
  const result = await db.query(
    `SELECT id, tenant_id, signature, direction, wallet_public_key, hd_wallet_id,
            counterparty, amount_lamports, fee_lamports, network, commitment,
            status, slot, block_time, failure_reason, idempotency_key,
            metadata, created_at, updated_at
       FROM blockchain_transactions
      WHERE network = $1
        AND direction = 'deposit'
        AND status IN ('confirming', 'confirmed', 'credited', 'under_review')
        AND id > $2
      ORDER BY id ASC
      LIMIT $3`,
    [network, afterId, limit]
  );
  return result.rows.map(mapBlockchainTransaction);
}

export async function recordReconciliationEvent(db, {
  transactionId, network, outcome, previousStatus, resultingStatus, details = {}
}) {
  const result = await db.query(
    `INSERT INTO deposit_reconciliation_events
       (transaction_id, network, outcome, previous_status, resulting_status, details)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb)
     RETURNING id, checked_at`,
    [transactionId, network, outcome, previousStatus, resultingStatus, JSON.stringify(details)]
  );
  return { id: String(result.rows[0].id), checkedAt: result.rows[0].checked_at };
}

/**
 * Atomically append a reconciliation event and advance its keyset cursor.
 * A single PostgreSQL statement guarantees both effects commit or neither does.
 */
export async function recordEventAndAdvanceCursor(db, {
  transactionId, network, outcome, previousStatus, resultingStatus, details = {}
}) {
  const result = await db.query(
    `WITH advanced AS (
       UPDATE deposit_reconciliation_cursors
          SET last_transaction_id = $1, last_run_at = NOW(),
              last_error = NULL, status = 'running', updated_at = NOW()
        WHERE network = $2
        RETURNING network
     )
     INSERT INTO deposit_reconciliation_events
       (transaction_id, network, outcome, previous_status, resulting_status, details)
     SELECT $1, advanced.network, $3, $4, $5, $6::jsonb
       FROM advanced
     RETURNING id, checked_at`,
    [transactionId, network, outcome, previousStatus, resultingStatus, JSON.stringify(details)]
  );

  if (result.rowCount !== 1) {
    throw new Error('Reconciliation event and cursor could not be committed atomically');
  }

  return { id: String(result.rows[0].id), checkedAt: result.rows[0].checked_at };
}

export async function advanceReconciliationCursor(db, network, transactionId) {
  await db.query(
    `UPDATE deposit_reconciliation_cursors
        SET last_transaction_id = $2, last_run_at = NOW(),
            last_error = NULL, status = 'running', updated_at = NOW()
      WHERE network = $1`,
    [network, transactionId]
  );
}

export async function completeReconciliationCycle(db, network) {
  await db.query(
    `UPDATE deposit_reconciliation_cursors
        SET last_transaction_id = 0, last_run_at = NOW(),
            last_error = NULL, status = 'idle', updated_at = NOW()
      WHERE network = $1`,
    [network]
  );
}

export async function markReconciliationError(db, network, message) {
  await db.query(
    `UPDATE deposit_reconciliation_cursors
        SET last_error = $2, status = 'error', updated_at = NOW()
      WHERE network = $1`,
    [network, String(message ?? 'unknown error').slice(0, 500)]
  );
}

export async function acquireReconciliationLock(client, network) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
    [`blackchin:deposit-reconciliation:${network}`]
  );
  return result.rows[0]?.acquired === true
    ? { release: async () => {
        await client.query(
          'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
          [`blackchin:deposit-reconciliation:${network}`]
        ).catch(() => {});
      } }
    : null;
}
