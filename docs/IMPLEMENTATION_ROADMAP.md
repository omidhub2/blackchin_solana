# BLACKCHIN — Implementation Roadmap

Status reflects this repository, not aspiration.

## Phase 1 — Audit and architecture (complete)

- Repository, migrations, routes, services, tests and git state audited.
- Architecture, product scope, database design, security and deployment docs
  established.
- Existing Solana-first backend and ES module architecture preserved.

## Phase 2 — Tenant foundation (complete and tested)

- Tenant registry and hashed API credentials (migration 0009).
- Tenant authentication hook, scope guard and rate limiting.
- Tenant-scoped wallet/address repositories with composite foreign keys.
- Cross-tenant isolation tests.

## Phase 3 — HD wallet and signing (complete and tested)

- BIP39 / SLIP-0010 Ed25519 derivation.
- Atomic index allocation under advisory lock and row lock.
- AES-256-GCM encrypted mnemonics with key versioning.
- One-time recovery token provisioning.
- Tenant-scoped signing boundary with lifecycle and network checks.
- Hot-wallet registry, freeze switch and single-transfer ceiling (migration 0013).

**External blocker:** production KMS/HSM signing is not integrated. The current
signer is application-layer encrypted key material and is reported as
`application_encrypted` in the dashboard.

## Phase 4 — Deposit infrastructure (complete and tested)

- Per-address scanner cursors with durable backfill progress.
- Parsed transaction verification, destination/amount checks and status
  evaluation.
- Idempotent persistence and confirmation/finality progression.
- Deposit reconciliation worker.
- Durable operational events and webhook outbox emission.

## Phase 5 — Withdrawal infrastructure (implemented; CI verified)

- Runtime tenant policy provider wired into the service composition root.
- Per-tenant policy-row lock serializes UTC daily/weekly amount and count limits.
- Fail-closed behavior for absent/disabled/frozen policy and zero/unconfigured limits.
- Native-SOL destination allowlist with pending/active/revoked lifecycle and
  second-admin activation.
- One-time approvals bound to tenant credential, active HD child wallet,
  allowlisted destination, network, SOL asset, exact lamport amount and
  canonical request hash; 15-minute maximum expiry.
- Approval consumption/revocation and append-only policy decision audit.
- Policy edits and emergency freezes invalidate unused approvals.
- Idempotency reservation precedes policy authorization; completed retries
  replay without re-consuming the approval.
- Signature persistence before broadcast, ambiguous-outcome reconciliation,
  hot-wallet guard and immutable transaction evidence.

**Production gates remain:** verify migrations against the real PostgreSQL
environment, review database roles/privileges, run concurrent withdrawal and
failure-injection tests, and complete an independent security review before
enabling mainnet withdrawals.

## Phase 6 — API and webhooks (complete and tested)

- Versioned `/api/v1/` partner API.
- Dashboard API under `/api/v1/dashboard/`.
- Tenant webhook endpoints with encrypted signing secrets and rotation.
- Durable outbox, HMAC signatures, retries, delivery tracking and replay.
- SSRF destination policy.

**Operational note:** the webhook delivery worker is opt-in via
`WEBHOOK_DELIVERY_ENABLED=true`.

## Phase 7 — Next.js dashboard (complete; build verified)

- `apps/wallet-web/` Next.js App Router + TypeScript + Tailwind.
- Overview, wallets, HD, child, hot, addresses, deposits, withdrawals,
  transactions, activity, webhooks, credentials, network, security controls, settings.
- Responsive layout, dark infrastructure theme, charts, QR codes, copy actions.
- English and Persian with full RTL.

## Phase 8 — Real-time infrastructure (complete and tested at the unit level)

- Durable `operational_events` table with append-only trigger.
- SSE stream with snapshot, cursor replay, heartbeats, reconnect backoff,
  duplicate protection and localStorage cursor.
- Dashboard query invalidation on live events.

## Phase 9 — Security and observability (partially implemented)

- Scrypt dashboard passwords, hashed session tokens, CSRF, HTTP-only cookies.
- Security headers, structured logs, health/readiness, scanner and outbox
  metrics.
- **Gap:** metrics/tracing backend, alert routing and KMS/HSM audit integration
  are deployment work, not included here.

## Phase 10 — Cloud deployment (documented, not provisioned)

- Deployment topology, environment separation, migration workflow, backups and
  rollback are documented in `DEPLOYMENT.md`.
- CI workflow exists for the backend test suite.
- **External blocker:** cloud accounts, managed PostgreSQL, secret manager,
  TLS ingress and RPC quotas are not available in this environment.

## Phase 11 — Verification (CI verified for current branch)

- Backend regression workflow includes tenant withdrawal policy service/API tests, scanner, ledger, reconciliation and migration suites.
- Dashboard workflow type-checks and builds the Next.js application.
- Exact pass counts and commit status are tracked in GitHub Actions; do not infer them from this roadmap.

## Remaining work before public production

1. Apply and verify policy migrations in staging; configure each tenant explicitly and complete independent security review.
2. Integrate KMS/HSM or an isolated signer service.
3. Provision cloud infrastructure, secrets and RPC providers.
4. Run concurrency, failure-injection, restore and chain-reorg drills.
5. Complete legal/compliance review for operating jurisdictions.