# Blackchin Solana Wallet Engine

Custodial Solana wallet core with **HD (hierarchical deterministic) wallets**,
encrypted PostgreSQL storage and a Fastify REST API.

## What it does

- **Legacy standalone wallets** — `Keypair.generate()`, stored encrypted
  (unchanged behaviour and endpoints).
- **HD roots** — a BIP39 (24-word) mnemonic per root, encrypted with
  AES-256-GCM; children derived with SLIP-0010 Ed25519 at
  `m/44'/501'/{accountIndex}'/0'`.
- **Concurrency-safe child creation** — up to 50 accounts per request, indexes
  allocated under a row lock with unique constraints as the final guard.
- **Native SOL operations** for both wallet types: balance (single + aggregate),
  deposit address, incoming transaction verification and idempotent deposit
  recording, fee estimation, and approved withdrawals with an immutable ledger.
- **No private keys or mnemonics in normal API responses.** The recovery phrase
  is available exactly once through a purpose-bound one-time token.

SPL tokens are **not** supported; only native SOL is implemented and tested.

## Architecture

```
src/api                  Fastify server, routes, API-key auth, rate limits, validation
src/core                 use cases: hd-wallets, wallets (children), balance,
                         deposits, withdrawals, transactions, standalone wallets
src/blockchain/solana    adapter + hd/ (BIP39, SLIP-0010, derivation)
src/infrastructure       PostgreSQL repositories, encryption, signer, wiring
PostgreSQL/ Solana/      pre-existing storage and chain implementations (kept)
config/                  Solana connection (commitment, RPC/WS endpoints)
migrations/              ordered SQL migrations (0001-0003)
scripts/migrate.js       versioned migration runner
```

Details: [`docs/HD_WALLET_ARCHITECTURE.md`](docs/HD_WALLET_ARCHITECTURE.md).

## Requirements

- Node.js 20+
- PostgreSQL 13+
- A Solana RPC endpoint (devnet by default)

## Install and configure

```bash
npm install
cp .env.example .env      # then fill in DATABASE_URL, ENCRYPTION_KEY, API_ACCESS_KEY
```

## Migrations

```bash
npm run db:migrate:status
npm run db:migrate
```

Migration `0003_hd_wallets.sql` is additive: existing wallets are preserved and
are **not** converted into HD children. Back up the database first.

## Run

```bash
npm run api:start
curl http://127.0.0.1:3000/health
```

## API at a glance

Base path `/api/v1`, `X-API-Key` required on every route except `/health`.

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/hd-wallets` | create an HD root (returns one-time recovery token) |
| GET | `/hd-wallets/:id` | root metadata |
| PATCH | `/hd-wallets/:id` | change root status |
| POST | `/hd-wallets/:id/recovery-phrase/consume` | one-time phrase provisioning |
| GET | `/hd-wallets/:id/derive/:accountIndex` | deterministic address recovery check |
| GET/POST | `/hd-wallets/:id/accounts` | list / create child wallets |
| POST | `/hd-wallets/:id/accounts/batch` | batch child creation |
| GET | `/hd-wallets/:id/accounts/:accountIndex` | child by derivation index |
| GET | `/hd-wallets/:id/balance` | aggregate child balance |
| GET | `/hd-wallets/:id/transactions` | deposits + withdrawals |
| POST | `/wallets` | standalone wallet (legacy) |
| GET | `/wallets/:publicKey` | wallet metadata (standalone or child) |
| GET | `/wallets/:publicKey/balance` | single wallet balance |
| GET | `/wallets/:publicKey/deposit-address` | deposit address |
| GET | `/wallets/:publicKey/transactions` | live incoming SOL scan |
| GET | `/wallets/:publicKey/deposits` `/withdrawals` | recorded ledger |
| GET | `/transfers/:signature?publicKey=` | verify an incoming transfer |
| POST | `/transfers/:signature/confirm` | verify + record a deposit (idempotent) |
| GET | `/deposits/:signature?publicKey=` | refresh deposit confirmation |
| POST | `/transfers/estimate` | fee/balance preview |
| POST | `/transfers` | approved withdrawal (Idempotency-Key required) |

Full reference: [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md).

### Quick start on devnet

```bash
curl -s -X POST http://127.0.0.1:3000/api/v1/hd-wallets \
  -H "X-API-Key: $API_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"label":"treasury"}'

curl -s -X POST http://127.0.0.1:3000/api/v1/hd-wallets/1/accounts/batch \
  -H "X-API-Key: $API_ACCESS_KEY" -H 'content-type: application/json' \
  -d '{"count":3}'

curl -s http://127.0.0.1:3000/api/v1/hd-wallets/1/balance \
  -H "X-API-Key: $API_ACCESS_KEY"
```

## Security posture

- AES-256-GCM for every stored secret, AAD-bound to the record, key-versioned
  for rotation.
- Withdrawals need the API key, `approved: true`, and a fresh idempotency key;
  a crashed/uncertain broadcast is never replayed automatically.
- Deposits are recorded once per `(signature, wallet, direction)`.
- The API key authenticates **one trusted backend**, not end users. Do not expose
  the service publicly without tenant authentication. See
  [`docs/SECURITY.md`](docs/SECURITY.md).

## Documentation

- [`docs/HD_WALLET_ARCHITECTURE.md`](docs/HD_WALLET_ARCHITECTURE.md) — derivation scheme, recovery, signing
- [`docs/API_REFERENCE.md`](docs/API_REFERENCE.md) — endpoints and error codes
- [`docs/SECURITY.md`](docs/SECURITY.md) — custody model, encryption, threat model
- [`docs/DATABASE_SCHEMA.md`](docs/DATABASE_SCHEMA.md) — tables, constraints, migrations
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — install, deploy, backup, reconciliation, troubleshooting

## Tests

```bash
npm run test:unit       # no database, no blockchain
npm run test:hd         # HD crypto + services
npm run test:api        # HTTP contracts
npm run test:solana
npm run test:migrations
npm run check:imports
npm run test:wallet     # requires PostgreSQL
```

## Legacy CLIs

`npm run wallet:create`, `npm run sol:receive`, `npm run sol:send` and
`node PostgreSQL/show-wallet.js` still operate on standalone wallets.
