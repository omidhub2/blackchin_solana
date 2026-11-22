-- Phase 2 hardening (additive).
--
-- 1) Recovery tokens become auditable and revocable server-side:
--    the SHA-256 of the issued token and its expiry are recorded on the root
--    row, so redemption is bound to this wallet and can be made atomic.
-- 2) Deposit scanner cursors (per network + scope).
-- 3) Transactional outbox for reliable consumer notifications.
-- 4) Shared (PostgreSQL) rate limiting.

ALTER TABLE hd_wallets
    ADD COLUMN IF NOT EXISTS recovery_token_hash CHAR(64);
ALTER TABLE hd_wallets
    ADD COLUMN IF NOT EXISTS recovery_token_expires_at TIMESTAMPTZ;

-- The token hash is only meaningful together with its expiry; both are cleared
-- when the phrase is provisioned.
CREATE INDEX IF NOT EXISTS idx_hd_wallets_recovery_token_hash
    ON hd_wallets(recovery_token_hash);

-- ---------------------------------------------------------------------------
-- Deposit scanner state
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS deposit_scanner_cursors (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    scope TEXT NOT NULL,
    -- Stable position: the newest fully processed signature and its slot.
    last_signature TEXT,
    last_slot BIGINT,
    last_block_time TIMESTAMPTZ,
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'error', 'stopped')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_deposit_scanner_cursors_network_scope UNIQUE (network, scope)
);

CREATE INDEX IF NOT EXISTS idx_deposit_scanner_cursors_status
    ON deposit_scanner_cursors(status);

-- Advisory lock helper for scanner ownership: one scanner per (network, scope).
-- Kept in code (pg_advisory_lock) rather than in the schema.

-- ---------------------------------------------------------------------------
-- Transactional outbox
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS webhook_outbox (
    id BIGSERIAL PRIMARY KEY,
    event_id UUID NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    wallet_public_key TEXT,
    hd_wallet_id BIGINT REFERENCES hd_wallets(id) ON DELETE SET NULL,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
        CHECK (status IN ('pending', 'delivering', 'delivered', 'failed', 'discarded')),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    max_attempts INTEGER NOT NULL DEFAULT 8 CHECK (max_attempts > 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    last_http_status INTEGER,
    last_error TEXT,
    delivered_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_webhook_outbox_due
    ON webhook_outbox(status, next_attempt_at);
CREATE INDEX IF NOT EXISTS idx_webhook_outbox_wallet
    ON webhook_outbox(wallet_public_key, created_at DESC);

-- ---------------------------------------------------------------------------
-- Shared rate limiting (multi-instance safe, no Redis dependency)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS rate_limit_counters (
    bucket_key TEXT PRIMARY KEY,
    window_started_at TIMESTAMPTZ NOT NULL,
    window_ends_at TIMESTAMPTZ NOT NULL,
    hit_count INTEGER NOT NULL CHECK (hit_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limit_counters_expiry
    ON rate_limit_counters(window_ends_at);

-- ---------------------------------------------------------------------------
-- Ledger immutability (enforced at the database layer)
--
-- Identity and monetary columns are written once. Only lifecycle/confirmation
-- columns may advance. This converts the earlier "policy-only" immutability
-- into an enforced invariant for every application role.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enforce_blockchain_transaction_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
       OR NEW.amount_lamports IS DISTINCT FROM OLD.amount_lamports
       OR NEW.fee_lamports IS DISTINCT FROM OLD.fee_lamports
       OR NEW.network IS DISTINCT FROM OLD.network THEN
        RAISE EXCEPTION
            'blockchain_transactions identity and amounts are immutable (row id %)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blockchain_transactions_immutable ON blockchain_transactions;

CREATE TRIGGER trg_blockchain_transactions_immutable
    BEFORE UPDATE ON blockchain_transactions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_blockchain_transaction_immutability();
