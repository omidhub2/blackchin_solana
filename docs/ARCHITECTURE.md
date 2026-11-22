# BLACKCHIN CORE — System Architecture

**Architecture target:** cloud-hosted, multi-tenant wallet/blockchain infrastructure.  
**Current implementation:** single-credential Solana-first service; not yet safe to expose as a public multi-tenant platform.

## 1. Logical architecture

```
Partner Company A ─┐
Partner Company B ─┼── HTTPS / authenticated server-to-server API
Partner Company N ─┘                    │
                                       ▼
                           API Gateway / Tenant Auth
                                       │
                         Tenant Context + Authorization
                                       │
              ┌────────────────────────┼──────────────────────┐
              ▼                        ▼                      ▼
       Wallet Service            Deposit Service       Withdrawal Service
              │                        │                      │
              ▼                        ▼                      ▼
       Wallet Registry          Scanner / Verifier      Policy / Risk Engine
              │                        │                      │
              └────────────────────────┼──────────────────────┘
                                       ▼
                          Chain Adapter Interface
                           │          │          │
                        Solana       EVM        TRON
                           │          │          │
                         RPC / Indexer / Signer / Broadcaster
                                       │
                                       ▼
                       Transaction State + Reconciliation
                                       │
                           Transactional Event Outbox
                                       │
                         Signed Webhooks / Query API
                                       │
                         Partner Company Systems
                    (customer ledger remains partner-owned)
```

Cross-cutting infrastructure: PostgreSQL, encrypted secret storage/KMS, distributed locks, shared rate limits, audit logs, metrics/traces, alerting, backups and disaster recovery.

## 2. Service boundaries

- **API Gateway:** TLS boundary, request size/schema validation, credential authentication, rate limits and correlation IDs.
- **Tenant Authorization:** resolves tenant from credential; checks tenant status, scope, wallet ownership and policy. Caller-provided tenant IDs are metadata only and never authority.
- **Company Registry:** company lifecycle, credential hashes, scopes, network/asset permissions, webhook endpoints and policy configuration.
- **Wallet Service:** tenant-scoped wallet namespaces, HD root metadata, address derivation/allocation and lifecycle.
- **Key Provider / Signer:** isolated signing boundary; key versioning, rotation, policy checks, signing authorization and audit evidence. Production target is KMS/HSM or equivalent isolated signer; current environment-key AES encryption is not that integration.
- **Chain Adapters:** normalize network-specific address, transaction, fee, signing, broadcast and finality semantics.
- **Deposit Scanner/Verifier:** discover transactions, validate destination/asset/amount/success, persist observations and confirmation state.
- **Withdrawal Orchestrator:** validate instruction, reserve an execution intent, sign, broadcast, persist signature and reconcile.
- **Operational Asset Registry:** maps tenant, wallet, address, asset and chain movements for infrastructure reconciliation. It is not a customer balance ledger.
- **Event Outbox/Webhook Delivery:** durable post-commit event publication, retries and replay.
- **Operations/Admin:** privileged tenant, network, wallet, risk and incident controls.

## 3. Tenant isolation model

Every tenant-owned record must carry a non-null tenant identity or reference a tenant-owned parent through a constrained foreign key. This includes wallet roots, child accounts, address allocations, transaction operations, idempotency records, webhook subscriptions/events, policies and reports.

Required controls:
- Authenticate credential and resolve tenant server-side on every request.
- Pass an immutable tenant context into every use case and repository.
- Scope every read, update, delete, lock and idempotency lookup by tenant.
- Use composite unique keys where identity is tenant-scoped (for example tenant + partner idempotency key).
- Enforce tenant ownership at signer boundary immediately before key derivation/signing.
- Add database constraints and consider PostgreSQL row-level security as defense in depth.
- Test that tenant A cannot enumerate, read, mutate, sign with or replay tenant B resources.
- Separate platform-admin access from partner access and audit every privileged action.

Migration 0009 now provides a tenant registry, hashed credential records and nullable tenant attribution columns. This is only a schema foundation: current API authentication is still one shared `API_ACCESS_KEY`, tenant credentials are not authenticated by the runtime, and tenant authorization is not enforced. The current `hd_wallets.owner_id` is a legacy placeholder and must not be treated as tenant identity. Do not deploy this code as a multi-tenant public service before this phase is implemented.

## 4. Wallet and address isolation

Initial target: one logical wallet namespace/root per tenant, chain and operational purpose. Child addresses are allocated from that tenant's namespace and stored with tenant, network, asset compatibility, derivation scheme/version, derivation index, public address and lifecycle metadata.

Never derive or allocate an address based on a tenant ID supplied without authenticated context. Never reuse an address across tenants by default. Chain-specific designs must account for memo/tag requirements, account models, token contracts and address derivation constraints.

A tenant's customer reference is an opaque partner-owned reference. BLACKCHIN does not need the customer's identity or full customer ledger. It stores only the minimum reference required to return deposit/withdrawal events to the partner.

## 5. Chain adapter contract

Each adapter must expose equivalent operations while preserving chain-specific evidence:

- validateAddress
- deriveAddress / resolveWallet (where supported)
- getNativeBalance and getTokenBalance
- scanIncoming / fetchTransaction
- parseAndValidateTransfer
- estimateFee
- signTransaction through the isolated signer boundary
- broadcastTransaction
- getTransactionStatus / finality
- reconcileOperation

Normalized asset identity is `(network_id, asset_type, contract_or_mint)`; native assets have a network-specific native identifier. Store amounts as integer smallest units and decimals as asset metadata. Do not identify an asset by symbol alone.

Adapters must define finality, reorg handling, transaction identity (including log/event index for token transfers), nonce/sequence rules, fee model, RPC failover and provider trust assumptions.

Current adapter: Solana native SOL. EVM, TRON and token adapters are roadmap items.

## 6. Deposit data flow

1. Authenticated tenant requests an address allocation.
2. Wallet service creates or returns a tenant-owned address record.
3. Scanner discovers incoming native/token activity.
4. Adapter parses and verifies chain, destination, asset, amount, success and confirmation/finality.
5. Database transaction records immutable transaction identity, current lifecycle projection and outbox event.
6. Webhook worker delivers signed event with retries; partner acknowledges only at transport level.
7. Partner decides whether/how to credit its customer ledger.

Chain observation and webhook delivery are separate states. A webhook retry must never create a second deposit or imply another on-chain credit.

## 7. Withdrawal data flow

1. Partner authenticates its customer and approves the business withdrawal in its own application.
2. Partner submits a signed/authenticated, tenant-scoped instruction and idempotency key.
3. Core validates tenant, wallet ownership, network/asset, destination policy, limits, risk controls and infrastructure liquidity.
4. Core creates a durable execution intent and reserves the required operational funds/fee capacity.
5. Signer verifies tenant/wallet authorization again and signs.
6. Persist signed transaction identity before broadcasting; broadcast through adapter.
7. Reconciliation resolves pending/unknown/finalized success/failure.
8. Commit resulting state and outbox event; partner updates its own customer accounting.

External chain broadcast cannot be atomic with a PostgreSQL transaction. Use a durable state machine and never retry a possibly broadcast transaction as a new transaction without authoritative reconciliation.

## 8. Data domains — keep separate

1. **Wallet secrets:** encrypted root material or references to KMS/HSM-managed keys.
2. **Wallet/address registry:** tenant ownership, derivation metadata and address lifecycle.
3. **Blockchain evidence:** immutable chain transaction identity and verified parsed facts.
4. **Operational execution state:** deposit/withdrawal lifecycle, idempotency and reconciliation cursors.
5. **Operational asset attribution:** tenant and purpose attribution, infrastructure fees and balance reconciliation.
6. **Partner customer accounting:** outside BLACKCHIN; partner's source of truth.

The existing `blockchain_transactions` table is transaction evidence/operational history, not a Double-Entry accounting journal and not a customer balance ledger.

## 9. Cloud deployment target

Deploy as independently scalable API, scanner, reconciliation and webhook worker processes. Use managed PostgreSQL with TLS verification, private networking and PITR; managed secrets/KMS; RPC providers with quotas/failover; centralized logs/metrics/traces; and an ingress/load balancer with TLS, WAF/rate limits and request-size controls.

Worker leadership and distributed coordination must use database-backed locks or a proven distributed coordination service. Lock loss must stop new side effects. Multi-replica correctness must be tested under connection loss, process termination and network partitions.

Do not bind signing keys to a general API container when a separate signer boundary is available. Separate development, staging and production credentials, databases, RPC endpoints and wallet roots.

## 10. Architecture decisions

- Node.js 20+, JavaScript ES modules, Fastify and PostgreSQL remain the current stack.
- PostgreSQL is the durable source for application operation state; blockchain is authoritative for chain outcomes.
- No floating-point money arithmetic.
- Append-only evidence and compensating corrections.
- Tenant isolation is a security invariant, not a UI filter.
- Partner customer balances and Double-Entry accounting are explicitly out of scope.
