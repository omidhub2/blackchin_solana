-- Tenant withdrawal policy data model (Solana native SOL only).
-- All tenants start disabled. This migration does not grant the API role
-- permission to create approvals or modify policy; a separately authenticated
-- control-plane/admin workflow and DB grants are required before use.

CREATE TABLE IF NOT EXISTS tenant_withdrawal_policies (
    tenant_id BIGINT PRIMARY KEY REFERENCES tenants(id) ON DELETE RESTRICT,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    emergency_frozen BOOLEAN NOT NULL DEFAULT TRUE,
    freeze_reason VARCHAR(500),
    max_single_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_single_lamports >= 0),
    max_daily_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_daily_lamports >= 0),
    max_weekly_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_weekly_lamports >= 0),
    max_daily_count INTEGER NOT NULL DEFAULT 0 CHECK (max_daily_count >= 0),
    max_weekly_count INTEGER NOT NULL DEFAULT 0 CHECK (max_weekly_count >= 0),
    policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version > 0),
    updated_by VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((emergency_frozen = FALSE) OR freeze_reason IS NOT NULL OR enabled = FALSE),
    CHECK (max_daily_lamports = 0 OR max_weekly_lamports = 0
           OR max_weekly_lamports >= max_daily_lamports),
    CHECK (max_single_lamports = 0 OR max_daily_lamports = 0
           OR max_single_lamports <= max_daily_lamports)
);

CREATE TABLE IF NOT EXISTS tenant_withdrawal_destinations (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    asset VARCHAR(16) NOT NULL DEFAULT 'SOL' CHECK (asset = 'SOL'),
    destination_public_key VARCHAR(64) NOT NULL
        CHECK (destination_public_key ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
    status VARCHAR(16) NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'active', 'revoked')),
    label VARCHAR(100),
    created_by VARCHAR(128),
    approved_by VARCHAR(128),
    approved_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, network, asset, destination_public_key),
    UNIQUE (tenant_id, id),
    CHECK ((status <> 'active') OR (approved_by IS NOT NULL AND approved_at IS NOT NULL)),
    CHECK ((status <> 'revoked') OR revoked_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tenant_withdrawal_destinations_active
    ON tenant_withdrawal_destinations(tenant_id, network, destination_public_key)
    WHERE status = 'active';

CREATE TABLE IF NOT EXISTS tenant_withdrawal_approvals (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL,
    credential_id BIGINT NOT NULL,
    approval_reference VARCHAR(128) NOT NULL
        CHECK (approval_reference ~ '^[A-Za-z0-9._:-]{8,128}$'),
    request_hash CHAR(64) NOT NULL CHECK (request_hash ~ '^[a-f0-9]{64}$'),
    wallet_public_key VARCHAR(64) NOT NULL,
    destination_public_key VARCHAR(64) NOT NULL,
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    asset VARCHAR(16) NOT NULL DEFAULT 'SOL' CHECK (asset = 'SOL'),
    amount_lamports NUMERIC(30, 0) NOT NULL CHECK (amount_lamports > 0),
    status VARCHAR(16) NOT NULL DEFAULT 'approved'
        CHECK (status IN ('approved', 'consumed', 'revoked', 'expired')),
    issuer VARCHAR(128) NOT NULL,
    issuer_event_id VARCHAR(128) NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL,
    approved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    consumed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, approval_reference),
    UNIQUE (issuer, issuer_event_id),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, credential_id)
        REFERENCES tenant_api_credentials(tenant_id, id) ON DELETE RESTRICT,
    CHECK ((status <> 'consumed') OR consumed_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_tenant_withdrawal_approvals_lookup
    ON tenant_withdrawal_approvals(tenant_id, approval_reference, status, expires_at);

CREATE TABLE IF NOT EXISTS tenant_withdrawal_policy_events (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    credential_id BIGINT,
    approval_reference VARCHAR(128),
    idempotency_key VARCHAR(128),
    decision VARCHAR(16) NOT NULL
        CHECK (decision IN ('allowed', 'denied', 'frozen', 'limited', 'invalid_approval')),
    reason_code VARCHAR(64) NOT NULL,
    request_hash CHAR(64) CHECK (request_hash IS NULL OR request_hash ~ '^[a-f0-9]{64}$'),
    wallet_public_key VARCHAR(64),
    destination_public_key VARCHAR(64),
    network VARCHAR(32),
    amount_lamports NUMERIC(30, 0),
    policy_version BIGINT,
    correlation_id VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    FOREIGN KEY (tenant_id, credential_id)
        REFERENCES tenant_api_credentials(tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, idempotency_key)
        REFERENCES api_idempotency_keys(tenant_id, idempotency_key) ON DELETE RESTRICT
);

CREATE OR REPLACE FUNCTION prevent_tenant_withdrawal_approval_rebinding()
RETURNS TRIGGER AS $policy$
BEGIN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.credential_id IS DISTINCT FROM NEW.credential_id
       OR OLD.approval_reference IS DISTINCT FROM NEW.approval_reference
       OR OLD.request_hash IS DISTINCT FROM NEW.request_hash
       OR OLD.wallet_public_key IS DISTINCT FROM NEW.wallet_public_key
       OR OLD.destination_public_key IS DISTINCT FROM NEW.destination_public_key
       OR OLD.network IS DISTINCT FROM NEW.network
       OR OLD.asset IS DISTINCT FROM NEW.asset
       OR OLD.amount_lamports IS DISTINCT FROM NEW.amount_lamports
       OR OLD.issuer IS DISTINCT FROM NEW.issuer
       OR OLD.issuer_event_id IS DISTINCT FROM NEW.issuer_event_id
       OR OLD.expires_at IS DISTINCT FROM NEW.expires_at
       OR OLD.approved_at IS DISTINCT FROM NEW.approved_at THEN
        RAISE EXCEPTION 'tenant withdrawal approval binding is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    IF NOT (
        (OLD.status = 'approved' AND NEW.status IN ('consumed', 'revoked', 'expired'))
        OR (OLD.status = NEW.status)
    ) THEN
        RAISE EXCEPTION 'invalid tenant withdrawal approval state transition'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$policy$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_withdrawal_approvals_binding_immutable
    ON tenant_withdrawal_approvals;
CREATE TRIGGER trg_tenant_withdrawal_approvals_binding_immutable
    BEFORE UPDATE ON tenant_withdrawal_approvals
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_withdrawal_approval_rebinding();

CREATE INDEX IF NOT EXISTS idx_tenant_withdrawal_policy_events_tenant_created
    ON tenant_withdrawal_policy_events(tenant_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION prevent_tenant_withdrawal_policy_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'tenant withdrawal policy events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_tenant_withdrawal_policy_events_immutable
    ON tenant_withdrawal_policy_events;
CREATE TRIGGER trg_tenant_withdrawal_policy_events_immutable
    BEFORE UPDATE OR DELETE ON tenant_withdrawal_policy_events
    FOR EACH ROW EXECUTE FUNCTION prevent_tenant_withdrawal_policy_event_mutation();

-- Deliberately do not create policy rows for existing tenants: absence means
-- disabled. Never infer policy, approvals, destination ownership or limits.
