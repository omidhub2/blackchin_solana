# BLACKCHIN — Product Scope

**Product:** Blockchain Infrastructure as a Service (BIaaS) for partner companies.
**Phase 1 network scope:** Solana native SOL only.
**Current release:** Solana devnet/testnet/mainnet-beta native SOL operations plus an operator dashboard.

## 1. What BLACKCHIN is

BLACKCHIN is the infrastructure intermediary between partner companies and the
Solana network. It:

- provisions tenant-isolated HD wallet roots and derives child addresses,
- stores wallet material encrypted and signs only through a tenant-scoped
  signing boundary,
- monitors registered addresses and verifies native SOL deposits on chain,
- executes authorized native SOL withdrawals with idempotency and
  reconciliation,
- returns verified chain results through a versioned API and signed webhooks,
- exposes a real-time operator dashboard for wallets, addresses, transactions
  and service health.

## 2. What BLACKCHIN is not

BLACKCHIN does **not** maintain:

- partner customer identities or KYC records,
- partner customer balances,
- partner double-entry accounting or financial statements,
- customer holds, credits, debits or internal transfers,
- a partner customer ledger of any kind.

Partner companies authenticate their own customers, decide whether a customer
may withdraw, and post their own accounting entries. A successful BLACKCHIN
deposit event or withdrawal result is infrastructure evidence, not a customer
balance.

## 3. Phase 1 scope

| Capability | Status |
|---|---|
| Solana mainnet-beta / devnet / testnet | Supported |
| Native SOL balances | Supported |
| Native SOL deposits | Supported |
| Native SOL withdrawals | Supported with tenant policy provider |
| HD root creation and child derivation | Supported |
| Tenant API credentials and scopes | Supported |
| Signed webhooks with durable outbox | Supported (worker opt-in) |
| Real-time operator dashboard | Supported |
| SPL tokens | Out of scope |
| USDT / USDC | Out of scope |
| Ethereum / EVM / TRON / Bitcoin | Out of scope |

Unsupported networks and assets are rejected or shown as out of scope; they are
never silently accepted.

## 4. Tenant model

- Every partner is a tenant with an immutable numeric ID and lifecycle status.
- Every API credential belongs to exactly one tenant and carries explicit
  scopes, status, expiry and rotation/revocation metadata.
- Tenant identity is derived only from the authenticated credential. A
  `tenantId` in a request body is never accepted as proof of identity.
- Every wallet root, child address, transaction, idempotency record and webhook
  event is tenant-scoped.
- Cross-tenant reads, writes and signing fail closed and are covered by tests.
- Dashboard operators are a separate identity domain from partner credentials.

## 5. Deposit contract

A deposit is returned only after the scanner has:

1. observed a signature for a registered address,
2. fetched the parsed transaction,
3. verified successful execution,
4. matched the destination address and a positive native SOL amount,
5. evaluated the configured confirmation/finality policy,
6. persisted the observation exactly once.

The partner receives a durable event and can query the result even if webhook
delivery fails. BLACKCHIN never credits a partner customer.

## 6. Withdrawal contract

A withdrawal is executed only when:

1. the tenant credential has `withdrawals:submit`,
2. the source wallet is an active tenant HD child,
3. the destination and amount pass validation,
4. the tenant withdrawal policy provider authorizes the exact request,
5. a hot-wallet guard (if designated) permits signing,
6. an idempotency reservation is committed,
7. the signed signature is persisted before broadcast,
8. ambiguous outcomes remain `processing` for reconciliation and are never
   blindly rebroadcast.

The partner is responsible for authorizing its customer's withdrawal in its own
system before calling BLACKCHIN.

## 7. Explicit non-goals

- Building a partner customer-management UI.
- Building a partner financial accounting UI.
- Storing partner customer balances or statements.
- Acting as an exchange or payment processor.
- Custody/legal characterization without jurisdiction-specific review.

## 8. Status vocabulary

Use these labels in reports and UI:

- **Complete and tested** — implemented with automated tests in this repository.
- **Implemented but not production-verified** — code exists; external
  infrastructure or operational validation is pending.
- **Partially implemented** — a safe subset exists; a documented gap remains.
- **Blocked by external infrastructure** — requires KMS/HSM, RPC quota, cloud
  resources or secrets not present in this environment.
- **Not implemented** — explicitly out of scope or not started.