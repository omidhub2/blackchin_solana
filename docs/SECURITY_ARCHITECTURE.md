# BLACKCHIN — Security Architecture

## 1. Two separate authentication domains

### Partner API

- `X-API-Key` with a tenant-specific opaque credential.
- Only SHA-256 digests are stored.
- Scopes, expiry, revocation, last-used tracking and tenant status are enforced.
- Tenant identity is derived server-side; request-body tenant IDs are ignored.
- Sensitive routes use shared PostgreSQL rate limits and fail closed when the
  limiter store is unavailable.
- Tenant requests authenticate on the control-plane connection, then use a
  separate non-superuser tenant pool. The request service graph receives only
  a signed tenant-scoped database facade.
- Each tenant SQL operation runs in a transaction with `SET LOCAL ROLE
  blackchin_tenant_runtime` and transaction-local signed context. Pooled
  sessions cannot retain a previous request's tenant context.
- PostgreSQL validates the HMAC, issue time, tenant status and credential
  status/expiry before returning the tenant id to RLS policies.
- Tenant RLS is enabled on wallet, transaction, idempotency, webhook,
  withdrawal-policy, approval, hot-wallet and operational-event tables.
- Legacy NULL-tenant rows are not assigned or exposed to tenant sessions.
- The tenant login must be a non-superuser, non-BYPASSRLS member of
  `blackchin_tenant_runtime`; the migration/control-plane pool must not be
  reused for tenant API queries.
- Provision a dedicated login through the database administrator/secret
  manager, then grant only the restricted runtime role:
  ```sql
  CREATE ROLE blackchin_tenant_login LOGIN
    NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOBYPASSRLS;
  GRANT blackchin_tenant_runtime TO blackchin_tenant_login;
  ```
  Set its password out-of-band and use that login only in
  `TENANT_DATABASE_URL`. Do not grant it table ownership or other privileged
  role memberships.
- Every tenant table has both a permissive access policy and a restrictive
  tenant guard. The restrictive policy is ANDed with any future permissive
  policy, preventing an accidentally broad policy from overriding isolation.

### Deposit background workers

- The native SOL deposit scanner and deposit reconciliation use a dedicated
  `DEPOSIT_WORKER_DATABASE_URL` pool. They never reuse the API/migration pool.
- Migration 0016 creates `blackchin_deposit_worker_runtime`. Provision a
  dedicated login as a non-superuser with `BYPASSRLS`, then grant membership:
  ```sql
  CREATE ROLE blackchin_deposit_worker_login LOGIN
    NOSUPERUSER NOCREATEDB NOCREATEROLE INHERIT BYPASSRLS;
  GRANT blackchin_deposit_worker_runtime TO blackchin_deposit_worker_login;
  ```
  Set its password out-of-band and use only in `DEPOSIT_WORKER_DATABASE_URL`.
- `BYPASSRLS` is necessary because the scanner intentionally processes
  addresses across tenants. The login is not a superuser and has only the
  explicit column/table grants in migration 0016.
- The worker can read public wallet addresses and ownership/status metadata,
  insert/update verified blockchain transaction lifecycle rows, update scanner
  and reconciliation cursors, append reconciliation events, and emit deposit
  webhook/operational events.
- The worker cannot read encrypted HD mnemonic, IV or authentication-tag
  columns; cannot read tenant credentials, idempotency reservations, dashboard
  sessions, hot-wallet records or signing material; and cannot update/deliver
  webhook outbox rows.
- Startup validates the login attributes, role membership and required grants,
  including explicit denial of encrypted mnemonic columns. Scanner/reconciliation
  fail closed if this dedicated connection is absent or misconfigured.
- Deposit verification resolves wallet metadata directly and does not invoke
  the general signing-key resolver.

### Dashboard operators

- Email + password with scrypt (N=16384, r=8, p=1, 64-byte derived key).
- Random 32-byte session token; only its SHA-256 digest is stored.
- HTTP-only, SameSite=Strict cookie; `Secure` in production.
- Random CSRF token bound to the session; required in `X-CSRF-Token` for every
  POST/PUT/PATCH/DELETE.
- Roles: `admin`, `operator`, `viewer`.
- Dashboard credentials are never accepted by the partner API and vice versa.

## 2. Tenant isolation

- Every tenant repository method requires `tenantId`.
- Wallet, account, transaction, idempotency and reconciliation queries include
  tenant predicates.
- Composite foreign keys bind child accounts and transactions to their tenant
  root.
- Tenant ownership is immutable after assignment.
- Signing re-verifies tenant ownership under row locks immediately before
  key derivation.
- Cross-tenant tests cover reads, writes, idempotency collisions and signing.

## 3. Signed tenant database context

- `TENANT_DATABASE_URL` points to a dedicated restricted login, never the
  migration/table-owner connection.
- `TENANT_CONTEXT_HMAC_KEY` is a 32-byte secret. Its matching database copy is
  stored in the private schema and is provisioned/verified at API startup.
- The API signs tenant ID, credential ID, issue time, version and a random
  nonce after credential authentication. Request-body tenant identifiers are
  never accepted as context claims.
- The database rejects missing, malformed, modified, stale or future-dated
  contexts and re-checks that the tenant and credential remain active.
- RLS policies apply to a restricted NOLOGIN role. The login switches to it
  with `SET LOCAL ROLE` inside every transaction.
- Context settings use `SET LOCAL` and are cleared automatically at commit or
  rollback. Each request receives a fresh service graph bound to the scoped DB.
- If the tenant DB URL, HMAC key, role membership or secret provisioning is
  missing/mismatched, tenant routes fail closed.

## 4. Signing and key custody

Current implementation:

- BIP39 mnemonic encrypted with AES-256-GCM.
- Key versioning supports rotation without rewriting old rows.
- Signing keypairs are resolved inside a transaction with `FOR SHARE` locks on
  child and parent rows.
- Key material is zeroized on a best-effort basis after use.
- Mnemonics are never returned by ordinary APIs; recovery is one-time,
  token-bound, explicit and `no-store`.

**Not implemented:** KMS/HSM or an isolated signer service. The dashboard
reports signer status as `application_encrypted` and `kms: false`. Production
signing should fail closed until a reviewed signer boundary is deployed.

## 5. Withdrawal safety

1. Authenticate tenant credential and require `withdrawals:submit`.
2. Resolve source wallet strictly inside the tenant.
3. Validate network, destination, amount and active lifecycle.
4. Enforce hot-wallet freeze/signing switch and single-transfer ceiling.
5. Reserve tenant idempotency before consuming a one-time approval; completed
   retries replay their original response without re-consuming approval.
6. Lock the tenant policy row and enforce enabled/frozen state, active
   allowlisted destination, exact approval binding and UTC daily/weekly
   amount/count limits.
7. Consume the credential-bound approval once and append an immutable policy
   decision event. Denied requests fail their reservation and never sign.
8. Persist the signed signature before broadcast.
9. On ambiguity, keep the intent `processing` and require reconciliation.
10. Never blindly rebroadcast; write immutable transaction evidence and
    append-only reconciliation events.
11. A PostgreSQL partial unique index permits only one `processing` withdrawal
    per source wallet (tenant-scoped or legacy). A signed/ambiguous reservation
    continues to occupy that slot until reconciliation.
12. Ledger identity, ownership, amounts and idempotency request identity are
    immutable at the database layer. Status changes must follow an explicit
    transition graph; a persisted signature and completed response cannot be
    replaced or cleared.
13. The ledger row and idempotency completion are committed in one database
    transaction after broadcast. Any failure leaves the signed reservation in
    `processing` for reconciliation.

The dashboard control plane issues approvals only for active tenant credentials
with `withdrawals:submit`, active HD child wallets and active destinations.
Partners may issue their own approval through the tenant API only when the same
credential has both `withdrawals:approve` and `withdrawals:submit`; a stable
`Idempotency-Key` makes issuance replay-safe.
Approvals bind the exact lamport amount, wallet, destination, network, asset and
canonical request hash; they expire within 15 minutes. Destination activation
requires a second admin. Policy edits freeze withdrawals and revoke unused
approvals; unfreeze is an explicit admin action.

## 6. Ledger and concurrency integrity

- Migration 0015 adds one-in-flight-withdrawal partial unique indexes for
  tenant and legacy source wallets. A second distinct idempotency key for the
  same wallet receives a conflict instead of reaching the signer.
- A preflight query makes migration fail closed if multiple processing
  withdrawals already exist for one source wallet; those records require
  reconciliation before the index can be installed.
- Ledger identity, tenant ownership and monetary fields are immutable. The
  lifecycle trigger permits only explicit forward/review transitions.
- Idempotency request identity is immutable; status may move only from
  `processing` to `completed` or `failed`. A persisted signature cannot be
  replaced/cleared and a stored response cannot be overwritten.
- Both legacy and tenant withdrawal flows commit the ledger row and completed
  idempotency response atomically after broadcast. On any failure, the signed
  reservation stays processing and must be reconciled, never retried with a new
  key.
- Signing lock timeout is applied after `BEGIN` in the same transaction as
  `FOR SHARE` row locks.

## 7. Deposit verification

- Fetch and parse the transaction from RPC.
- Reject failed transactions.
- Match destination and positive native SOL amount.
- Evaluate confirmation/finality.
- Enforce unique transaction identity.
- Treat RPC timeouts as unknown, not as failure.
- Move contradictory observations to `under_review`.

## 8. Webhooks

- Tenant endpoints must be public HTTPS; private, loopback, link-local and
  metadata destinations are rejected.
- DNS is re-validated on every delivery attempt; redirects are not followed.
- Payloads are signed with HMAC-SHA256 over
  `<timestamp>.<eventId>.<rawBody>`.
- Timestamp tolerance and event-ID deduplication protect against replay.
- Delivery is at-least-once with exponential backoff and jitter.
- Secrets are encrypted at rest and returned only once.
- Payload validation rejects sensitive field names.

## 9. Input, output and transport

- Strict field validation and unknown-field rejection.
- Parameterized SQL only.
- 32 KB body limit, request timeout and generic 5xx messages.
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`.
- Dashboard responses set `Cache-Control: no-store` for secrets and sessions.
- Secrets are redacted from Fastify logs.

## 10. Logging and audit

Never log:

- mnemonics, private keys or signer credentials,
- API keys, session tokens or CSRF tokens,
- passwords,
- webhook signing secrets,
- full sensitive request bodies.

Operational events, policy decisions, reconciliation evidence and transaction
evidence provide an auditable trail. Database superusers can bypass triggers;
production privileges must separate migration ownership from application DML.

## 11. Threat model

| Threat | Control |
|---|---|
| Cross-tenant access | tenant predicates, composite FKs, signer re-check, tests |
| Stolen API key | scopes, expiry, revocation, rate limits, audit |
| Stolen dashboard session | HTTP-only cookie, CSRF, expiry, revocation |
| Compromised API process | isolated signer/KMS (target), least privilege |
| Duplicate withdrawal | tenant idempotency, persisted signature, reconciliation |
| Webhook replay | timestamp + HMAC + event ID dedupe |
| Webhook SSRF | HTTPS-only, DNS/IP policy, no redirects |
| RPC lying or timing out | independent verification, unknown state, reconciliation |
| Key misuse | freeze, limits, audit, dual control (target) |

## 12. Production release gates

Do not declare public production readiness until:

- KMS/HSM or an isolated signer is deployed and recovery-tested.
- The tenant withdrawal policy provider and control-plane API pass CI and an independent security review.
- Cloud secrets, TLS, private networking and least-privilege DB roles are live.
- Concurrency, failure-injection, restore and reorg drills pass.
- Alerting, incident response and on-call ownership are active.
- Custody/safeguarding/money-transmission obligations are reviewed by qualified
  counsel for operating jurisdictions.