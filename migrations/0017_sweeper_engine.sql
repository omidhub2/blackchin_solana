-- Phase 6: policy-bound SOL/SPL sweeper runtime.
--
-- The sweeper is intentionally separate from the deposit worker. It must
-- decrypt HD child signing material, so it uses a dedicated runtime login and
-- an explicit role with only the columns required by wallet-signer plus the
-- sweep queue/policy tables. The role must never be a superuser.
--
-- All monetary quantities are raw integer strings (lamports or token base
-- units). No floating-point amount is persisted.

CREATE TABLE IF NOT EXISTS sweep_policies (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT REFERENCES tenants(id) ON DELETE RESTRICT,
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    destination_public_key VARCHAR(64) NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT FALSE,
    execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    funding_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    funding_wallet_public_key VARCHAR(64),
    max_funding_per_sweep_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_funding_per_sweep_lamports >= 0),
    max_funding_per_day_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0
        CHECK (max_funding_per_day_lamports >= 0),
    min_sol_sweep_lamports NUMERIC(30, 0) NOT NULL DEFAULT 5000
        CHECK (min_sol_sweep_lamports >= 0),
    min_token_sweep_base_units NUMERIC(40, 0) NOT NULL DEFAULT 1
        CHECK (min_token_sweep_base_units >= 0),
    retain_lamports NUMERIC(30, 0) NOT NULL DEFAULT 10000
        CHECK (retain_lamports >= 0),
    max_fee_lamports NUMERIC(30, 0) NOT NULL DEFAULT 100000
        CHECK (max_fee_lamports >= 0),
    max_sweeps_per_wallet_day INTEGER NOT NULL DEFAULT 20
        CHECK (max_sweeps_per_wallet_day BETWEEN 1 AND 10000),
    policy_version BIGINT NOT NULL DEFAULT 1 CHECK (policy_version > 0),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK ((funding_enabled = FALSE) OR
           (funding_wallet_public_key IS NOT NULL
            AND max_funding_per_sweep_lamports > 0
            AND max_funding_per_day_lamports > 0)),
    CHECK (funding_wallet_public_key IS NULL OR funding_wallet_public_key <> destination_public_key)
);

-- One policy per tenant/network; NULL tenant is the legacy platform scope.
CREATE UNIQUE INDEX IF NOT EXISTS uq_sweep_policies_scope_network
    ON sweep_policies(COALESCE(tenant_id, 0), network);

CREATE TABLE IF NOT EXISTS sweep_jobs (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT REFERENCES tenants(id) ON DELETE RESTRICT,
    policy_id BIGINT NOT NULL REFERENCES sweep_policies(id) ON DELETE RESTRICT,
    policy_version BIGINT NOT NULL CHECK (policy_version > 0),
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    source_public_key VARCHAR(64) NOT NULL,
    hd_wallet_id BIGINT REFERENCES hd_wallets(id) ON DELETE RESTRICT,
    destination_public_key VARCHAR(64) NOT NULL,
    asset_type TEXT NOT NULL CHECK (asset_type IN ('sol', 'spl')),
    mint_public_key VARCHAR(64),
    token_program_id VARCHAR(64),
    decimals SMALLINT,
    source_balance_raw NUMERIC(40, 0) NOT NULL CHECK (source_balance_raw >= 0),
    amount_raw NUMERIC(40, 0) NOT NULL CHECK (amount_raw >= 0),
    estimated_fee_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (estimated_fee_lamports >= 0),
    rent_exempt_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (rent_exempt_lamports >= 0),
    funding_amount_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (funding_amount_lamports >= 0),
    observed_slot BIGINT,
    idempotency_key VARCHAR(128) NOT NULL UNIQUE,
    status TEXT NOT NULL DEFAULT 'planned'
        CHECK (status IN (
          'planned', 'skipped_dust', 'awaiting_funding', 'funding_submitted',
          'ready', 'submitted', 'completed', 'failed', 'under_review'
        )),
    funding_signature VARCHAR(100),
    transaction_signature VARCHAR(100),
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
    next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    lease_owner VARCHAR(128),
    lease_expires_at TIMESTAMPTZ,
    error_code VARCHAR(100),
    error_message VARCHAR(500),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CHECK (
      (asset_type = 'sol' AND mint_public_key IS NULL AND token_program_id IS NULL AND decimals IS NULL)
      OR
      (asset_type = 'spl' AND mint_public_key IS NOT NULL AND token_program_id IS NOT NULL
       AND decimals BETWEEN 0 AND 18)
    ),
    CHECK (amount_raw <= source_balance_raw)
);

CREATE INDEX IF NOT EXISTS idx_sweep_jobs_due
    ON sweep_jobs(network, next_attempt_at, id)
    WHERE status IN ('planned', 'awaiting_funding', 'funding_submitted', 'ready', 'submitted');

CREATE INDEX IF NOT EXISTS idx_sweep_jobs_tenant_created
    ON sweep_jobs(tenant_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sweep_jobs_one_active_asset
    ON sweep_jobs(network, source_public_key, asset_type, COALESCE(mint_public_key, ''))
    WHERE status IN ('planned', 'awaiting_funding', 'funding_submitted', 'ready', 'submitted', 'under_review');

CREATE TABLE IF NOT EXISTS sweep_events (
    id BIGSERIAL PRIMARY KEY,
    job_id BIGINT NOT NULL REFERENCES sweep_jobs(id) ON DELETE RESTRICT,
    tenant_id BIGINT REFERENCES tenants(id) ON DELETE RESTRICT,
    network VARCHAR(32) NOT NULL,
    outcome VARCHAR(64) NOT NULL,
    signature VARCHAR(100),
    details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_sweep_events_job_created
    ON sweep_events(job_id, created_at, id);

CREATE OR REPLACE FUNCTION prevent_sweep_event_mutation()
RETURNS TRIGGER AS $$
BEGIN
    RAISE EXCEPTION 'sweep events are append-only'
        USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sweep_events_immutable ON sweep_events;
CREATE TRIGGER trg_sweep_events_immutable
    BEFORE UPDATE OR DELETE ON sweep_events
    FOR EACH ROW EXECUTE FUNCTION prevent_sweep_event_mutation();

CREATE TABLE IF NOT EXISTS sweeper_worker_cursors (
    network VARCHAR(32) PRIMARY KEY CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    last_wallet_account_id BIGINT NOT NULL DEFAULT 0 CHECK (last_wallet_account_id >= 0),
    last_run_at TIMESTAMPTZ,
    last_error VARCHAR(500),
    status TEXT NOT NULL DEFAULT 'idle' CHECK (status IN ('idle', 'running', 'error')),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sweep_funding_daily_usage (
    id BIGSERIAL PRIMARY KEY,
    tenant_id BIGINT,
    network VARCHAR(32) NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    funding_wallet_public_key VARCHAR(64) NOT NULL,
    usage_date DATE NOT NULL,
    total_lamports NUMERIC(30, 0) NOT NULL DEFAULT 0 CHECK (total_lamports >= 0),
    transfer_count INTEGER NOT NULL DEFAULT 0 CHECK (transfer_count >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_sweep_funding_daily_scope
    ON sweep_funding_daily_usage(COALESCE(tenant_id, 0), network, funding_wallet_public_key, usage_date);

-- Sweeps are a distinct outbound ledger operation. Preserve the existing
-- deposit/withdrawal values while allowing native SOL sweep records.
ALTER TABLE public.blockchain_transactions
    DROP CONSTRAINT IF EXISTS blockchain_transactions_direction_check;
ALTER TABLE public.blockchain_transactions
    ADD CONSTRAINT blockchain_transactions_direction_check
    CHECK (direction IN ('deposit', 'withdrawal', 'sweep'));

-- Sweeper signing is deliberately more privileged than deposit scanning:
-- it can read encrypted HD root material, but cannot read legacy private-key
-- ciphertext, tenant credentials, dashboard sessions or webhook payloads.
DO $role$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_roles WHERE rolname = 'blackchin_sweeper_runtime'
    ) THEN
        CREATE ROLE blackchin_sweeper_runtime
            NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT
            NOREPLICATION NOBYPASSRLS;
    END IF;
END;
$role$;

GRANT USAGE ON SCHEMA public TO blackchin_sweeper_runtime;

GRANT SELECT (
    id, owner_id, label, network, derivation_scheme, derivation_path_template,
    mnemonic_encrypted, mnemonic_iv, mnemonic_auth_tag, encryption_key_version,
    next_account_index, status, phrase_provisioned_at, recovery_token_hash,
    recovery_token_expires_at, created_at, updated_at, tenant_id
) ON public.hd_wallets TO blackchin_sweeper_runtime;

GRANT SELECT (
    id, hd_wallet_id, public_key, account_index, derivation_path,
    wallet_type, network, status, created_at, updated_at, tenant_id
) ON public.wallet_accounts TO blackchin_sweeper_runtime;

GRANT SELECT, INSERT, UPDATE
    ON public.sweep_policies, public.sweep_jobs, public.sweeper_worker_cursors,
       public.sweep_funding_daily_usage
    TO blackchin_sweeper_runtime;

GRANT SELECT, INSERT
    ON public.sweep_events, public.blockchain_transactions
    TO blackchin_sweeper_runtime;

GRANT USAGE, SELECT ON SEQUENCE
    public.sweep_policies_id_seq, public.sweep_jobs_id_seq, public.sweep_events_id_seq,
    public.sweep_funding_daily_usage_id_seq, public.blockchain_transactions_id_seq
    TO blackchin_sweeper_runtime;

COMMENT ON ROLE blackchin_sweeper_runtime IS
    'Dedicated cross-tenant sweeper runtime. Non-superuser BYPASSRLS login may read encrypted HD mnemonic columns for controlled signing, but has no access to legacy private-key columns, tenant credentials, dashboard sessions or webhook payloads.';
