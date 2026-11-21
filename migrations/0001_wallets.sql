CREATE TABLE IF NOT EXISTS wallets (
    id BIGSERIAL PRIMARY KEY,
    public_key TEXT NOT NULL,
    private_key_encrypted TEXT NOT NULL,
    private_key_iv TEXT NOT NULL,
    private_key_auth_tag TEXT NOT NULL,
    mnemonic_encrypted TEXT,
    mnemonic_iv TEXT,
    mnemonic_auth_tag TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallets_public_key_unique
ON wallets(public_key);

CREATE INDEX IF NOT EXISTS idx_wallets_created_at
ON wallets(created_at);
