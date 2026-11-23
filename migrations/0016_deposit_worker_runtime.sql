-- Phase 4: least-privilege database role for the native SOL deposit
-- scanner and deposit reconciliation workers.
--
-- The worker login is provisioned by deployment with BYPASSRLS (but not
-- SUPERUSER) and membership in this role. BYPASSRLS is required because the
-- worker intentionally processes multiple tenants; table/column grants remain
-- narrowly scoped and no encrypted HD mnemonic columns are granted.

DO $role$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'blackchin_deposit_worker_runtime'
    ) THEN
        CREATE ROLE blackchin_deposit_worker_runtime
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;
END;
$role$;

GRANT USAGE ON SCHEMA public TO blackchin_deposit_worker_runtime;

-- Wallet discovery: public addresses and ownership/status metadata only.
GRANT SELECT (id, public_key, tenant_id, created_at)
    ON public.wallets TO blackchin_deposit_worker_runtime;
GRANT SELECT (id, tenant_id, status)
    ON public.hd_wallets TO blackchin_deposit_worker_runtime;
GRANT SELECT (
    id, hd_wallet_id, public_key, account_index, derivation_path,
    wallet_type, network, status, created_at, updated_at, tenant_id
) ON public.wallet_accounts TO blackchin_deposit_worker_runtime;

-- Scanner inserts/updates verified transaction lifecycle records.
GRANT SELECT, INSERT, UPDATE
    ON public.blockchain_transactions TO blackchin_deposit_worker_runtime;

-- Durable scanner/reconciliation progress and append-only evidence.
GRANT SELECT, INSERT, UPDATE
    ON public.deposit_scanner_cursors,
       public.deposit_reconciliation_cursors
    TO blackchin_deposit_worker_runtime;
GRANT SELECT, INSERT
    ON public.deposit_reconciliation_events
    TO blackchin_deposit_worker_runtime;

-- Deposit detection emits transactional webhook outbox and dashboard events.
-- The worker may insert/read its own RETURNING projection, but cannot deliver,
-- mutate, replay, or delete queued events.
GRANT SELECT, INSERT
    ON public.webhook_outbox, public.operational_events
    TO blackchin_deposit_worker_runtime;

GRANT USAGE, SELECT ON SEQUENCE
    public.blockchain_transactions_id_seq,
    public.deposit_scanner_cursors_id_seq,
    public.deposit_reconciliation_events_id_seq,
    public.webhook_outbox_id_seq,
    public.operational_events_id_seq
    TO blackchin_deposit_worker_runtime;

COMMENT ON ROLE blackchin_deposit_worker_runtime IS
    'Least-privilege cross-tenant native SOL deposit scanner/reconciliation role; deployment login must be non-superuser BYPASSRLS and a member of this role. No encrypted HD mnemonic columns are granted.';
