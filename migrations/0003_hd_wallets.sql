-- HD wallet structure.
--
-- Additive migration: the existing `wallets` table (standalone wallets created
-- with Keypair.generate()) is left untouched. Legacy rows are never converted
-- into HD children automatically.

CREATE TABLE IF NOT EXISTS hd_wallets (
    id BIGSERIAL PRIMARY KEY,
    -- Ownership reference reserved for tenant-scoped authentication. The
    -- current deployment is a single trusted backend, so this stays nullable.
    owner_id TEXT,
    label TEXT,
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    derivation_scheme TEXT NOT NULL,
    derivation_path_template TEXT NOT NULL,
    -- Encrypted BIP39 mnemonic (UTF-8 plaintext) with AES-256-GCM.
    mnemonic_encrypted TEXT NOT NULL,
    mnemonic_iv TEXT NOT NULL,
    mnemonic_auth_tag TEXT NOT NULL,
    encryption_key_version SMALLINT NOT NULL DEFAULT 1 CHECK (encryption_key_version > 0),
    -- Next account index to allocate. Incremented atomically under a row lock,
    -- so it is the single source of truth for allocation.
    next_account_index BIGINT NOT NULL DEFAULT 0 CHECK (next_account_index >= 0),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'provisioning', 'disabled', 'archived')),
    phrase_provisioned_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_hd_wallets_owner_id ON hd_wallets(owner_id);
CREATE INDEX IF NOT EXISTS idx_hd_wallets_status ON hd_wallets(status);

CREATE TABLE IF NOT EXISTS wallet_accounts (
    id BIGSERIAL PRIMARY KEY,
    hd_wallet_id BIGINT NOT NULL REFERENCES hd_wallets(id) ON DELETE RESTRICT,
    public_key TEXT NOT NULL,
    account_index BIGINT NOT NULL CHECK (account_index >= 0),
    derivation_path TEXT NOT NULL,
    wallet_type TEXT NOT NULL DEFAULT 'hd_child' CHECK (wallet_type IN ('hd_child')),
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'disabled', 'archived')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_wallet_accounts_public_key UNIQUE (public_key),
    CONSTRAINT uq_wallet_accounts_index UNIQUE (hd_wallet_id, account_index),
    CONSTRAINT uq_wallet_accounts_path UNIQUE (hd_wallet_id, derivation_path)
);

CREATE INDEX IF NOT EXISTS idx_wallet_accounts_hd_wallet_id ON wallet_accounts(hd_wallet_id);
CREATE INDEX IF NOT EXISTS idx_wallet_accounts_public_key ON wallet_accounts(public_key);

-- Immutable blockchain transaction ledger for deposits and withdrawals.
-- Rows are inserted once per (signature, wallet, direction); state changes
-- append a new status/updated timestamp but the identifying columns and the
-- recorded amounts are never overwritten.
CREATE TABLE IF NOT EXISTS blockchain_transactions (
    id BIGSERIAL PRIMARY KEY,
    signature TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('deposit', 'withdrawal')),
    wallet_public_key TEXT NOT NULL,
    hd_wallet_id BIGINT REFERENCES hd_wallets(id) ON DELETE RESTRICT,
    counterparty TEXT,
    amount_lamports NUMERIC(30, 0) NOT NULL CHECK (amount_lamports > 0),
    fee_lamports NUMERIC(30, 0) CHECK (fee_lamports >= 0),
    network TEXT NOT NULL CHECK (network IN ('devnet', 'testnet', 'mainnet-beta')),
    commitment TEXT CHECK (commitment IN ('processed', 'confirmed', 'finalized')),
    status TEXT NOT NULL CHECK (status IN ('detected', 'confirming', 'confirmed', 'credited', 'failed', 'rejected', 'under_review')),
    slot BIGINT,
    block_time TIMESTAMPTZ,
    failure_reason TEXT,
    idempotency_key VARCHAR(128),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_blockchain_transactions_identity UNIQUE (signature, wallet_public_key, direction)
);

CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_wallet
    ON blockchain_transactions(wallet_public_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_hd_wallet
    ON blockchain_transactions(hd_wallet_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_blockchain_transactions_status
    ON blockchain_transactions(status);

-- Idempotency records previously only tracked the response payload. Wallets
-- need the resulting signature and the wallet it belongs to.
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS wallet_public_key TEXT;
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS operation TEXT;
ALTER TABLE api_idempotency_keys
    ADD COLUMN IF NOT EXISTS transaction_signature TEXT;
