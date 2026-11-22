# Database Schema

This document describes the **current database**, not the complete target schema. Migrations are forward-only and checksum-verified with `npm run db:migrate`. Do not edit an applied migration; add the next numbered migration.

## 1. Current migration inventory

| Version | File | Purpose |
|---|---|---|
| 0001 | `0001_wallets.sql` | legacy standalone wallets |
| 0002 | `0002_api_idempotency.sql` | request idempotency |
| 0003 | `0003_hd_wallets.sql` | HD roots, child accounts and transaction/idempotency fields |
| 0004 | `0004_hardening.sql` | recovery-token metadata, scanner cursors, webhook outbox/shared rate-limit foundations and immutability trigger |
| 0005 | `0005_ledger_immutability.sql` | transaction update/delete guards |
| 0006 | `0006_deposit_scanner_backfill.sql` | persistent scanner backfill progress |
| 0007 | `0007_deposit_reconciliation.sql` | deposit reconciliation cursor and append-only evidence |
| 0008 | `0008_withdrawal_reconciliation.sql` | withdrawal reconciliation cursor and append-only evidence |

## 2. Current tables and their meaning

### `tenants` and `tenant_api_credentials` (migration 0009)

The tenant registry stores company identity/status. API credential rows store a public key prefix, a SHA-256 secret hash, scopes and lifecycle metadata; plaintext credentials are not stored. These tables are a **database foundation only**: runtime authentication, credential issuance/rotation APIs, scope enforcement and tenant-aware repository authorization are not yet connected.

Migration 0009 adds nullable `tenant_id` attribution columns to existing wallet, transaction, idempotency and outbox records. Existing rows remain unassigned because their company ownership cannot safely be inferred. Tenant ownership becomes immutable after it is assigned. Composite foreign keys ensure an assigned HD child/transaction tenant matches its HD root.

`NULL tenant_id` is a legacy/transition state, not an acceptable ownership state for new multi-tenant records. New tenant-aware write paths must require a verified tenant context.

### `wallets`

Legacy standalone wallets. Encrypted private key fields use AES-256-GCM. Existing records are retained and are not silently converted into HD children.

### `hd_wallets`

HD root metadata and encrypted mnemonic. `owner_id` is nullable and currently only a future tenant-isolation placeholder. It is **not** a tenant registry, not authenticated ownership and not an enforced authorization boundary.

### `wallet_accounts`

HD-derived child public addresses, derivation index/path, network and lifecycle. Parent relation is to `hd_wallets`. Current schema does not provide complete multi-tenant isolation.

### `blockchain_transactions`

Immutable transaction identity/evidence for native SOL deposits and withdrawals. The identity/amount fields are protected by database triggers against application updates; deletes are rejected. Lifecycle and confirmation metadata can advance.

This table is **not**:
- a Double-Entry accounting journal,
- a partner's customer balance ledger,
- a monetary reservation/hold ledger,
- a complete multi-chain normalized transaction store.

### `api_idempotency_keys`

Prevents duplicate processing of withdrawal requests and stores request/transaction metadata. A `processing` row is an execution/idempotency guard, not a reserved customer balance and not proof that partner accounting has held funds.

### Reconciliation tables

- `deposit_reconciliation_cursors` and `deposit_reconciliation_events`: durable cursor and append-only verification evidence.
- `withdrawal_reconciliation_cursors` and `withdrawal_reconciliation_events`: durable cursor and append-only withdrawal outcome evidence.

These records describe observed/verified operational state. They do not post customer credits/debits or create a partner accounting journal.

## 3. Required target schema domains

The following are architectural requirements and are **not yet implemented as a complete schema**.

### Company and credentials
- `tenants`: immutable tenant ID, legal/display metadata, status and timestamps.
- `tenant_api_credentials`: tenant ID, credential hash, scopes, status, expiry, rotation/revocation and last-used metadata. Never store plaintext API secrets.
- `tenant_network_policies`, `tenant_asset_policies`, `tenant_limits`: explicit allowlists and operational controls.

### Tenant-owned wallet infrastructure
- Tenant-scoped wallet roots/namespaces, chain/network identity, derivation scheme/version and key-provider reference.
- Tenant-scoped wallet addresses with unique address identity and derivation allocation constraints.
- Opaque partner customer/reference fields only where required for routing deposit notifications; do not import customer accounting data.

### Multi-chain transactions and execution
- Normalized network and asset registry (asset identity includes network plus contract/mint; native asset distinguished explicitly).
- Deposit observations and transfer/log/event identity, with reorg/finality evidence.
- Withdrawal execution intents, policy decisions, signed transaction identity, broadcast attempts and reconciliation state.
- Tenant-scoped idempotency keys unique by tenant and operation.
- Exact integer smallest-unit amounts and explicit asset decimals.

### Operational asset attribution
- Append-only movements/attribution connecting tenant, wallet, asset, transaction, fee and operational purpose.
- Reconciliation snapshots/observations against chain balances.
- Suspense/unmatched movement handling and correction events.

This domain exists to reconcile infrastructure custody and tenant-attributed activity. It must not be exposed as a customer balance or replace partner Double-Entry accounting.

### Event delivery
- Transactional outbox, tenant webhook subscriptions, signing-secret references, delivery attempts, retry schedule and dead-letter/replay metadata.
- Outbox event creation must commit atomically with the application state transition that generated it.

## 4. Data and integrity rules

1. Every tenant-owned record has a mandatory tenant relation; composite foreign keys prevent mismatched tenant parents.
2. Tenant identity comes from server-side auth context, never request-body trust.
3. Idempotency uniqueness is tenant-scoped and binds the canonical operation payload.
4. Chain transaction uniqueness includes network and chain-specific transfer identity (for tokens, log/event index or equivalent).
5. Monetary values use integer smallest units or exact NUMERIC; no floating point.
6. Evidence/event records are append-only; state projections may change only through validated transitions.
7. A withdrawal timeout does not release operational reservation if broadcast/finality is unknown.
8. No schema table in BLACKCHIN represents a partner's individual customer available balance or customer Double-Entry ledger.

## 5. Migration and backfill safety

- All new migrations are additive and forward-only.
- Never drop or rewrite existing wallet/transaction history to introduce tenancy.
- Existing records must be assigned to a tenant only through an explicit, verified migration mapping; never guess tenant ownership.
- If ownership cannot be proven, retain records in a quarantined/unassigned state and block signing until resolved.
- Backfill in bounded, restartable batches with counts, checksums and reconciliation reports.
- Apply migrations with a least-privilege migration role; application role must not own tables or bypass immutability triggers.
- Back up PostgreSQL before migration and test restore in staging.

## 6. Current limitations

- Tenant registry and credential-hash schema foundation exists, but no runtime tenant authentication or scope enforcement.
- No complete tenant-scoped API authorization.
- `hd_wallets.owner_id` is not enforced.
- No complete multi-chain asset/transaction schema.
- No customer monetary reservation ledger (intentionally outside the partner accounting boundary).
- No complete operational asset attribution ledger yet.
- No complete transactional webhook delivery implementation.
