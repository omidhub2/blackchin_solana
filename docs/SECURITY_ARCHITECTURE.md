# BLACKCHIN — Security Architecture

## 1. Two separate authentication domains

### Partner API

- `X-API-Key` with a tenant-specific opaque credential.
- Only SHA-256 digests are stored.
- Scopes, expiry, revocation, last-used tracking and tenant status are enforced.
- Tenant identity is derived server-side; request-body tenant IDs are ignored.
- Sensitive routes use shared PostgreSQL rate limits and fail closed when the
  limiter store is unavailable.

### Dashboard operators

- Email + password with scrypt (N=16384, r=8, p=1, 64-byte derived key).
- Random 32-byte session token; only its SHA-256 digest is stored.
- HTTP-only, SameSite=Strict cookie; `Secure` in production.
- Random CSRF token bound to the session; required in `X-CSRF-Token` for every
  POST/PATCH/DELETE.
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

## 3. Signing and key custody

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

## 4. Withdrawal safety

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

The dashboard control plane issues approvals only for active tenant credentials
with `withdrawals:submit`, active HD child wallets and active destinations.
Approvals bind the exact lamport amount, wallet, destination, network, asset and
canonical request hash; they expire within 15 minutes. Destination activation
requires a second admin. Policy edits freeze withdrawals and revoke unused
approvals; unfreeze is an explicit admin action.

## 5. Deposit verification

- Fetch and parse the transaction from RPC.
- Reject failed transactions.
- Match destination and positive native SOL amount.
- Evaluate confirmation/finality.
- Enforce unique transaction identity.
- Treat RPC timeouts as unknown, not as failure.
- Move contradictory observations to `under_review`.

## 6. Webhooks

- Tenant endpoints must be public HTTPS; private, loopback, link-local and
  metadata destinations are rejected.
- DNS is re-validated on every delivery attempt; redirects are not followed.
- Payloads are signed with HMAC-SHA256 over
  `<timestamp>.<eventId>.<rawBody>`.
- Timestamp tolerance and event-ID deduplication protect against replay.
- Delivery is at-least-once with exponential backoff and jitter.
- Secrets are encrypted at rest and returned only once.
- Payload validation rejects sensitive field names.

## 7. Input, output and transport

- Strict field validation and unknown-field rejection.
- Parameterized SQL only.
- 32 KB body limit, request timeout and generic 5xx messages.
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`,
  `Referrer-Policy`, `Permissions-Policy`.
- Dashboard responses set `Cache-Control: no-store` for secrets and sessions.
- Secrets are redacted from Fastify logs.

## 8. Logging and audit

Never log:

- mnemonics, private keys or signer credentials,
- API keys, session tokens or CSRF tokens,
- passwords,
- webhook signing secrets,
- full sensitive request bodies.

Operational events, policy decisions, reconciliation evidence and transaction
evidence provide an auditable trail. Database superusers can bypass triggers;
production privileges must separate migration ownership from application DML.

## 9. Threat model

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

## 10. Production release gates

Do not declare public production readiness until:

- KMS/HSM or an isolated signer is deployed and recovery-tested.
- The tenant withdrawal policy provider and control-plane API pass CI and an independent security review.
- Cloud secrets, TLS, private networking and least-privilege DB roles are live.
- Concurrency, failure-injection, restore and reorg drills pass.
- Alerting, incident response and on-call ownership are active.
- Custody/safeguarding/money-transmission obligations are reviewed by qualified
  counsel for operating jurisdictions.