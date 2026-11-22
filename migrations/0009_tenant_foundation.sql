-- Tenant registry and credential foundation.
--
-- This migration is intentionally additive. It creates the tenant identity and
-- hashed credential tables and adds nullable tenant attribution columns to
-- existing operational records. Existing rows remain unassigned; ownership
-- must never be guessed or backfilled without verified evidence.
--
-- API authentication and mandatory tenant enforcement are implemented in a
-- later phase. Until then, the existing single-credential API remains the only
-- supported runtime mode and must not be exposed as a multi-tenant service.

CREATE TABLE IF NOT EXISTS tenants (
    id BIGSERIAL PRIMARY KEY,
    tenant_code VARCHAR(64) NOT NULL UNIQUE
        CHECK (tenant_code ~ '^[a-zA-Z0-9][a-zA-Z0-9._-]{1,63}$'),
    display_name VARCHAR(160) NOT NULL
        CHECK (length(btrim(display_name)) BETWEEN 1 AND 160),
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'suspended', 'disabled')),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenants_status
    ON tenants(status);

CREATE TABLE IF NOT EXISTS tenant_api_credentials (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL
        REFERENCES tenants(id) ON DELETE RESTRICT,
    key_prefix VARCHAR(32) NOT NULL UNIQUE
        CHECK (key_prefix ~ '^[A-Za-z0-9_-]{8,32}$'),
    secret_hash BYTEA NOT NULL
        CHECK (octet_length(secret_hash) = 32),
    scopes TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
    expires_at TIMESTAMPTZ,
    last_used_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_api_credentials_tenant_id UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_api_credentials_tenant_status
    ON tenant_api_credentials(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_tenant_api_credentials_expiry
    ON tenant_api_credentials(expires_at)
    WHERE status = 'active';

-- Nullable during the transition: legacy records have no provable tenant
-- identity. New tenant-aware application paths must write tenant_id explicitly.
ALTER TABLE wallets
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE hd_wallets
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE wallet_accounts
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE blockchain_transactions
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

ALTER TABLE webhook_outbox
    ADD COLUMN IF NOT EXISTS tenant_id BIGINT
        REFERENCES tenants(id) ON DELETE RESTRICT;

-- Composite parent identity allows later constraints to prove that a child
-- wallet account belongs to the same tenant as its HD root.
CREATE UNIQUE INDEX IF NOT EXISTS uq_hd_wallets_tenant_id_id
    ON hd_wallets(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_wallets_tenant_id
    ON wallets(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_hd_wallets_tenant_id
    ON hd_wallets(tenant_id, id);

CREATE INDEX IF NOT EXISTS idx_wallet_accounts_tenant_id
    ON wallet_accounts(tenant_id, hd_wallet_id, account_index);

CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_tenant_created
    ON blockchain_transactions(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_api_idempotency_keys_tenant_created
    ON api_idempotency_keys(tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_tenant_status
    ON webhook_outbox(tenant_id, status, next_attempt_at);


-- For HD-derived records, the tenant must match the parent root. NULL tenant
-- values remain valid only for legacy/unassigned rows during migration.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_wallet_accounts_tenant_hd_wallet'
    ) THEN
        ALTER TABLE wallet_accounts
            ADD CONSTRAINT fk_wallet_accounts_tenant_hd_wallet
            FOREIGN KEY (tenant_id, hd_wallet_id)
            REFERENCES hd_wallets(tenant_id, id)
            ON DELETE RESTRICT;
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'fk_blockchain_transactions_tenant_hd_wallet'
    ) THEN
        ALTER TABLE blockchain_transactions
            ADD CONSTRAINT fk_blockchain_transactions_tenant_hd_wallet
            FOREIGN KEY (tenant_id, hd_wallet_id)
            REFERENCES hd_wallets(tenant_id, id)
            ON DELETE RESTRICT;
    END IF;
END;
$$;;

-- When a tenant is assigned to a record, its ownership binding cannot be
-- silently changed later. NULL -> tenant assignment remains possible for a
-- controlled, verified legacy-data migration.
CREATE OR REPLACE FUNCTION prevent_tenant_reassignment()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.tenant_id IS NOT NULL
       AND NEW.tenant_id IS DISTINCT FROM OLD.tenant_id THEN
        RAISE EXCEPTION
            'tenant ownership is immutable for table % row %',
            TG_TABLE_NAME, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;


DROP TRIGGER IF EXISTS trg_tenant_api_credentials_tenant_immutable ON tenant_api_credentials;
CREATE TRIGGER trg_tenant_api_credentials_tenant_immutable
    BEFORE UPDATE OF tenant_id ON tenant_api_credentials
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_wallets_tenant_immutable ON wallets;
CREATE TRIGGER trg_wallets_tenant_immutable
    BEFORE UPDATE OF tenant_id ON wallets
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_hd_wallets_tenant_immutable ON hd_wallets;
CREATE TRIGGER trg_hd_wallets_tenant_immutable
    BEFORE UPDATE OF tenant_id ON hd_wallets
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_wallet_accounts_tenant_immutable ON wallet_accounts;
CREATE TRIGGER trg_wallet_accounts_tenant_immutable
    BEFORE UPDATE OF tenant_id ON wallet_accounts
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_blockchain_transactions_tenant_immutable ON blockchain_transactions;
CREATE TRIGGER trg_blockchain_transactions_tenant_immutable
    BEFORE UPDATE OF tenant_id ON blockchain_transactions
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_api_idempotency_keys_tenant_immutable ON api_idempotency_keys;
CREATE TRIGGER trg_api_idempotency_keys_tenant_immutable
    BEFORE UPDATE OF tenant_id ON api_idempotency_keys
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();

DROP TRIGGER IF EXISTS trg_webhook_outbox_tenant_immutable ON webhook_outbox;
CREATE TRIGGER trg_webhook_outbox_tenant_immutable
    BEFORE UPDATE OF tenant_id ON webhook_outbox
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_reassignment();
