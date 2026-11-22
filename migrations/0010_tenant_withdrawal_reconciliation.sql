-- Tenant attribution for Solana withdrawal reconciliation evidence.
--
-- Legacy reconciliation rows stay tenant_id NULL. New tenant-aware workers
-- must write the same tenant_id as their idempotency record. The existing
-- globally unique idempotency_key constraint is deliberately retained in this
-- migration so the current single-credential withdrawal runtime is not broken.
-- Per-tenant idempotency-key semantics are enabled only with the corresponding
-- service and foreign-key transition in a later coordinated change.

ALTER TABLE withdrawal_reconciliation_events
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

-- A composite unique key provides a database-enforced tenant binding for
-- reconciliation evidence. The original globally unique key remains intact
-- during this compatibility phase.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_idempotency_tenant_key
    ON api_idempotency_keys(tenant_id, idempotency_key);

-- Replace the legacy single-column FK with a tenant-aware composite FK.
-- MATCH SIMPLE semantics intentionally allow historical rows whose tenant_id
-- is NULL to remain unchanged and readable.
DO $$
DECLARE
    fk_name TEXT;
BEGIN
    SELECT c.conname
      INTO fk_name
      FROM pg_constraint c
     WHERE c.conrelid = 'withdrawal_reconciliation_events'::regclass
       AND c.confrelid = 'api_idempotency_keys'::regclass
       AND c.contype = 'f'
     LIMIT 1;

    IF fk_name IS NOT NULL THEN
        EXECUTE format(
            'ALTER TABLE withdrawal_reconciliation_events DROP CONSTRAINT %I',
            fk_name
        );
    END IF;
END;
$$;

ALTER TABLE withdrawal_reconciliation_events
    ADD CONSTRAINT fk_withdrawal_reconciliation_tenant_idempotency
    FOREIGN KEY (tenant_id, idempotency_key)
    REFERENCES api_idempotency_keys(tenant_id, idempotency_key)
    ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_withdrawal_reconciliation_events_tenant_checked
    ON withdrawal_reconciliation_events(tenant_id, checked_at DESC);
