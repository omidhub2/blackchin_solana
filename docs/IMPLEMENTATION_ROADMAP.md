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

## Phase 5 — Withdrawal infrastructure (complete and tested)

- Tenant policy preflight (fail closed when no provider is configured).
- Tenant-scoped idempotency with request binding.
- Signature persistence before broadcast.
- Reconciliation of ambiguous outcomes.
- Hot-wallet guard.
- Immutable transaction evidence and append-only reconciliation events.

**External blocker:** a reviewed `tenantWithdrawalPolicy.authorize` provider
must be deployed before public withdrawal submission is enabled.

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
  transactions, activity, webhooks, credentials, network, security, settings.
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

## Phase 11 — Verification (complete for this environment)

- Backend: `node --test` — 237 tests passing.
- Import graph: `npm run check:imports` — 0 problems.
- Frontend: `npx tsc --noEmit` and `next build` — successful.

## Remaining work before public production

1. Deploy and review the tenant withdrawal policy provider.
2. Integrate KMS/HSM or an isolated signer service.
3. Provision cloud infrastructure, secrets and RPC providers.
4. Run concurrency, failure-injection, restore and chain-reorg drills.
5. Complete legal/compliance review for operating jurisdictions.