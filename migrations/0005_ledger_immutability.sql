-- Phase 2 hardening (additive): ledger immutability that is actually enforced.
--
-- 0004 installed a BEFORE UPDATE trigger that rejects changes to the identity
-- and monetary columns of blockchain_transactions. That keeps UPDATE paths
-- honest but does not stop a DELETE, and it does not stop a session that owns
-- the table (an owner can disable the trigger).
--
-- This migration adds the missing DELETE guard and makes the enforcement
-- self-documenting for the application role.
--
-- Notes on behaviour:
--  * The app role must still be able to UPDATE lifecycle/confirmation columns
--    (status, commitment, slot, block_time, failure_reason, metadata,
--    updated_at); statuses of a recorded transaction legitimately advance
--    (detected -> confirming -> confirmed). The trigger in 0004 allows exactly
--    that and rejects the rest.
--  * Idempotent: safe to re-run (CREATE OR REPLACE + DROP/CREATE TRIGGER +
--    IF NOT EXISTS).
--  * No EXCEPTION blocks: a violation must abort the statement and let the
--    caller's transaction roll back.
--  * If you need a retention process to physically remove ledger rows, do it
--    deliberately with an explicit, logged maintenance statement that disables
--    the trigger for its own transaction; never through the application role.

-- ---------------------------------------------------------------------------
-- UPDATE guard (idempotent re-install; keeps 0004 semantics)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION enforce_blockchain_transaction_immutability()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.signature        IS DISTINCT FROM OLD.signature
       OR NEW.direction     IS DISTINCT FROM OLD.direction
       OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
       OR NEW.amount_lamports   IS DISTINCT FROM OLD.amount_lamports
       OR NEW.fee_lamports      IS DISTINCT FROM OLD.fee_lamports
       OR NEW.network           IS DISTINCT FROM OLD.network THEN
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

-- ---------------------------------------------------------------------------
-- DELETE guard
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION forbid_blockchain_transaction_delete()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION
        'blockchain_transactions rows cannot be deleted (row id %); record a compensating event instead',
        OLD.id
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_blockchain_transactions_no_delete ON blockchain_transactions;

CREATE TRIGGER trg_blockchain_transactions_no_delete
    BEFORE DELETE ON blockchain_transactions
    FOR EACH ROW
    EXECUTE FUNCTION forbid_blockchain_transaction_delete();
