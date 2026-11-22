-- Durable, restart-safe reconciliation for previously confirmed native SOL deposits.
-- This records verification history only; it never mutates wallet balances.
CREATE TABLE IF NOT EXISTS deposit_reconciliation_cursors (
    network TEXT PRIMARY KEY CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    last_transaction_id BIGINT NOT NULL DEFAULT 0 CHECK (last_transaction_id >= 0),
    last_run_at TIMESTAMPTZ,
    last_error TEXT,
    status TEXT NOT NULL DEFAULT 'idle'
        CHECK (status IN ('idle', 'running', 'error')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS deposit_reconciliation_events (
    id BIGSERIAL PRIMARY KEY,
    transaction_id BIGINT NOT NULL REFERENCES blockchain_transactions(id) ON DELETE RESTRICT,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    outcome TEXT NOT NULL CHECK (outcome IN ('consistent', 'under_review', 'recovered', 'rpc_error')),
    previous_status TEXT NOT NULL,
    resulting_status TEXT,
    details JSONB NOT NULL DEFAULT '{}'::jsonb,
    checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_deposit_reconciliation_events_transaction
    ON deposit_reconciliation_events(transaction_id, checked_at DESC);
CREATE INDEX IF NOT EXISTS idx_deposit_reconciliation_events_network
    ON deposit_reconciliation_events(network, checked_at DESC);

-- Reconciliation evidence is append-only at the database layer.
CREATE OR REPLACE FUNCTION forbid_deposit_reconciliation_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'deposit_reconciliation_events are append-only (event id %)', OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_deposit_reconciliation_events_immutable
    ON deposit_reconciliation_events;

CREATE TRIGGER trg_deposit_reconciliation_events_immutable
    BEFORE UPDATE OR DELETE ON deposit_reconciliation_events
    FOR EACH ROW
    EXECUTE FUNCTION forbid_deposit_reconciliation_event_mutation();
