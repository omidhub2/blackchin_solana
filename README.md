# BLACKCHIN CORE

**Multi-tenant wallet and blockchain infrastructure for partner companies.**

BLACKCHIN CORE provides wallet infrastructure, deposit-address generation, blockchain monitoring, transaction verification and controlled transaction execution to companies through authenticated server-to-server APIs.

Partner companies own their customer relationship and internal financial accounting. BLACKCHIN operates the blockchain infrastructure and maintains the operational records required to secure, execute and reconcile blockchain activity.

> **Implementation status:** the current codebase is a Solana-first implementation. Multi-tenant company authentication, tenant-isolated authorization, EVM/TRON adapters, token transfers, production key-management integration and a complete webhook delivery platform are target capabilities, not claims about the current release. See [Product Specification](docs/PRODUCT_SPECIFICATION.md) and [Architecture](docs/ARCHITECTURE.md).

## Responsibility boundary

| Capability | BLACKCHIN CORE | Partner company |
|---|---|---|
| Blockchain nodes/RPC and chain adapters | Operates | Consumes API |
| Wallet roots, derived wallets and signing | Operates | Requests provisioning |
| Deposit addresses and chain monitoring | Operates | Assigns addresses to its users |
| On-chain transaction verification | Operates | Receives evidence/status |
| Withdrawal execution | Executes after authenticated company instruction and platform controls | Authenticates its customer and authorizes the business request |
| Customer balances and customer accounting | Not the source of truth | Owns and maintains |
| Double-entry customer ledger and customer holds | Not provided as company accounting | Owns and maintains |
| Infrastructure asset attribution and reconciliation | Maintains | Reconciles its own books against reports |

BLACKCHIN does not decide whether a partner's end customer has sufficient internal balance. The partner must authorize a withdrawal before requesting execution. BLACKCHIN independently enforces infrastructure-level security, wallet availability, policy limits and transaction safety.

## Product capabilities

1. Company onboarding, tenant identity, API credentials, scopes and key rotation.
2. Tenant-isolated wallet namespaces and HD wallet provisioning.
3. Deposit address generation and address-to-company attribution.
4. Blockchain adapters, RPC management, transaction scanning and confirmation tracking.
5. Deposit detection, verification, duplicate prevention and status reporting.
6. Withdrawal request validation, policy checks, secure signing, broadcast and finality tracking.
7. Asset and fee visibility for infrastructure wallets, with per-company operational attribution.
8. Durable webhooks, event replay, idempotency and transaction query APIs.
9. Audit trails, monitoring, reconciliation, emergency freeze and recovery operations.
10. Central administration for companies, networks, assets, wallets, policies and infrastructure health.

## Current implementation

- Node.js 20+ (ES modules), Fastify REST API and PostgreSQL.
- Solana native SOL wallet operations.
- Legacy standalone wallets and BIP39/SLIP-0010 Ed25519 HD roots/child accounts.
- AES-256-GCM encrypted secret storage, one-time recovery provisioning and idempotent withdrawal handling.
- Deposit and withdrawal reconciliation workers with PostgreSQL advisory locks and append-only evidence events.
- Ordered, checksum-verified PostgreSQL migrations.
- Initial tenant registry/hashed API credential schema foundation (not yet wired into runtime authentication or authorization).

**Not currently implemented:** production multi-tenant authentication/authorization/isolation (the additive tenant schema foundation exists but is not wired into runtime), EVM and TRON adapters, SPL/ERC-20/TRC-20 token operations, integrated KMS/HSM, full webhook delivery, partner-facing company administration, and a per-company operational asset attribution ledger. Do not expose the current single-credential API as a public multi-company service until the tenant-security phase is complete.

## Repository layout

```
src/api/              Fastify server, routes, authentication and validation
src/core/             Wallet, balance, deposit, withdrawal and reconciliation use cases
src/blockchain/       Chain adapters (currently Solana)
src/infrastructure/   PostgreSQL, encryption, signing and dependency wiring
migrations/           Forward-only SQL migrations
scripts/              Migration and operational scripts
test/                 Unit, API, database and worker tests
docs/                 Product, architecture, API, security, schema and operations
```

## Requirements and local setup

- Node.js 20+
- PostgreSQL 13+
- Solana RPC endpoint for the currently implemented chain adapter

```bash
npm install
cp .env.example .env
# Configure secrets locally; never commit .env.
npm run db:migrate
npm run api:start
```

Health endpoint: `GET /health`.

## Documentation

- [Product Specification](docs/PRODUCT_SPECIFICATION.md) — definitive product scope and company/core responsibility boundary.
- [Architecture](docs/ARCHITECTURE.md) — target system architecture, tenancy, data flow and service boundaries.
- [API Reference](docs/API_REFERENCE.md) — currently implemented HTTP contracts and their limitations.
- [Security](docs/SECURITY.md) — current security posture and mandatory controls before multi-tenant production.
- [Database Schema](docs/DATABASE_SCHEMA.md) — current schema and migration history.
- [HD Wallet Architecture](docs/HD_WALLET_ARCHITECTURE.md) — current Solana HD implementation.
- [Operations](docs/OPERATIONS.md) — setup, deployment, backups, monitoring and recovery.

## Tests

```bash
npm test
npm run check:imports
npm run test:migrations
```

Database-backed tests require a dedicated test PostgreSQL database. Never run tests against production wallets or funded production accounts.
