# Phase 6 — Production Readiness & Observability

## Scope

Phase 6 adds operational visibility and production guardrails without changing
wallet balances, signing policy, transaction semantics or ledger identity.

## Runtime endpoints

### `GET /health`

Minimal liveness endpoint. It confirms that the API process is responding and
does not depend on PostgreSQL or Solana RPC.

### `GET /health/ready`

Readiness endpoint. It reports only coarse status and safe aggregate telemetry:

- Primary PostgreSQL connectivity and latency.
- Optional tenant and deposit-worker database connectivity.
- PostgreSQL pool totals, idle connections and waiting requests.
- Solana RPC slot probe and latency.
- Deposit scanner, deposit reconciliation and withdrawal reconciliation state,
  lock ownership, staleness and failure counters.
- Webhook delivery scheduler state.
- Pending webhook count and age.
- Signed withdrawals awaiting reconciliation and their age.
- Ledger and reconciliation records requiring operator review.

A database failure, required RPC failure, or unhealthy enabled scanner/
reconciliation worker returns HTTP 503. Backlog thresholds and pool pressure
are reported in the `degraded` array without automatically disabling the API.

The endpoint never returns database URLs, RPC endpoints, hostnames, tenant IDs,
wallet addresses, signatures, API keys, request bodies or raw internal errors.

### `GET /metrics`

Prometheus text exposition. This endpoint is protected by the normal API key
middleware. It exports:

- HTTP request counters by method, registered route template and status.
- HTTP request duration histograms (p50/p95/p99 can be derived by Prometheus).
- Process uptime, resident memory and heap usage.
- PostgreSQL pool total/idle/waiting gauges.
- RPC availability and probe latency.
- Worker health and consecutive failure gauges.
- Webhook, signed-withdrawal and under-review backlog gauges.
- Worker failure counters.

Metric labels are deliberately bounded. Raw URL paths, query strings, wallet
addresses, signatures, tenant identifiers and arbitrary error text are never
labels.

## Durable operational alerts

Repeated worker failures and advisory-lock loss are written to the append-only
`operational_events` stream as `system.health_changed`. Alerts are throttled
per worker to one event per minute. The dashboard activity stream can replay
these records after reconnect.

Webhook delivery outcomes remain available through the existing webhook event
and operational event records.

## Health thresholds

| Signal | Degraded threshold |
|---|---:|
| PostgreSQL probe latency | 1,000 ms |
| Solana RPC probe latency | 1,500 ms |
| Waiting PostgreSQL pool requests | 2 |
| Consecutive worker failures | 3 |
| Pending webhook events | 1,000 |
| Oldest pending webhook age | 300 seconds |
| Oldest signed withdrawal awaiting reconciliation | 300 seconds |
| Any ledger/reconciliation under-review records | 1 or more |

These are initial operational thresholds, not universal capacity limits.
Tune them using production traffic and the selected RPC/database provider.

## PostgreSQL pool tuning

The primary API pool is configurable with:

- `DATABASE_POOL_MAX` (default 5; allowed 1–100)
- `DATABASE_POOL_MIN` (default 0; must not exceed max)
- `DATABASE_POOL_CONNECTION_TIMEOUT_MS` (default 10,000)
- `DATABASE_POOL_IDLE_TIMEOUT_MS` (default 30,000)
- `DATABASE_POOL_STATEMENT_TIMEOUT_MS` (default 15,000)

The readiness response exposes the live pool totals and waiting count. Do not
increase pool limits without checking PostgreSQL connection limits and the
combined pool sizes of API, tenant and background-worker processes.

## Worker failure handling

1. Scrape `/metrics` and poll `/health/ready`.
2. Inspect `system.health_changed` operational events for worker lock loss or
   repeated scan failures.
3. Check whether the worker owns its advisory lock and whether its last success
   is stale.
4. Check RPC availability and PostgreSQL pool waiting count.
5. Inspect the signed-withdrawal backlog before attempting any retry.
6. Transactions in `under_review` require evidence review; do not manually
   change their state just to clear a dashboard alert.

## Load test

The repository includes a dependency-free, opt-in HTTP load test:

```bash
npm run load:test -- --url http://127.0.0.1:3000/health/ready --duration 15 --concurrency 8
```

Limits: 1–300 seconds and 1–100 concurrent workers. Remote targets are blocked
unless `LOAD_TEST_ALLOW_REMOTE=true` is explicitly set. Set `API_ACCESS_KEY`
when testing an authenticated route. Run only against an approved environment;
never run a stress test against mainnet RPC or an unapproved production system.

The report includes throughput, status codes, transport errors and p50/p95/p99
latency. It does not print API keys or response bodies.

## Release gates before Mainnet

- Phase 2–5 PRs merged in order, then this Phase 6 PR.
- All migrations applied and checksums verified.
- `/health/ready` returns 200 with required workers healthy and lock-owning.
- `/metrics` is accessible only with the API key.
- No unexplained signed-withdrawal backlog or unresolved under-review records.
- RPC historical signature lookup and finalized transaction queries tested with
  the actual provider.
- Database pool limits validated against PostgreSQL's connection budget.
- Controlled load test completed on a staging deployment.
- Backup/restore and database point-in-time recovery procedures verified.
- A monitored Devnet fault-injection exercise completed before mainnet traffic.

Passing CI is necessary but does not prove production RPC capacity, provider
rate limits, failover behavior or mainnet readiness.
