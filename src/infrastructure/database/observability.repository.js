/** Aggregate operational backlog signals for readiness and alerting. */
export async function getOperationalBacklog(db) {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::int FROM webhook_outbox
         WHERE status IN ('pending', 'failed', 'delivering')) AS webhook_pending,
       (SELECT COUNT(*)::int FROM api_idempotency_keys
         WHERE operation = 'withdrawal' AND status = 'processing'
           AND transaction_signature IS NOT NULL) AS signed_withdrawals_pending,
       (SELECT COUNT(*)::int FROM blockchain_transactions
         WHERE status = 'under_review') AS ledger_under_review,
       (SELECT COUNT(*)::int FROM (
          SELECT DISTINCT ON (transaction_id) transaction_id, outcome
            FROM deposit_reconciliation_events
           ORDER BY transaction_id, checked_at DESC, id DESC
        ) latest_deposits WHERE outcome = 'under_review') AS deposit_reconciliation_under_review,
       (SELECT COUNT(*)::int FROM (
          SELECT DISTINCT ON (idempotency_key) idempotency_key, outcome
            FROM withdrawal_reconciliation_events
           ORDER BY idempotency_key, checked_at DESC, id DESC
        ) latest_withdrawals WHERE outcome = 'under_review') AS withdrawal_reconciliation_under_review,
       (SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(created_at)), 0)::int
          FROM webhook_outbox
         WHERE status IN ('pending', 'failed', 'delivering')) AS oldest_webhook_age_seconds,
       (SELECT COALESCE(EXTRACT(EPOCH FROM NOW() - MIN(updated_at)), 0)::int
          FROM api_idempotency_keys
         WHERE operation = 'withdrawal' AND status = 'processing'
           AND transaction_signature IS NOT NULL) AS oldest_signed_withdrawal_age_seconds`
  );
  const row = result.rows[0] ?? {};
  return {
    webhookPending: Number(row.webhook_pending ?? 0),
    signedWithdrawalsPending: Number(row.signed_withdrawals_pending ?? 0),
    ledgerUnderReview: Number(row.ledger_under_review ?? 0),
    depositReconciliationUnderReview: Number(row.deposit_reconciliation_under_review ?? 0),
    withdrawalReconciliationUnderReview: Number(row.withdrawal_reconciliation_under_review ?? 0),
    oldestWebhookAgeSeconds: Number(row.oldest_webhook_age_seconds ?? 0),
    oldestSignedWithdrawalAgeSeconds: Number(row.oldest_signed_withdrawal_age_seconds ?? 0)
  };
}
