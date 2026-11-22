# Database Schema

Migrations are applied with `npm run db:migrate` (see `OPERATIONS.md`).

| Version | File | Purpose |
|---|---|---|
| 0001 | `0001_wallets.sql` | legacy standalone wallets (unchanged) |
| 0002 | `0002_api_idempotency.sql` | idempotency reservations (unchanged) |
| 0003 | `0003_hd_wallets.sql` | HD roots, child accounts, ledger, idempotency columns |
| 0004 | `0004_hardening.sql` | recovery-token hash/expiry, scanner cursors, webhook outbox, shared rate limiting, ledger UPDATE trigger |
| 0005 | `0005_ledger_immutability.sql` | re-installs the ledger UPDATE trigger and adds a DELETE guard |

## `wallets` (legacy, unchanged)

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `public_key` | `TEXT NOT NULL` | unique via `idx_wallets_public_key_unique` |
| `private_key_encrypted` / `private_key_iv` / `private_key_auth_tag` | `TEXT NOT NULL` | AES-256-GCM |
| `mnemonic_*` | `TEXT NULL` | always `NULL` for `Keypair.generate()` wallets |
| `created_at` | `TIMESTAMPTZ` | |

## `hd_wallets`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | also used as AEAD AAD |
| `owner_id` | `TEXT NULL` | reserved for future tenant isolation (indexed) |
| `label` | `TEXT NULL` | operator label |
| `network` | `TEXT NOT NULL` | `devnet` \| `testnet` \| `mainnet-beta` |
| `derivation_scheme` | `TEXT NOT NULL` | `bip39+slip10-ed25519/v1` |
| `derivation_path_template` | `TEXT NOT NULL` | `m/44'/501'/{accountIndex}'/0'` |
| `mnemonic_encrypted` / `mnemonic_iv` / `mnemonic_auth_tag` | `TEXT NOT NULL` | AES-256-GCM, AAD `hd_wallets:<id>:mnemonic:v1` |
| `encryption_key_version` | `SMALLINT CHECK > 0` | key rotation |
| `next_account_index` | `BIGINT CHECK >= 0` | allocation counter |
| `status` | `TEXT CHECK` | `active` \| `provisioning` \| `disabled` \| `archived` |
| `phrase_provisioned_at` | `TIMESTAMPTZ NULL` | set once when the phrase was revealed |
| `recovery_token_hash` | `CHAR(64) NULL` | SHA-256 of the issued token (plaintext never stored); cleared on redemption |
| `recovery_token_expires_at` | `TIMESTAMPTZ NULL` | server-side expiry enforced by redemption; cleared on redemption |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | |

Indexes: `idx_hd_wallets_owner_id`, `idx_hd_wallets_status`.

## `wallet_accounts`

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `hd_wallet_id` | `BIGINT NOT NULL FK → hd_wallets(id) ON DELETE RESTRICT` | |
| `public_key` | `TEXT NOT NULL` | `uq_wallet_accounts_public_key` |
| `account_index` | `BIGINT CHECK >= 0` | `uq_wallet_accounts_index (hd_wallet_id, account_index)` |
| `derivation_path` | `TEXT NOT NULL` | `uq_wallet_accounts_path (hd_wallet_id, derivation_path)` |
| `wallet_type` | `TEXT CHECK = 'hd_child'` | |
| `network` | `TEXT CHECK` | must match the parent (validated in code) |
| `status` | `TEXT CHECK` | `active` \| `disabled` \| `archived` |
| `created_at` / `updated_at` | `TIMESTAMPTZ` | |

Indexes: `idx_wallet_accounts_hd_wallet_id`, `idx_wallet_accounts_public_key`.

## `blockchain_transactions`

Immutable ledger. The identifying columns (`signature`, `wallet_public_key`,
`direction`) and the recorded amounts are never updated; only lifecycle status
and confirmation metadata advance.

Enforcement (migrations 0004 + 0005), so this is a database rule and not only a
code convention:

- `trg_blockchain_transactions_immutable` (BEFORE UPDATE) raises
  `check_violation` if `signature`, `direction`, `wallet_public_key`,
  `amount_lamports`, `fee_lamports` or `network` change.
- `trg_blockchain_transactions_no_delete` (BEFORE DELETE) raises
  `check_violation` for every delete; corrections must be recorded as a
  compensating event rather than by removing history.
- `status`, `commitment`, `slot`, `block_time`, `failure_reason` and `metadata`
  **stay updatable**, which is what legitimate confirmation progression uses
  (`updateTransactionStatus`).

Limits: a PostgreSQL role that owns the table can disable a trigger, and a
superuser can always bypass rules. The guarantee holds for the application role
when it is a non-owner DML role (recommended). Physical retention deletes, if
ever required, must be an explicit, logged maintenance operation, not an
application code path.

| Column | Type | Notes |
|---|---|---|
| `id` | `BIGSERIAL PK` | |
| `signature` | `TEXT NOT NULL` | |
| `direction` | `TEXT CHECK` | `deposit` \| `withdrawal` |
| `wallet_public_key` | `TEXT NOT NULL` | |
| `hd_wallet_id` | `BIGINT NULL FK` | set for HD children |
| `counterparty` | `TEXT NULL` | sender (deposit) / recipient (withdrawal) |
| `amount_lamports` | `NUMERIC(30,0) CHECK > 0` | |
| `fee_lamports` | `NUMERIC(30,0) CHECK >= 0` | |
| `network` | `TEXT CHECK` | |
| `commitment` | `TEXT CHECK` | `processed` \| `confirmed` \| `finalized` |
| `status` | `TEXT CHECK` | `detected` \| `confirming` \| `confirmed` \| `credited` \| `failed` \| `rejected` \| `under_review` |
| `slot` / `block_time` | `BIGINT` / `TIMESTAMPTZ` | |
| `failure_reason` | `TEXT` | |
| `idempotency_key` | `VARCHAR(128)` | withdrawal link |
| `metadata` | `JSONB` | transfer breakdown, wallet type |

Constraint: `uq_blockchain_transactions_identity (signature, wallet_public_key, direction)`
— makes deposit/withdrawal recording idempotent.

## `api_idempotency_keys` (extended by 0003)

Existing columns plus `wallet_public_key`, `operation`, `transaction_signature`,
all added with `ADD COLUMN IF NOT EXISTS`.

## Migration safety

- 0003 is purely additive (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`); it never rewrites, deletes or converts existing wallet rows.
- 0004 adds columns with `ADD COLUMN IF NOT EXISTS` and creates new tables with
  `CREATE TABLE IF NOT EXISTS`; the trigger is installed with
  `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, so it is re-runnable.
- 0005 re-installs the same UPDATE trigger (`CREATE OR REPLACE FUNCTION` + drop/
  create) and adds the DELETE guard; also re-runnable and non-destructive.
- Both run inside the migration runner's single transaction per file.
- Legacy wallets are **not** migrated into the HD hierarchy; they keep signing
  from their own encrypted secret key.
- Applied migrations are checksum-verified; editing one aborts the runner.
- Back up the database before applying any migration.
