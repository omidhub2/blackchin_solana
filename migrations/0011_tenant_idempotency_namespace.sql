-- Tenant-scoped idempotency keys while preserving uniqueness for legacy rows.
-- Existing rows are not reassigned; tenant_id NULL remains the legacy namespace.

DO $$
DECLARE constraint_name TEXT;
BEGIN
  SELECT c.conname INTO constraint_name
    FROM pg_constraint c
   WHERE c.conrelid = 'api_idempotency_keys'::regclass
     AND c.contype = 'u'
     AND (SELECT array_agg(a.attname ORDER BY a.attname)
            FROM unnest(c.conkey) AS key(attnum)
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = key.attnum)
         = ARRAY['idempotency_key']::name[]
   LIMIT 1;
  IF constraint_name IS NOT NULL THEN
    EXECUTE format('ALTER TABLE api_idempotency_keys DROP CONSTRAINT %I', constraint_name);
  END IF;
END;
$$;

ALTER TABLE api_idempotency_keys
  ADD COLUMN IF NOT EXISTS tenant_credential_id BIGINT,
  ADD COLUMN IF NOT EXISTS approval_reference VARCHAR(128);

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_api_idempotency_tenant_credential') THEN
    ALTER TABLE api_idempotency_keys
      ADD CONSTRAINT fk_api_idempotency_tenant_credential
      FOREIGN KEY (tenant_id, tenant_credential_id)
      REFERENCES tenant_api_credentials(tenant_id, id)
      ON DELETE RESTRICT;
  END IF;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'chk_api_idempotency_tenant_credential') THEN
    ALTER TABLE api_idempotency_keys
      ADD CONSTRAINT chk_api_idempotency_tenant_credential
      CHECK (tenant_credential_id IS NULL OR tenant_id IS NOT NULL);
  END IF;
END;
$$;
-- Keep one globally unique namespace for legacy/unassigned records.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_idempotency_legacy_key
  ON api_idempotency_keys(idempotency_key)
  WHERE tenant_id IS NULL;

-- Tenant keys are unique only within their owning tenant.
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_idempotency_tenant_key
  ON api_idempotency_keys(tenant_id, idempotency_key);

-- Fast tenant-scoped withdrawal reconciliation and status queries.
CREATE INDEX IF NOT EXISTS idx_api_idempotency_tenant_withdrawal_processing
  ON api_idempotency_keys(tenant_id, network, id)
  WHERE operation = 'withdrawal' AND status = 'processing';
