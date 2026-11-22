# Operations

## 1. Install

```bash
npm install
```

Requirements: Node.js 20+, PostgreSQL 13+, a reachable Solana RPC endpoint.

## 2. Environment

Copy `.env.example` to `.env` and fill it in. Required variables:

| Variable | Required | Notes |
|---|---|---|
| `DATABASE_URL` | yes | remote hosts must include `sslmode=verify-full` |
| `ENCRYPTION_KEY` | yes | 64 hex chars (32 bytes); protects all wallet secrets |
| `API_ACCESS_KEY` | yes | ≥32 chars; single trusted-backend credential |
| `SOLANA_NETWORK` | no | `devnet` (default) \| `testnet` \| `mainnet-beta` |
| `SOLANA_RPC_URL` | no | HTTPS only; defaults to the public devnet RPC |
| `SOLANA_COMMITMENT` | no | `processed` \| `confirmed` (default) \| `finalized` |
| `SOLANA_WS_URL` | no | `wss://`; derived from the RPC URL when omitted |
| `ENCRYPTION_KEY_V<n>` | no | key rotation (see `SECURITY.md`) |
| `API_HOST` / `API_PORT` | no | `127.0.0.1` / `3000` |
| `DEPOSIT_RECONCILIATION_ENABLED` | no | `false`; set `true` to run periodic deposit chain checks |
| `DEPOSIT_RECONCILIATION_INTERVAL_MS` | no | `60000`; minimum `5000` ms |

The API refuses to start if `API_ACCESS_KEY` is missing/short or
`ENCRYPTION_KEY` is not 64 hex characters.

Generate secrets:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## 3. Database migrations

```bash
npm run db:migrate:status   # what is applied / pending
npm run db:migrate          # apply pending migrations
```

The runner takes a PostgreSQL advisory lock, applies each migration and its
history row in one transaction, verifies SHA-256 checksums of applied files and
aborts on drift. **Back up the database before migrating.** Never edit an
applied migration; add the next number.

The API also fails fast at startup if the schema is missing (it probes
`api_idempotency_keys`, `hd_wallets`, `wallet_accounts`,
`blockchain_transactions`, `deposit_reconciliation_cursors`).

## 4. Start the API

```bash
npm run db:migrate
npm run api:start
```

Health check: `GET http://127.0.0.1:3000/health` (no API key).

## 5. Development (devnet)

```bash
# .env
SOLANA_NETWORK=devnet
SOLANA_RPC_URL=https://api.devnet.solana.com
SOLANA_COMMITMENT=confirmed
```

1. `POST /api/v1/hd-wallets` → store `recovery.token` securely.
2. `POST /api/v1/hd-wallets/1/recovery-phrase/consume` with `{"confirm": true}`
   → write the phrase down offline.
3. `POST /api/v1/hd-wallets/1/accounts/batch` `{"count": 3}`.
4. Fund a child address from a devnet faucet, then
   `POST /api/v1/transfers/<signature>/confirm`.

Never run automated tests against mainnet or with funded wallets.

## 6. Production checklist

- [ ] `SOLANA_NETWORK=mainnet-beta`, dedicated paid RPC provider (public RPC is
      rate limited), `SOLANA_COMMITMENT=confirmed`.
- [ ] Secrets from a secret manager, not a checked-in `.env`.
- [ ] TLS-terminating reverse proxy; keep `API_HOST=127.0.0.1` unless the
      network boundary is explicit.
- [ ] Shared rate limiting at the ingress (the built-in limiter is per process).
- [ ] PostgreSQL: `sslmode=verify-full`, least-privilege role, restricted network
      access, PITR backups.
- [ ] Monitoring for HTTP 5xx, `RPC_ERROR`, `RPC_RATE_LIMITED`, and rows in
      `api_idempotency_keys` with `status='processing'` older than a few minutes.
- [ ] Process supervisor with graceful shutdown (`SIGTERM` closes Fastify and
      the pool).
- [ ] Confirm the custody limitation in `SECURITY.md` is acceptable before
      exposing the API beyond a trusted backend.

## 7. Backup and recovery

- Back up the database **and** the encryption key separately.
- Restore drill: restore into a staging database, start the API with a staging
  key, verify `GET /api/v1/hd-wallets/:id` and one child balance.
- Lost database, kept mnemonic: re-derive every child address/key offline with
  `deriveSolanaAccount(mnemonic, index)`
  (`src/blockchain/solana/hd/derivation.js`) for each known index.
- Lost encryption key: stored wallet secrets are unrecoverable; only an offline
  mnemonic copy allows recovery of HD children.

## 8. Reconciliation of stuck withdrawals

Rows in `api_idempotency_keys` with `status='processing'` mean a broadcast may
have happened but completion was not recorded. Check the stored
`transaction_signature`/logs and the chain for the sender address, then either:

- confirm the transaction exists → mark the row `completed` with the real
  response, or
- confirm nothing was broadcast → mark it `failed` so the caller may retry with
  a new key.

Never delete the row: it is the only guard against a duplicate send.


## 9. Deposit reconciliation

Migration `0007_deposit_reconciliation.sql` creates a durable keyset cursor and
append-only verification events. After applying migrations, enable the worker
with:

```dotenv
DEPOSIT_RECONCILIATION_ENABLED=true
DEPOSIT_RECONCILIATION_INTERVAL_MS=60000
```

The worker checks recorded deposits in bounded batches, re-fetches transaction
evidence from the configured Solana RPC, records `consistent`,
`under_review`, `recovered`, or `rpc_error` events, and resumes after
restarts. A PostgreSQL advisory lock prevents two instances from reconciling
the same network concurrently. RPC failures trigger worker backoff and do not
advance the cursor past the unverifiable transaction.

This worker does **not** credit, debit, or otherwise mutate wallet balances.
A transaction moved to `under_review` requires operator investigation. The
current service exposes on-chain wallet balances and has no customer-owned
internal accounting ledger, so there is no safe internal balance compensation
to perform yet. Never correct balances by editing wallet or transaction rows.

The readiness endpoint includes the reconciliation worker state when enabled.

## 10. Troubleshooting

| Symptom | Likely cause / action |
|---|---|
| `API STARTUP FAILED` + relation does not exist | run `npm run db:migrate` |
| `API_ACCESS_KEY must be configured` | missing/short key in `.env` |
| `ENCRYPTION_KEY must contain exactly 64 hexadecimal characters` | wrong format |
| `Decryption failed: authentication failed` | wrong key version or tampered row; check rotation variables |
| `409 A request with this Idempotency-Key is already processing` | reconcile the stuck key (section 8) |
| `503 RPC_RATE_LIMITED` | provider quota; use a dedicated RPC or back off |
| `502 RPC_ERROR` | RPC/network failure; retry after checking provider status |
| `MIGRATION_DRIFT` | an applied migration file was edited; restore the original file |

## 11. Tests

```bash
npm run test:unit       # crypto, services, ledger, API (no DB, no network)
npm run test:hd         # HD crypto/services only
npm run test:api        # HTTP contract tests
npm run test:solana     # lamport math + transfer extraction
npm run test:migrations # migration runner
npm run check:imports   # ESM import/export integrity
npm run test:wallet     # requires a real PostgreSQL database
```
