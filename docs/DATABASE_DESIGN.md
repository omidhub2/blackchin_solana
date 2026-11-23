# BLACKCHIN — Database Design

PostgreSQL is the durable source for operational state. The blockchain is the
source of truth for on-chain balances and transaction outcomes. The database
provides attribution, recoverability, idempotency, security evidence and
reliable API/event delivery.

## 1. Scope boundary

Allowed data:

- tenant identity and hashed API credentials,
- wallet metadata, public addresses and derivation metadata,
- encrypted signer material references,
- blockchain transaction evidence and verification state,
- withdrawal execution and idempotency state,
- scanner cursors and reconciliation evidence,
- webhook endpoints, outbox events and delivery attempts,
- dashboard operators, sessions and operational events,
- hot-wallet designations and policy state.

Not allowed:

- partner customer identities, balances or statements,
- partner double-entry journals,
- customer holds, credits, debits or internal transfers,
- a partner financial ledger of any kind.

`blockchain_transactions` is infrastructure evidence, not a customer ledger.

## 2. Migration inventory

| Version | Purpose |
|---|---|
| 0001 | Legacy standalone wallets |
| 0002 | Request idempotency |
| 0003 | HD roots, child accounts, transaction/idempotency fields |
| 0004 | Recovery-token metadata, scanner cursors, webhook outbox, shared rate limits, immutability trigger |
| 0005 | Ledger update/delete guards |
| 0006 | Persistent scanner backfill progress |
| 0007 | Deposit reconciliation cursor and append-only evidence |
| 0008 | Withdrawal reconciliation cursor and append-only evidence |
| 0009 | Tenant registry, hashed credentials, nullable tenant attribution, tenant immutability triggers |
| 0010 | Tenant attribution for withdrawal reconciliation evidence |
| 0011 | Tenant-scoped idempotency namespace and credential/approval binding |
| 0012 | Fail-closed withdrawal policy, destination allowlist, approvals, policy audit |
| 0013 | Dashboard operators/sessions, operational events, tenant webhook endpoints, hot wallets |
| 0014 | HMAC-verified tenant context, restricted runtime role and PostgreSQL row-level policies |

Migrations are forward-only and checksum-verified. Never edit an applied
migration.

## 3. Tenant RLS boundary

Migration 0014 creates the NOLOGIN role `blackchin_tenant_runtime`, a private
HMAC verification secret and `private.current_tenant_id()`. Tenant-owned
operational tables use RLS policies whose USING and WITH CHECK predicates
require the signed tenant context. The function revalidates tenant and
credential lifecycle state on every statement.

The API's tenant pool must authenticate as a separate non-superuser,
non-BYPASSRLS login that is granted membership in `blackchin_tenant_runtime`.
The API executes `SET LOCAL ROLE` and signed context inside each transaction.
The privileged control-plane pool is used only for authentication, secret
provisioning and background/administrative work. Never use the control-plane
pool for tenant service queries.

RLS is enabled, not forced, on purpose: the migration/table owner and
control-plane workers retain their explicit administrative path. Tenant API
connections must never use that owner login. Legacy NULL-tenant records remain
unassigned and invisible to the tenant runtime role.

## 4. Core tables

### `tenants`

Immutable numeric identity, tenant code, display name, lifecycle status and
metadata. No customer data.

### `tenant_api_credentials`

Public key prefix, SHA-256 secret hash, scopes, status, expiry, last-used and
revocation timestamps. Plaintext API keys are never stored.

### `hd_wallets`

Tenant-owned HD roots: network, derivation scheme/template, encrypted mnemonic
(AES-256-GCM), key version, next account index, status and one-time recovery
token hash/expiry.

### `wallet_accounts`

Derived public addresses with tenant, parent root, derivation index/path,
network and lifecycle. Unique constraints prevent duplicate addresses, indexes
and paths.

### `wallets`

Legacy standalone wallets. Retained for compatibility; never silently converted
or assigned to a tenant.

### `blockchain_transactions`

Immutable identity and amount for native SOL deposits/withdrawals. Lifecycle
columns may advance; identity and monetary columns are protected by triggers.
Unique `(signature, wallet_public_key, direction)` makes recording idempotent.

### `api_idempotency_keys`

Tenant-scoped withdrawal execution intents. Binds tenant, credential, approval
reference, request hash, wallet, destination, amount, network and signature.
`processing` is an execution guard, not a customer balance hold.

### Scanner and reconciliation tables

- `deposit_scanner_cursors`
- `deposit_reconciliation_cursors`, `deposit_reconciliation_events`
- `withdrawal_reconciliation_cursors`, `withdrawal_reconciliation_events`

Reconciliation evidence is append-only.

### `webhook_outbox`

Durable event queue with event ID, type, tenant, network, payload, attempts,
next attempt, HTTP status and delivery timestamp. Claimed with
`FOR UPDATE SKIP LOCKED`.

### `tenant_webhook_endpoints` (0013)

Tenant-scoped HTTPS endpoint, encrypted signing secret, event-type filter,
status and rotation timestamp. Secrets are never returned after creation or
rotation.

### `dashboard_users`, `dashboard_sessions` (0013)

Separate operator identity domain. Passwords use scrypt with per-user salt.
Session and CSRF tokens are stored only as SHA-256 digests.

### `operational_events` (0013)

Append-only dashboard telemetry and activity log. Cursor is the numeric `id`;
the public `event_id` is a UUID used for deduplication. No secrets or customer
data.

### `hot_wallets` (0013)

Explicit designation of a tenant HD child as an operational signer, with
network, status, signing switch, single-transfer ceiling and freeze reason.
Private key material remains in the encrypted HD root; the table stores no key.

### `tenant_withdrawal_policies`, `tenant_withdrawal_destinations`,
`tenant_withdrawal_approvals`, `tenant_withdrawal_policy_events` (0012)

Fail-closed policy limits, allowlist state, credential-bound approvals and
append-only policy decisions. No policy row is auto-created for existing
tenants; absence means disabled.

## 4. Integrity rules

1. Tenant-owned records carry a tenant relation; composite foreign keys prevent
   mismatched parents.
2. Tenant identity is immutable after assignment.
3. Idempotency is tenant-scoped and bound to the canonical request.
4. Monetary values are integer lamports or exact `NUMERIC`; no floating point.
5. Evidence and audit rows are append-only.
6. A withdrawal timeout never releases the reservation while broadcast/finality
   is unknown.
7. No table represents a partner customer available balance.

## 5. Retention and operations

- Back up with PITR before every migration.
- Apply migrations with a least-privilege migration role.
- The application role must not own tables or bypass immutability triggers.
- Purge expired dashboard sessions periodically.
- Archive old operational events according to an approved retention policy;
  never delete evidence required by an open reconciliation.