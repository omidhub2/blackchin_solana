-- Phase 6: targeted partial indexes for operational health/backlog probes.
-- These keep public readiness checks bounded as financial/event tables grow.

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_observability_pending
    ON public.webhook_outbox(created_at)
    WHERE status IN ('pending', 'failed', 'delivering');

CREATE INDEX IF NOT EXISTS idx_api_idempotency_observability_signed_withdrawals
    ON public.api_idempotency_keys(updated_at)
    WHERE operation = 'withdrawal'
      AND status = 'processing'
      AND transaction_signature IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_observability_under_review
    ON public.blockchain_transactions(created_at)
    WHERE status = 'under_review';

CREATE INDEX IF NOT EXISTS idx_deposit_reconciliation_observability_under_review
    ON public.deposit_reconciliation_events(checked_at)
    WHERE outcome = 'under_review';

CREATE INDEX IF NOT EXISTS idx_withdrawal_reconciliation_observability_under_review
    ON public.withdrawal_reconciliation_events(checked_at)
    WHERE outcome = 'under_review';
