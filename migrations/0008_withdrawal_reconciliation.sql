-- Durable, append-only reconciliation evidence for ambiguous native SOL withdrawals.
-- This migration does not create or modify a monetary reservation/ledger system.

-- Pin each idempotency record to the chain selected when the withdrawal was submitted.
-- Legacy rows remain NULL and are deliberately excluded from automatic reconciliation.
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS network TEXT
        CHECK (network IS NULL OR network IN ('devnet', 'testnet', 'mainnet-beta'));
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS to_public_key TEXT;
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS amount_lamports NUMERIC(30, 0)
        CHECK (amount_lamports IS NULL OR amount_lamports > 0);

CREATE TABLE IF NOT EXISTS withdrawal_reconciliation_cursors (
    id BIGSERIAL PRIMARY KEY,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    last_id BIGINT NOT NULL DEFAULT 0 CHECK (last_id >= 0),
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'error')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_withdrawal_reconciliation_cursors_network UNIQUE (network)
);

CREATE TABLE IF NOT EXISTS withdrawal_reconciliation_events (
    id BIGSERIAL PRIMARY KEY,
    idempotency_key VARCHAR(128) NOT NULL
        REFERENCES api_idempotency_keys(idempotency_key) ON DELETE RESTRICT,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    signature TEXT,
    outcome TEXT NOT NULL CHECK (outcome IN (
        'finalized_success',
        'finalized_failure',
        'pending',
        'unknown',
        'under_review',
        'safe_prebroadcast_failed',
        'rpc_error'
    )),
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_reconciliation_events_key
    ON withdrawal_reconciliation_events(idempotency_key, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_withdrawal_reconciliation_events_network
    ON withdrawal_reconciliation_events(network, checked_at DESC);

CREATE OR REPLACE FUNCTION forbid_withdrawal_reconciliation_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'withdrawal_reconciliation_events are append-only (event id %)', OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_withdrawal_reconciliation_events_immutable
    ON withdrawal_reconciliation_events;

CREATE TRIGGER trg_withdrawal_reconciliation_events_immutable
    BEFORE UPDATE OR DELETE ON withdrawal_reconciliation_events
    FOR EACH ROW
    EXECUTE FUNCTION forbid_withdrawal_reconciliation_event_mutation();
