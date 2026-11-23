-- Phase 3: immutable ledger identity, monotonic transaction state and
-- single in-flight withdrawal per source wallet.
--
-- The partial unique indexes are durable per-wallet serialization guards.
-- A signed/ambiguous withdrawal remains 'processing' until reconciliation,
-- intentionally preventing a second send from that wallet.

DO $preflight$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.api_idempotency_keys
         WHERE operation = 'withdrawal'
           AND status = 'processing'
           AND tenant_id IS NOT NULL
           AND wallet_public_key IS NOT NULL
         GROUP BY tenant_id, wallet_public_key
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot install tenant withdrawal serialization: duplicate processing withdrawals exist per tenant wallet; reconcile them first'
            USING ERRCODE = 'unique_violation';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.api_idempotency_keys
         WHERE operation = 'withdrawal'
           AND status = 'processing'
           AND tenant_id IS NULL
           AND wallet_public_key IS NOT NULL
         GROUP BY wallet_public_key
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Cannot install legacy withdrawal serialization: duplicate processing withdrawals exist per wallet; reconcile them first'
            USING ERRCODE = 'unique_violation';
    END IF;
END;
$preflight$;

CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_one_processing_per_tenant_wallet
    ON public.api_idempotency_keys(tenant_id, wallet_public_key)
    WHERE operation = 'withdrawal'
      AND status = 'processing'
      AND tenant_id IS NOT NULL
      AND wallet_public_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uq_withdrawal_one_processing_per_legacy_wallet
    ON public.api_idempotency_keys(wallet_public_key)
    WHERE operation = 'withdrawal'
      AND status = 'processing'
      AND tenant_id IS NULL
      AND wallet_public_key IS NOT NULL;

-- Ledger identity is immutable. Lifecycle/verification fields remain mutable
-- only through the explicit state-transition graph below.
CREATE OR REPLACE FUNCTION enforce_blockchain_transaction_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.signature IS DISTINCT FROM OLD.signature
       OR NEW.direction IS DISTINCT FROM OLD.direction
       OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
       OR NEW.hd_wallet_id IS DISTINCT FROM OLD.hd_wallet_id
       OR NEW.counterparty IS DISTINCT FROM OLD.counterparty
       OR NEW.amount_lamports IS DISTINCT FROM OLD.amount_lamports
       OR NEW.fee_lamports IS DISTINCT FROM OLD.fee_lamports
       OR NEW.network IS DISTINCT FROM OLD.network
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
            'blockchain transaction identity, ownership and monetary fields are immutable (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (
          (OLD.status = 'detected' AND NEW.status IN
             ('confirming', 'confirmed', 'credited', 'failed', 'rejected', 'under_review'))
          OR
          (OLD.status = 'confirming' AND NEW.status IN
             ('confirmed', 'credited', 'failed', 'rejected', 'under_review'))
          OR
          (OLD.status = 'confirmed' AND NEW.status IN ('credited', 'under_review'))
          OR
          (OLD.status = 'credited' AND NEW.status = 'under_review')
          OR
          (OLD.status IN ('failed', 'rejected') AND NEW.status = 'under_review')
          OR
          (OLD.status = 'under_review' AND NEW.status IN
             ('confirmed', 'credited', 'failed', 'rejected'))
       ) THEN
        RAISE EXCEPTION
            'Invalid blockchain transaction status transition: % -> % (row id %)',
            OLD.status, NEW.status, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_blockchain_transactions_integrity
    ON public.blockchain_transactions;

CREATE TRIGGER trg_blockchain_transactions_integrity
    BEFORE UPDATE ON public.blockchain_transactions
    FOR EACH ROW
    EXECUTE FUNCTION enforce_blockchain_transaction_integrity();

-- Idempotency reservations are immutable request records. Only their lifecycle
-- fields may advance, and a persisted signature/response can never be replaced.
CREATE OR REPLACE FUNCTION enforce_idempotency_reservation_integrity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
    IF NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
       OR NEW.tenant_credential_id IS DISTINCT FROM OLD.tenant_credential_id
       OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
       OR NEW.request_hash IS DISTINCT FROM OLD.request_hash
       OR NEW.wallet_public_key IS DISTINCT FROM OLD.wallet_public_key
       OR NEW.operation IS DISTINCT FROM OLD.operation
       OR NEW.network IS DISTINCT FROM OLD.network
       OR NEW.to_public_key IS DISTINCT FROM OLD.to_public_key
       OR NEW.amount_lamports IS DISTINCT FROM OLD.amount_lamports
       OR NEW.approval_reference IS DISTINCT FROM OLD.approval_reference
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION
            'idempotency request identity is immutable (row id %)', OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.transaction_signature IS DISTINCT FROM OLD.transaction_signature
       AND (OLD.transaction_signature IS NOT NULL OR OLD.status <> 'processing') THEN
        RAISE EXCEPTION
            'a transaction signature may only be persisted once while processing (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.response_json IS NOT NULL
       AND NEW.response_json IS DISTINCT FROM OLD.response_json THEN
        RAISE EXCEPTION
            'a completed idempotency response cannot be replaced (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.response_json IS DISTINCT FROM OLD.response_json
       AND (OLD.status <> 'processing' OR NEW.status <> 'completed') THEN
        RAISE EXCEPTION
            'an idempotency response may only be stored when completing a processing request (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.operation = 'withdrawal'
       AND OLD.transaction_signature IS NOT NULL
       AND NEW.status = 'failed' THEN
        RAISE EXCEPTION
            'a signed withdrawal cannot be marked failed without reconciliation (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF OLD.operation = 'withdrawal'
       AND NEW.status = 'completed'
       AND NEW.transaction_signature IS NULL THEN
        RAISE EXCEPTION
            'a withdrawal cannot complete without a persisted transaction signature (row id %)',
            OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT (OLD.status = 'processing' AND NEW.status IN ('completed', 'failed')) THEN
        RAISE EXCEPTION
            'Invalid idempotency status transition: % -> % (row id %)',
            OLD.status, NEW.status, OLD.id
            USING ERRCODE = 'check_violation';
    END IF;

    RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_api_idempotency_integrity
    ON public.api_idempotency_keys;

CREATE TRIGGER trg_api_idempotency_integrity
    BEFORE UPDATE ON public.api_idempotency_keys
    FOR EACH ROW
    EXECUTE FUNCTION enforce_idempotency_reservation_integrity();

COMMENT ON INDEX public.uq_withdrawal_one_processing_per_tenant_wallet IS
    'At most one in-flight withdrawal per tenant source wallet; ambiguous signed requests remain locked until reconciliation.';
COMMENT ON INDEX public.uq_withdrawal_one_processing_per_legacy_wallet IS
    'At most one in-flight legacy withdrawal per source wallet; ambiguous signed requests remain locked until reconciliation.';
