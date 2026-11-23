# Security Model

## 1. Product security boundary

BLACKCHIN CORE is intended to operate wallet infrastructure and signing for multiple partner companies. It therefore handles high-impact signing authority and must treat tenant isolation as a critical security boundary.

**Current implementation:** partner requests use tenant-specific opaque API credentials with SHA-256 digests, scopes, expiry, revocation and tenant identity derived from authentication. Tenant-scoped repositories, composite ownership constraints and signer-boundary checks are implemented. `owner_id` remains optional business metadata; tenant ownership is enforced through `tenant_id`. Production exposure is still gated on the remaining hardening, KMS/HSM, cloud, database-privilege, load/concurrency and independent security-review work below.

Partner companies remain responsible for authenticating their end users and authorizing customer withdrawals. BLACKCHIN independently validates the authenticated tenant, its wallet ownership, configured limits, destination policy and infrastructure risk controls before signing.

## 2. Tenant authentication and remaining hardening

- Unique credentials per tenant and environment; never one global partner key.
- Store only strong hashes of API secrets; reveal a secret only at issuance/rotation.
- Support credential scopes, expiry, revocation, rotation and audit.
- Derive tenant identity from successful credential verification. Never authorize using a caller-supplied tenant ID.
- Bind sensitive requests to timestamp, nonce, HTTP method, path and body hash using a request-signing scheme or equivalent strong authentication.
- Enforce per-tenant and per-route rate limits, replay protection and idempotency.
- Use separate platform-admin identity and audited break-glass controls.
- Redact authorization headers, signatures, recovery tokens, mnemonics and private material from logs.

## 3. Tenant data and signer isolation

- Every tenant-owned query and mutation must include tenant context.
- Use tenant-scoped foreign keys/unique constraints and non-null ownership references.
- Add PostgreSQL row-level security where appropriate as defense in depth; application repositories must still scope queries.
- Verify tenant ownership again at the signing boundary immediately before deriving/unlocking a key.
- Never allow one tenant to read another tenant's wallet, transaction, address, webhook, policy or report.
- Test cross-tenant IDOR, guessed IDs, idempotency collisions, webhook replay and signer access.
- Wallet roots and derivation namespaces must be isolated by tenant and chain.

## 4. Key custody and signing

Current implementation uses AES-256-GCM encryption for stored wallet secrets and environment-provided encryption keys. This is useful application-layer encryption but is not a KMS/HSM integration.

Production target:
- Keep signing authority in a dedicated signer service or isolated KMS/HSM-backed provider.
- Separate API runtime, database credentials and signing permissions.
- Enforce transaction policy before signing; signer accepts an explicit authorized intent, not arbitrary raw client instructions.
- Apply key versioning, rotation, access logging, backup and recovery procedures.
- Require dual control or additional approvals for high-risk treasury/key operations.
- Never place plaintext keys/mnemonics in logs, API responses, traces, crash reports or source control.
- Recovery phrase provisioning remains one-time, explicit, no-store and operator-controlled.

JavaScript memory zeroization is best-effort and cannot guarantee that runtime copies never exist. Do not describe it as hardware-grade protection.

## 5. Withdrawal safety

- Authenticate tenant and validate wallet belongs to it.
- Require the partner's authenticated business authorization, represented by a verifiable request context/approval reference; a freely supplied boolean is not sufficient in the target design.
- Validate asset, network, amount, destination, wallet lifecycle, tenant limits, global risk rules and available infrastructure funds.
- Use exact integer smallest units or exact decimal arithmetic; never IEEE-754 floating point for money.
- Use tenant-scoped idempotency keys bound to the canonical request body.
- Persist an execution intent before signing and persist signed transaction identity before broadcast.
- Never automatically rebroadcast an ambiguous signed transaction.
- Keep unknown outcomes unresolved until authoritative reconciliation.
- Separate partner customer holds from BLACKCHIN operational execution reservations.
The submit route requires the credential scope `withdrawals:submit`, matching the supported scope registry in `tenant.repository.js`. `withdrawals:write` is not a registered tenant scope and must not be used by this route.

Migration 0012 supplies the policy, destination, approval and append-only decision-event tables. The runtime policy provider is now wired into the composition root and enforces these records on every tenant withdrawal. No policy row is auto-created for existing tenants; absent policy means disabled.

The dashboard control plane exposes admin-only policy configuration, destination management and manual one-time approval issuance. Partners can also issue their own one-time approval through the tenant API using the separate `withdrawals:approve` scope together with `withdrawals:submit`; the approval is bound to that exact credential. Policy edits automatically freeze withdrawals and revoke unused approvals. A policy must be explicitly unfrozen by an admin before approvals can be issued. Destination creation starts in `pending`; activation requires a different second admin from the creator. Approvals are bound to the authenticated tenant credential, active HD child wallet, active allowlisted destination, Solana network, native SOL asset, exact integer lamport amount and canonical request hash. Approvals expire within 15 minutes and can be consumed once or revoked before consumption.

Authorization locks the tenant policy row for the full velocity check, serializing daily and weekly amount/count limits per tenant. Velocity windows use UTC. Every configured limit must be positive; zero never means unlimited. Allowed authorization events are append-only and counted conservatively even if a later pre-broadcast signing attempt fails. The idempotency reservation is created before authorization; a denied request is marked failed without signing, while a completed replay returns its original response without reusing the consumed approval. The API's approval reference is not proof by itself.

The current policy provider is implemented and tested in CI, but production release still requires database privilege review, real PostgreSQL migration verification, load/concurrency testing and an independent security review. Keep the route disabled for any tenant without an explicitly configured and unfrozen policy.

## 6. Deposit verification

Validate chain/network, transaction success, destination, native/token asset identity, contract or mint, decimals, amount, confirmation/finality and chain-specific event identity. Enforce uniqueness for transaction hash plus transfer/log index and destination context as appropriate. Do not treat an RPC timeout as proof that a transaction does not exist. Reorg-aware adapters must be able to move provisional observations into under-review states.

## 7. Secret and transport handling

- TLS for every external API and webhook endpoint.
- PostgreSQL remote connections use certificate verification (`sslmode=verify-full`).
- Parameterized SQL only; validate request shape and reject unknown fields.
- Request body limits, strict timeouts, secure headers and generic external errors.
- Rate limiting must be shared across API replicas for production-sensitive routes.
- Secrets come from a managed secret store, not committed `.env` files.
- Restrict outbound RPC and webhook networking; webhook delivery must block private, loopback, link-local and cloud metadata destinations and revalidate redirects/DNS.

## 8. Audit and immutability

Record who/what initiated each operation, tenant, credential ID, correlation ID, request hash, policy decision, wallet, asset, amount, chain transaction identity, signer decision and state transitions. Do not log secret request bodies.

Immutable chain evidence and audit events must be append-only for the application role. Corrections are represented by compensating events or explicit superseding evidence. Database owners/superusers can bypass ordinary triggers; production privileges must separate migration ownership from application DML.

## 9. Threats and required controls

| Threat | Required control |
|---|---|
| Tenant A accesses tenant B | tenant context in every repository, DB constraints/RLS, cross-tenant tests |
| Stolen API credential | scopes, short rotation window, revocation, IP policy, rate limits, signed requests |
| Compromised API process | isolated signer/KMS, least privilege, policy enforcement outside API |
| Database/backup theft | encryption, separately stored keys, restricted backups, restore drills |
| Malicious/incorrect RPC | provider diversity, chain-specific verification, reconciliation |
| Duplicate webhook or API retry | immutable event IDs, idempotency, transactional outbox |
| Duplicate withdrawal | durable intent, persisted signature, no blind rebroadcast |
| Key misuse by operator | dual control, audit, emergency freeze, separation of duties |
| Reorg or delayed finality | chain-specific finality state machine and reconciliation |
| Webhook SSRF | HTTPS allowlist/policy, IP/DNS checks, redirect restrictions, egress controls |

## 10. Production release gates

Do not declare multi-tenant production readiness until:
- Tenant authentication and complete tenant-scoped authorization exist.
- Cross-tenant API, repository, database and signer tests pass.
- KMS/HSM or approved isolated signer integration is deployed and recovery-tested.
- Shared rate limiting, webhook outbox and replay protection are deployed.
- Concurrent withdrawal, ambiguous broadcast, worker lock-loss and chain-reorg tests pass.
- Security review, incident response, backup restore and key recovery drills are complete.
- Applicable custody, safeguarding, sanctions and money-transmission obligations are reviewed by qualified counsel/compliance specialists for operating jurisdictions.
