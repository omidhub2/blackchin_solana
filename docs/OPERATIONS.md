# Operations and Cloud Deployment

## 1. Current runtime requirements

- Node.js 20+
- PostgreSQL 13+
- Solana RPC endpoint for current implementation
- Environment secrets supplied outside source control

Current scripts:

```bash
npm install
npm run db:migrate:status
npm run db:migrate
npm run api:start
npm test
npm run check:imports
```

The current API is a single-credential trusted-backend service. Do not expose it as a public multi-tenant partner API until the tenant-security requirements in `SECURITY.md` are implemented.

## 2. Configuration

Copy `.env.example` to a local `.env` for development only. Never commit `.env`, print secrets in logs, or paste secret values into support requests.

| Setting | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL connection; remote DB requires certificate verification |
| `ENCRYPTION_KEY` / versioned keys | current AES-256-GCM wallet-secret encryption |
| `API_ACCESS_KEY` | current single trusted-backend API credential |
| `SOLANA_NETWORK` | current Solana cluster |
| `SOLANA_RPC_URL` / `SOLANA_WS_URL` | chain RPC and websocket |
| `SOLANA_COMMITMENT` | current Solana commitment policy |
| Deposit/withdrawal reconciliation flags and intervals | enable current reconciliation workers |

The exact accepted variables/defaults are defined in `.env.example` and runtime configuration. Do not assume EVM/TRON configuration exists until those adapters are implemented.

## 3. Cloud target topology

Run independent deployable processes or services for:
- API gateway and partner-facing REST API.
- Deposit scanner workers, partitioned by network and tenant/wallet scope.
- Withdrawal orchestration and reconciliation workers.
- Webhook delivery workers.
- Signer/KMS boundary, separated from general API runtime.
- Central administration and observability.

Use a managed PostgreSQL service in private networking with TLS certificate verification, automated backups and point-in-time recovery. Store secrets in a cloud secret manager. Use a TLS ingress/load balancer with WAF, request-size limits and shared rate limiting. Use paid/redundant RPC providers with provider health monitoring and failover policy.

Scale API and workers independently. All worker jobs must be idempotent and safe under multiple replicas. Distributed locks must be database-backed or use a proven coordination service; loss of ownership must stop new side effects. Do not assume an in-process mutex is sufficient.

## 4. Production security gates

Before public partner onboarding:
- Complete tenant registry, per-tenant credentials/scopes and revocation.
- Enforce tenant scope in every repository query and signer operation.
- Add tenant-aware idempotency and cross-tenant integration tests.
- Deploy KMS/HSM or approved isolated signer with audited key access.
- Enable shared rate limiting and durable signed webhooks.
- Configure network/asset allowlists, withdrawal policy limits and emergency freeze.
- Separate production/staging databases, RPC credentials, keys and wallet roots.
- Use non-owner application DB role and least-privilege migration role.
- Configure alerting, incident response, on-call ownership and tested recovery procedures.

## 5. Database migrations

Migrations are ordered, checksum-verified and applied in a transaction per file. Never edit an applied migration. Back up before applying new migrations. Test migrations against a disposable PostgreSQL database and restore a backup in staging.

For tenancy backfills, do not infer ownership from wallet labels or transaction history. Map existing data to a tenant only with verified evidence; otherwise quarantine it and prevent signing until an operator resolves ownership.

## 6. Monitoring and alerts

Monitor at minimum:
- API latency, 4xx/5xx rates, authentication failures and tenant rate-limit events.
- PostgreSQL availability, connection saturation, replication lag and backup age.
- RPC provider health, chain lag, scan cursor age and confirmation latency.
- Deposit/withdrawal operations stuck in processing, confirming or under review.
- Ambiguous broadcasts and reconciliation backlog.
- Wallet balances, fee/gas reserve thresholds and unexplained movements.
- Worker lock loss, restart loops and duplicate processing attempts.
- Webhook retry counts, oldest undelivered event and dead-letter queue.
- Signer/KMS access, policy denials and emergency freeze events.

Never alert with private keys, mnemonics, API secrets or full sensitive request bodies.

## 7. Backup and disaster recovery

- Back up PostgreSQL with PITR and encrypted off-site retention.
- Back up key-management metadata and recovery procedures separately from database backups.
- Test database restore and wallet derivation recovery in isolated staging.
- Maintain documented key rotation and signer recovery procedures.
- Never restore production keys into development or staging.
- Define RPO/RTO and run periodic incident simulations before production launch.

## 8. Current reconciliation behavior

Deposit and withdrawal reconciliation workers currently verify Solana transaction evidence and persist cursor/event history. They do not post partner customer credits/debits and do not create customer monetary holds. A withdrawal idempotency row is not a reserved customer balance. Unknown or ambiguous chain outcomes must remain unresolved until evidence is authoritative.

## 9. Release checklist

- [ ] Tests, import checks and migration tests pass.
- [ ] Tenant isolation and signer-boundary tests pass (required for multi-tenant release).
- [ ] Migrations reviewed and backup completed.
- [ ] Secrets injected from secret manager.
- [ ] TLS, private networking, shared rate limits and least privilege verified.
- [ ] RPC failover, chain finality and ambiguous broadcast recovery tested.
- [ ] Alerts, audit trail, on-call and rollback/restore plan verified.
- [ ] Legal/compliance review completed for custody and operating jurisdictions.
