# Blackchin Solana Wallet Engine

A Solana wallet core with encrypted PostgreSQL storage and a Fastify REST API.

## Architecture

- `src/core`: framework-independent wallet, balance, receive and transfer use cases.
- `src/blockchain/solana`: Solana adapter.
- `src/infrastructure/database`: PostgreSQL repositories.
- `src/api`: Fastify HTTP server, routes and API-key authentication.
- `PostgreSQL/` and `Solana/`: existing storage and chain implementations retained during the incremental migration.
- `scripts/migrate.js`: versioned PostgreSQL migration runner.
- `migrations/`: ordered, immutable SQL migrations.
- `test/`: automated tests.

## Requirements and configuration

- Node.js 20+
- PostgreSQL
- Solana RPC endpoint
- Local `.env`

Copy `.env.example` to `.env` and fill in the real values. Never commit `.env`.

## Install

```bash
npm install
```

## Database migrations

All schema changes are managed through the migration runner. Do not execute migration files manually after adopting this system.

Check migration status:

```bash
npm run db:migrate:status
```

Apply all pending migrations:

```bash
npm run db:migrate
```

The runner:

- Discovers files matching `NNNN_description.sql` in `migrations/`.
- Applies migrations in numeric version order.
- Creates `schema_migrations` automatically.
- Records each migration's version, filename, SHA-256 checksum and applied timestamp.
- Uses a PostgreSQL advisory lock so two application instances cannot run migrations concurrently.
- Executes each migration and its history insert in one transaction.
- Stops if an applied migration is edited, renamed or removed (checksum/history drift).
- Never performs automatic rollback or destructive schema changes.

### Existing databases

The baseline migration `0001_wallets.sql` creates the encrypted wallets table and indexes if they do not already exist. The existing `0002_api_idempotency.sql` creates the API idempotency table if it does not already exist.

If you previously created these tables manually, running the migration is safe for these two migrations because their DDL uses `IF NOT EXISTS`. The runner will then record them in `schema_migrations`.

**Important:** back up production data before applying schema changes. Review every new migration before running it against production. Never modify a migration that has already been applied; create a new numbered migration instead.

### Adding a migration

Create the next unused version, for example:

`migrations/0003_add_transaction_ledger.sql`

Write forward-only SQL, review it, then run:

```bash
npm run db:migrate:status
npm run db:migrate
```

Do not reuse a version number. Do not edit an applied migration. Do not put secrets in migration files.

## Start the API

Run migrations before starting the API:

```bash
npm run db:migrate
npm run api:start
```

By default the API binds to `127.0.0.1`. Set `API_HOST=0.0.0.0` only behind a trusted network boundary and TLS-terminating reverse proxy.

## Authentication

All routes except `GET /health` require the `X-API-Key` header. The API refuses to start unless `API_ACCESS_KEY` is configured with at least 32 characters.

This is a single-service API key boundary, not multi-tenant end-user authentication. Do not expose it directly to browsers or the public internet. A production multi-tenant deployment must replace this with tenant-scoped JWT/OAuth authentication and database-level tenant isolation before serving multiple customers.

## REST API

Base path: `/api/v1`

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/wallets` | Create a wallet; returns metadata only |
| GET | `/wallets/:publicKey` | Read wallet metadata |
| GET | `/wallets/:publicKey/balance` | Read native SOL balance |
| GET | `/wallets/:publicKey/deposit-address` | Return deposit address |
| GET | `/wallets/:publicKey/transactions?limit=10` | Recent incoming native SOL transfers |
| GET | `/transfers/:signature?publicKey=...` | Verify an incoming transfer |
| POST | `/transfers/estimate` | Estimate fee and balance without broadcasting |
| POST | `/transfers` | Submit an approved native SOL transfer |

Every endpoint except `/health` requires `X-API-Key: <API_ACCESS_KEY>`.

### Estimate a transfer

```http
POST /api/v1/transfers/estimate
X-API-Key: <API_ACCESS_KEY>
Content-Type: application/json

{
  "fromPublicKey": "<stored-wallet-public-key>",
  "toPublicKey": "<recipient-public-key>",
  "amountSol": "0.1"
}
```

### Submit a transfer

The caller must explicitly set `approved: true` after presenting the estimate to an authorized operator/user. An idempotency key is mandatory. Reusing the same key with a different request is rejected. A request left in `processing` after a crash is not automatically rebroadcast.

```http
POST /api/v1/transfers
X-API-Key: <API_ACCESS_KEY>
Idempotency-Key: <unique-random-request-id>
Content-Type: application/json

{
  "fromPublicKey": "<stored-wallet-public-key>",
  "toPublicKey": "<recipient-public-key>",
  "amountSol": "0.1",
  "approved": true
}
```

**Important:** This endpoint broadcasts a real blockchain transaction after approval. Test with Devnet first. Never use a funded mainnet wallet during development.

## Security boundaries

- Private keys are never returned by REST endpoints.
- Private keys are decrypted only inside the signing path and are not logged.
- Transfer amounts are decimal strings and converted to integer lamports without floating-point arithmetic.
- API authentication fails closed when no API key is configured.
- Idempotency reservations prevent automatic duplicate submission after retries/crashes; stuck `processing` rows require reconciliation.
- The current API-key middleware is for a single trusted backend service. It is not a substitute for tenant/user auth or a production secrets manager.

## Tests

Migration runner tests (no database or blockchain transaction required):

```bash
npm run test:migrations
```

Solana transfer unit tests:

```bash
npm run test:solana
```

Wallet storage integration tests require a configured PostgreSQL database:

```bash
npm run test:wallet
```
