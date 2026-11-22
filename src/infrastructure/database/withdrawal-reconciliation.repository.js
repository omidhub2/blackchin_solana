/** Durable keyset cursor, append-only evidence and cluster lock for withdrawals. */

export async function ensureWithdrawalReconciliationCursor(db, network) {
  const result = await db.query(
    `INSERT INTO withdrawal_reconciliation_cursors (network)
     VALUES ($1) ON CONFLICT (network) DO UPDATE
       SET updated_at = withdrawal_reconciliation_cursors.updated_at
     RETURNING network, last_id, status`,
    [network]
  );
  return {
    network: result.rows[0].network,
    lastId: String(result.rows[0].last_id),
    status: result.rows[0].status
  };
}

export async function listWithdrawalReconciliationCandidates(db, network, afterId, limit) {
  const result = await db.query(
    `SELECT id, idempotency_key, wallet_public_key, transaction_signature,
            status, operation, response_json, created_at, updated_at
       FROM api_idempotency_keys
      WHERE operation = 'withdrawal'
        AND status = 'processing'
        AND id > $2
        AND (
          transaction_signature IS NOT NULL
          OR (transaction_signature IS NULL AND created_at <= NOW() - INTERVAL '5 minutes')
        )
      ORDER BY id ASC
      LIMIT $3`,
    [network, afterId, limit]
  );
  return result.rows;
}

export async function recordWithdrawalReconciliationEvent(db, {
  idempotencyKey, network, signature = null, outcome, details = {}
}) {
  const result = await db.query(
    `INSERT INTO withdrawal_reconciliation_events
       (idempotency_key, network, signature, outcome, details)
     VALUES ($1, $2, $3, $4, $5::jsonb)
     RETURNING id, checked_at`,
    [idempotencyKey, network, signature, outcome, JSON.stringify(details)]
  );
  return { id: String(result.rows[0].id), checkedAt: result.rows[0].checked_at };
}

export async function advanceWithdrawalReconciliationCursor(db, network, id) {
  await db.query(
    `UPDATE withdrawal_reconciliation_cursors
        SET last_id = $2, last_run_at = NOW(), last_error = NULL,
            status = 'running', updated_at = NOW()
      WHERE network = $1`,
    [network, id]
  );
}

export async function completeWithdrawalReconciliationCycle(db, network) {
  await db.query(
    `UPDATE withdrawal_reconciliation_cursors
        SET last_id = 0, last_run_at = NOW(), last_error = NULL,
            status = 'idle', updated_at = NOW()
      WHERE network = $1`,
    [network]
  );
}

export async function markWithdrawalReconciliationError(db, network, message) {
  await db.query(
    `UPDATE withdrawal_reconciliation_cursors
        SET last_error = $2, status = 'error', updated_at = NOW()
      WHERE network = $1`,
    [network, String(message ?? 'unknown error').slice(0, 500)]
  );
}

export async function acquireWithdrawalReconciliationLock(client, network) {
  const result = await client.query(
    'SELECT pg_try_advisory_lock(hashtext($1)::bigint) AS acquired',
    [`blackchin:withdrawal-reconciliation:${network}`]
  );
  return result.rows[0]?.acquired === true
    ? {
        release: async () => {
          await client.query(
            'SELECT pg_advisory_unlock(hashtext($1)::bigint)',
            [`blackchin:withdrawal-reconciliation:${network}`]
          ).catch(() => {});
        }
      }
    : null;
}
