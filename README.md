# Blackchin Solana Wallet Engine

A Solana wallet core with encrypted PostgreSQL storage and a Fastify REST API.

## Architecture

- `src/core`: framework-independent wallet, balance, receive and transfer use cases.
- `src/blockchain/solana`: Solana adapter. Core use cases depend on this adapter, not Fastify.
- `src/infrastructure/database`: PostgreSQL repositories.
- `src/api`: Fastify HTTP server, routes and API-key authentication.
- `PostgreSQL/` and `Solana/`: existing storage and chain implementations retained during this incremental migration.
- `test/`: automated tests.
- `migrations/`: SQL migrations.

## Requirements

- Node.js 20+
- PostgreSQL with the existing `wallets` table and unique public-key index
- Solana RPC endpoint
- `.env` configured locally

Copy `.env.example` to `.env`, then fill in the real values. Never commit `.env`.

## Install and run

```bash
npm install
```

Apply the idempotency migration to the same database used by `DATABASE_URL`:

```bash
psql "$DATABASE_URL" -f migrations/0002_api_idempotency.sql
```

Start the API:

```bash
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

```bash
npm test
npm run test:wallet
npm run test:solana
```

The wallet-storage test requires a configured PostgreSQL database. The Solana transfer unit tests use deterministic fixtures and do not broadcast transactions.
