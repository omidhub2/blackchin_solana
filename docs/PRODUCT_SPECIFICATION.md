# BLACKCHIN CORE — Product Specification

**Status:** Target product definition. Capability status is explicitly identified; this document does not imply that every target feature is implemented.

## 1. Product definition

BLACKCHIN CORE is a central, multi-tenant wallet and blockchain infrastructure service. Independent companies integrate with it through authenticated server-to-server APIs. BLACKCHIN provisions and operates blockchain wallets, generates deposit addresses, monitors networks, verifies deposits, securely signs and broadcasts authorized withdrawals, and reports transaction evidence and status.

The product is infrastructure-as-a-service. It is not the partner's customer-facing exchange, payment application, customer balance database or customer accounting system.

## 2. Non-negotiable responsibility boundary

### BLACKCHIN CORE owns

- Blockchain network connectivity, chain adapters and RPC provider management.
- Wallet provisioning, derivation, address generation and secure signing.
- Association of every wallet, address, transaction and operation with exactly one tenant.
- Deposit discovery, on-chain verification, confirmation/finality tracking and duplicate prevention.
- Execution of authenticated withdrawal instructions, subject to independent platform controls.
- Infrastructure-level asset visibility, fee tracking, operational attribution and chain reconciliation.
- API authentication, authorization, idempotency, audit evidence, event delivery and operational monitoring.
- Central emergency controls, key lifecycle, backups and disaster recovery.

### Each partner company owns

- Its end users, customer identity and customer-facing application.
- Customer balances, available/held balances and all customer liabilities.
- Its own double-entry accounting ledger and financial statements.
- Customer deposit-credit decisions and internal posting rules.
- Customer withdrawal eligibility, internal approval and customer-level limits.
- Customer support, account statements and reconciliation of its books to BLACKCHIN's transaction reports.

A partner must authorize a customer's withdrawal in its own system before calling the BLACKCHIN withdrawal API. A request field such as `approved: true` is not sufficient proof by itself in the target multi-tenant design; authorization must be bound to the authenticated tenant, request body, idempotency key and configured policy.

### What BLACKCHIN records about money

BLACKCHIN must maintain operational asset records and per-tenant attribution sufficient to answer: which tenant's operation caused an on-chain movement, which infrastructure wallet was used, which asset/network was involved, what fees were consumed, and what is the verified chain outcome.

These records are not a customer-balance ledger and must never be presented as the partner's Double-Entry customer accounting. Operational asset attribution must be reconcilable to wallet balances and chain evidence. Any legal characterization of custody, safeguarding or money transmission requires jurisdiction-specific legal review; technical architecture alone does not determine it.

## 3. Tenant model

- Every partner is a tenant with an immutable internal tenant ID and lifecycle status.
- Every API credential belongs to one tenant, has explicit scopes, status, creation/expiry metadata and rotation/revocation support.
- Tenant identity is derived from validated credentials, never trusted from a caller-supplied `tenantId`.
- Every tenant-owned wallet root, address assignment, transaction request, webhook, policy and report is tenant-scoped.
- Cross-tenant reads and writes must fail closed. Tenant filters are mandatory in repository interfaces and database constraints; database row-level security may provide defense in depth.
- Platform operators have separate privileged identities and audited break-glass access.
- Tenant-specific rate limits, withdrawal policies, supported assets and webhook configuration are centrally managed.

Migration 0009 introduces the initial tenant registry and hashed API credential schema plus nullable tenant attribution columns. These are not yet wired to runtime authentication, scope checks or tenant-scoped repositories. The current `hd_wallets.owner_id` column remains a legacy placeholder. No tenant isolation claim is valid until the full tenant boundary is implemented and tested.

## 4. Product modules

### 4.1 Company and API management

- Create, suspend, reactivate and offboard partner companies.
- Issue, hash-at-rest, rotate and revoke tenant API credentials.
- Support scopes, environment separation (sandbox/production), IP allowlists where configured, request signatures/timestamps/nonces, rate limits and audit logs.
- Provide company-level configuration for supported networks, assets, confirmation policies, withdrawal limits and webhooks.
- Never expose platform master secrets or signing keys to partners.

### 4.2 Wallet infrastructure

- Create a tenant-isolated wallet namespace/root for each supported chain and purpose.
- Derive deposit addresses using a documented, versioned derivation scheme where the chain supports it.
- Keep tenant namespaces and derivation paths separated. Do not reuse an address across tenants unless an explicit, reviewed chain-specific design proves safe attribution.
- Support wallet lifecycle states, address labels, allocation metadata and recovery procedures.
- Store private key material encrypted or in a KMS/HSM-backed signer. Database encryption alone is not a substitute for production key isolation.
- Support hot/warm/cold wallet policy as a later operational capability; hot-wallet exposure must be limited.

### 4.3 Network and asset adapters

Target networks:
- Solana.
- EVM-compatible chains, each configured by chain ID (for example Ethereum, BNB Smart Chain and Polygon).
- TRON.

Target assets include native coins and explicitly configured tokens (for example SOL, ETH, BNB, TRX, USDT and USDC where the relevant network/contract is approved).

Each adapter must define address format, derivation/signing, transaction parsing, token contract/program validation, decimals, fee model, confirmation/finality model, reorg behavior, nonce/sequence handling and idempotency identity. Token symbols are not globally unique; identify tokens by network plus canonical contract/mint address. Unsupported assets must be rejected explicitly, never silently ignored.

**Current status:** only native SOL operations are implemented and tested. EVM, TRON and token support are target capabilities.

### 4.4 Deposits

1. Partner requests or retrieves an address for a tenant-owned wallet/account and optionally supplies its own opaque customer reference.
2. BLACKCHIN returns the address, network, asset and an immutable address/reference identifier.
3. Scanner discovers incoming chain activity and records raw transaction evidence.
4. Adapter validates network, destination, asset contract/mint, amount, success and chain-specific confirmation/finality.
5. Duplicate transaction/log events are rejected using a chain-specific unique identity.
6. BLACKCHIN updates the operational transaction state and emits a durable event/webhook.
7. Partner independently applies its customer-accounting and crediting rules.

Deposit states must distinguish detected, verifying, confirming, confirmed/finalized, under review, failed/rejected and credited-notified (notification delivery is separate from on-chain finality). BLACKCHIN does not write a partner's customer balance.

### 4.5 Withdrawals

1. Partner authenticates its customer and approves the business withdrawal in its own system.
2. Partner sends a tenant-authenticated withdrawal instruction with asset, network, source wallet, destination, exact amount, fee policy, opaque partner reference and idempotency key.
3. BLACKCHIN validates tenant ownership, scopes, wallet status, asset/network support, destination policy, limits, available infrastructure funds, fee/gas and risk controls.
4. The request is durably reserved as an operational execution intent before signing. This is an infrastructure execution reservation, not a customer accounting hold.
5. A controlled signer signs and the adapter broadcasts. Persist the signed transaction/signature before any retry decision that could cause rebroadcast.
6. BLACKCHIN tracks confirmations/finality and reconciles ambiguous outcomes. Unknown outcomes remain unresolved; they must not be treated as failed merely due to timeout, and must not be blindly rebroadcast.
7. Partner receives durable status events and queries the transaction. It settles or releases its own customer-side hold according to its accounting policy.

The database transaction cannot make an external blockchain broadcast atomic. Use a durable state machine/outbox/saga, chain-specific idempotency and reconciliation.

### 4.6 Transaction API and webhooks

- Query a transaction by BLACKCHIN operation ID, chain transaction hash/signature or partner reference within the authenticated tenant.
- Return normalized status plus chain-specific evidence and fee fields.
- Deliver signed webhooks with event ID, tenant ID, event type, schema version, creation time and payload.
- Use transactional outbox, retries with backoff, delivery-attempt records, dead-letter state and replay.
- Require HTTPS endpoints, signing-secret rotation, timestamp/replay protection and SSRF protections. Do not allow private/link-local/metadata destinations.
- Webhook delivery is at-least-once; partners must deduplicate by immutable event ID. Never promise exactly-once network delivery.

**Current status:** a complete partner webhook delivery system and tenant-scoped event API are not yet implemented.

### 4.7 Asset operations and reconciliation

- Track wallet balances and token holdings by network, asset and address.
- Attribute every wallet/address/transaction to a tenant and operational purpose.
- Track network fees, sweeps, consolidation, treasury movements and unknown/unmatched transfers.
- Compare indexed/internal transaction evidence against authoritative chain/RPC data.
- Detect balance drift, missing events, duplicate observations, reorgs and unexplained movements.
- Maintain append-only audit evidence and immutable operation identity.
- Produce tenant-filtered reports and platform-wide treasury/health views.

Do not infer customer liabilities from on-chain wallet balances. A shared or pooled wallet requires explicit per-tenant allocation accounting and strict reconciliation; the preferred initial design is tenant-isolated wallet namespaces and addresses.

### 4.8 Central administration and observability

- Tenant lifecycle, API credentials and access scopes.
- Network/RPC provider health and chain lag.
- Wallet/address inventory and infrastructure balances.
- Deposit/withdrawal queues, stuck and under-review operations.
- Fee/gas funding and low-balance alerts.
- Webhook delivery, retry and dead-letter queues.
- Risk rules, allowlists, limits and emergency freeze.
- Structured audit logs, metrics, traces, alerts and incident history.

## 5. Core invariants

1. No cross-tenant data access or signing.
2. No secret/private key in API responses, logs, traces or ordinary database columns.
3. No floating-point arithmetic for amounts; use integer smallest units or exact decimal types.
4. Every transaction identity is chain-aware and unique.
5. Every write path is idempotent or has an explicit replay policy.
6. A withdrawal with uncertain broadcast/finality remains reserved for investigation; never automatically resend or release on timeout alone.
7. An event is emitted only from durable committed state (transactional outbox).
8. On-chain evidence, operational state and partner customer accounting remain distinct.
9. Posted evidence is append-only; corrections use compensating records, not destructive edits.
10. Production readiness requires concurrency, failure-injection, tenant-isolation and real PostgreSQL integration tests.

## 6. Delivery phases

1. **Documentation and boundary:** establish this product scope, architecture, threat model and current-vs-target capability matrix.
2. **Tenant foundation:** company registry, tenant credentials/scopes, repository tenant context, database constraints and cross-tenant tests.
3. **Wallet tenancy:** tenant-specific wallet roots, address allocation, signer authorization and secure key-provider interface.
4. **Chain abstraction:** stable adapter contract; complete Solana adapter; then EVM and TRON adapters and token standards.
5. **Deposit platform:** continuous scanners, confirmation/finality, normalized transaction model, address attribution and durable events.
6. **Withdrawal platform:** tenant-authorized execution intents, policy engine, signer controls, durable broadcast state and reconciliation.
7. **Webhooks and reporting:** transactional outbox, delivery/replay, tenant reports and partner integration contract.
8. **Production controls:** KMS/HSM, shared rate limits, observability, incident response, backups, restore drills and independent security review.

Each phase requires tests and documentation updates. Do not claim a phase complete solely because interfaces or placeholder columns exist.
