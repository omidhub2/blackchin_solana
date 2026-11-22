-- Dashboard identity, durable real-time operational events, tenant webhook
-- endpoints and the hot-wallet registry.
--
-- Additive only. No existing row is reassigned and no partner customer
-- accounting data is introduced. Operational events are append-only and exist
-- so a reconnecting dashboard client can replay updates it missed; they are
-- not a financial ledger.

-- ---------------------------------------------------------------------------
-- Dashboard operators (separate from partner API credentials)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS dashboard_users (
    id BIGSERIAL PRIMARY KEY,
    email VARCHAR(320) NOT NULL,
    display_name VARCHAR(160) NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'viewer'
        CHECK (role IN ('admin', 'operator', 'viewer')),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    last_login_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_dashboard_users_email CHECK (email = lower(btrim(email)))
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_dashboard_users_email
    ON dashboard_users(email);

CREATE TABLE IF NOT EXISTS dashboard_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES dashboard_users(id) ON DELETE CASCADE,
    token_hash BYTEA NOT NULL CHECK (octet_length(token_hash) = 32),
    csrf_token_hash BYTEA NOT NULL CHECK (octet_length(csrf_token_hash) = 32),
    expires_at TIMESTAMPTZ NOT NULL,
    last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    revoked_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_dashboard_sessions_token UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_user_active
    ON dashboard_sessions(user_id, expires_at DESC)
    WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_dashboard_sessions_expiry
    ON dashboard_sessions(expires_at);

-- ---------------------------------------------------------------------------
-- Durable operational events (dashboard real-time + activity log)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS operational_events (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    tenant_id BIGINT REFERENCES tenants(id) ON DELETE RESTRICT,
    event_type VARCHAR(64) NOT NULL,
    network VARCHAR(32),
    wallet_public_key VARCHAR(64),
    hd_wallet_id BIGINT,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb
        CHECK (jsonb_typeof(payload) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_operational_events_cursor
    ON operational_events(id);

CREATE INDEX IF NOT EXISTS idx_operational_events_tenant_cursor
    ON operational_events(tenant_id, id DESC);

CREATE INDEX IF NOT EXISTS idx_operational_events_type_cursor
    ON operational_events(event_type, id DESC);

CREATE OR REPLACE FUNCTION prevent_operational_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'operational events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_operational_events_immutable ON operational_events;
CREATE TRIGGER trg_operational_events_immutable
    BEFORE UPDATE OR DELETE ON operational_events
    FOR EACH ROW EXECUTE FUNCTION prevent_operational_event_mutation();

-- ---------------------------------------------------------------------------
-- Tenant webhook endpoints (secret encrypted with the wallet cipher)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS tenant_webhook_endpoints (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    endpoint_url TEXT NOT NULL CHECK (length(endpoint_url) BETWEEN 8 AND 2048),
    secret_encrypted TEXT NOT NULL,
    secret_iv TEXT NOT NULL,
    secret_auth_tag TEXT NOT NULL,
    encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
    event_types TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'disabled')),
    rotated_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_tenant_webhook_endpoint UNIQUE (tenant_id, endpoint_url),
    UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS idx_tenant_webhook_endpoints_active
    ON tenant_webhook_endpoints(tenant_id, status);

-- ---------------------------------------------------------------------------
-- Hot wallet registry
--
-- A hot wallet is an explicitly designated, policy-bound operational signer.
-- It references a tenant-owned HD child account; the private material remains
-- in the existing encrypted HD root and is never copied into this table.
-- ---------------------------------------------------------------------------

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_accounts_tenant_id_id
    ON wallet_accounts(tenant_id, id);

CREATE TABLE IF NOT EXISTS hot_wallets (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT NOT NULL REFERENCES tenants(id) ON DELETE RESTRICT,
    hd_wallet_id BIGINT NOT NULL,
    wallet_account_id BIGINT NOT NULL,
    public_key VARCHAR(64) NOT NULL,
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    label VARCHAR(100),
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'frozen', 'disabled')),
    signing_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    max_single_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_single_lamports >= 0),
    freeze_reason VARCHAR(500),
    created_by VARCHAR(320),
    frozen_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (tenant_id, public_key),
    UNIQUE (tenant_id, id),
    FOREIGN KEY (tenant_id, hd_wallet_id)
        REFERENCES hd_wallets(tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (tenant_id, wallet_account_id)
        REFERENCES wallet_accounts(tenant_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (public_key)
        REFERENCES wallet_accounts(public_key) ON DELETE RESTRICT,
    CHECK ((status <> 'frozen') OR freeze_reason IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_hot_wallets_tenant_status
    ON hot_wallets(tenant_id, status);

-- A designated hot wallet cannot silently change its tenant, account or
-- public key after registration.
CREATE OR REPLACE FUNCTION prevent_hot_wallet_rebinding()
RETURNS TRIGGER AS $$
BEGIN
    IF OLD.tenant_id IS DISTINCT FROM NEW.tenant_id
       OR OLD.hd_wallet_id IS DISTINCT FROM NEW.hd_wallet_id
       OR OLD.wallet_account_id IS DISTINCT FROM NEW.wallet_account_id
       OR OLD.public_key IS DISTINCT FROM NEW.public_key
       OR OLD.network IS DISTINCT FROM NEW.network THEN
        RAISE EXCEPTION 'hot wallet binding is immutable'
            USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_hot_wallets_binding_immutable ON hot_wallets;
CREATE TRIGGER trg_hot_wallets_binding_immutable
    BEFORE UPDATE ON hot_wallets
    FOR EACH ROW EXECUTE FUNCTION prevent_hot_wallet_rebinding();