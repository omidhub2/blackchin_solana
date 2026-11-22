# BLACKCHIN — Cloud Deployment

BLACKCHIN is designed to run independently of a developer workstation.

## 1. Deployable units

| Unit | Responsibility |
|---|---|
| API service | Fastify partner + dashboard API, SSE stream |
| Deposit scanner worker | Address scanning and deposit verification |
| Deposit reconciliation worker | Re-verifies recorded deposits |
| Withdrawal reconciliation worker | Resolves ambiguous withdrawals |
| Webhook delivery worker | Durable outbox delivery |
| Dashboard web | Next.js App Router frontend |
| PostgreSQL | Durable operational state |
| Signer/KMS boundary | Production key custody (target) |

Workers may run as separate processes or as opt-in loops in the API process for
small deployments. Production should scale API and workers independently.

## 2. Environment separation

Use separate configuration, databases, RPC endpoints, encryption keys and
wallet roots for:

- development,
- test/CI,
- staging,
- production.

Never restore production keys into staging or development.

## 3. Required environment

Backend:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL with `sslmode=verify-full` |
| `ENCRYPTION_KEY` | 64 hex chars; protects wallet material and webhook secrets |
| `ENCRYPTION_KEY_V<n>` | Optional rotation versions |
| `API_ACCESS_KEY` | Legacy trusted-backend credential (32+ chars) |
| `SOLANA_NETWORK` | `devnet`, `testnet` or `mainnet-beta` |
| `SOLANA_RPC_URL` | HTTPS RPC endpoint |
| `SOLANA_COMMITMENT` | `processed`, `confirmed` or `finalized` |
| `DEPOSIT_SCANNER_ENABLED` | Enable scanner |
| `DEPOSIT_RECONCILIATION_ENABLED` | Enable deposit reconciliation |
| `WITHDRAWAL_RECONCILIATION_ENABLED` | Enable withdrawal reconciliation |
| `WEBHOOK_DELIVERY_ENABLED` | Enable webhook worker |
| `WEBHOOK_ENDPOINT` / `WEBHOOK_SECRET` | Optional legacy fallback endpoint |
| `DASHBOARD_COOKIE_SECURE` | `true` in production behind TLS |
| `API_HOST` / `API_PORT` | Bind address |

Frontend:

| Variable | Purpose |
|---|---|
| `BLACKCHIN_API_URL` | Backend origin used by Next.js rewrites |

Secrets must come from a managed secret store, never from committed files.

## 4. First deployment

1. Provision PostgreSQL with TLS, private networking, automated backups and
   point-in-time recovery.
2. Provision a paid/redundant Solana RPC provider.
3. Store secrets in the cloud secret manager.
4. Run migrations with a least-privilege migration role:

   ```bash
   npm ci
   npm run db:migrate:status
   npm run db:migrate
   ```

5. Create the first dashboard operator:

   ```bash
   DASHBOARD_USER_EMAIL=ops@example.com \
   DASHBOARD_USER_PASSWORD='<12+ chars>' \
   npm run dashboard:user -- --name='Operations' --role=admin
   ```

6. Start the API and enabled workers.
7. Build and start the dashboard:

   ```bash
   cd apps/wallet-web
   npm ci
   BLACKCHIN_API_URL=https://api.example.com npm run build
   npm start
   ```

8. Put both services behind TLS ingress.

## 5. Reverse proxy

- Terminate TLS at the ingress.
- Route `/api/v1/*` to the Fastify API.
- Route the dashboard origin to Next.js.
- Keep `/api/v1/dashboard/stream` on a proxy path that disables response
  buffering (`X-Accel-Buffering: no` is already sent by the API).
- Set request body limits and timeouts.
- Do not expose PostgreSQL or RPC credentials.

The Next.js app rewrites `/api/v1/dashboard/*` to `BLACKCHIN_API_URL`, keeping
the dashboard session cookie same-origin.

## 6. Database operations

- Back up before every migration.
- Apply migrations in a transaction per file under an advisory lock.
- Never edit an applied migration; add the next numbered file.
- Use a non-owner application role.
- Test restore and migration on a disposable database.
- Purge expired dashboard sessions periodically.

## 7. Backups and disaster recovery

- Encrypted PostgreSQL backups with PITR and off-site retention.
- Back up key-management metadata and recovery procedures separately.
- Test wallet derivation recovery from the mnemonic in isolated staging.
- Define RPO/RTO and run incident simulations.
- Never restore production keys into non-production environments.

## 8. Observability

Monitor:

- API latency, 4xx/5xx, auth failures and rate-limit events,
- PostgreSQL availability, connections, replication lag and backup age,
- RPC health, latency, error rate and chain lag,
- scanner cursor age and reconciliation backlog,
- withdrawals stuck in `processing`,
- webhook retry counts, oldest undelivered event and dead-letter state,
- signer availability and policy denials,
- dashboard SSE connection count and reconnect rate.

Logs must never contain secrets, mnemonics, API keys, session tokens or
passwords.

## 9. CI/CD

- CI runs the backend test suite, import checks and migration tests.
- Build the dashboard with `npm run build`.
- Deploy immutable artifacts.
- Run migrations as a separate, approved step before application rollout.
- Roll back application code independently; migrations are forward-only.

## 10. Rollback

1. Stop new worker side effects if a signing or scanner defect is suspected.
2. Roll back application artifacts to the previous release.
3. Do not reverse an applied migration destructively.
4. Use compensating migrations or forward fixes.
5. Reconcile ambiguous chain operations before resuming withdrawals.

## 11. Current external blockers

- Cloud accounts, managed PostgreSQL, secret manager, TLS ingress and RPC
  quotas are not provisioned in this repository.
- KMS/HSM signing is not integrated.
- The tenant withdrawal policy provider must be deployed before public
  withdrawal submission is enabled.