# Phase 5 — End-to-End Transaction Reliability

## Scope

Phase 5 hardens the boundary between Solana broadcast, PostgreSQL durability,
and asynchronous reconciliation. It does not introduce a new monetary ledger,
automatic transaction rebroadcast, or a new balance-reservation mechanism.

## Required invariants

1. A withdrawal signature is persisted to its idempotency reservation before
   `sendRawTransaction` is called.
2. Once a signature has been persisted, the reservation remains
   `processing` until the chain outcome is resolved. A retry must not create a
   second broadcast.
3. The immutable ledger row and idempotency completion are committed in one
   PostgreSQL transaction.
4. If the post-broadcast DB connection, ledger insert, completion update, or
   commit fails, the API returns `503 WITHDRAWAL_RECONCILIATION_REQUIRED`
   including the known signature and idempotency key. It must not return a
   normal successful completion response.
5. Reconciliation verifies finalized chain status and the exact sender,
   destination and lamport amount before writing a ledger record.
6. Reconciliation writes the ledger, idempotency completion, append-only
   evidence and cursor advancement in one transaction. A failed commit leaves
   the candidate eligible for a later scan.
7. Reconciliation never rebroadcasts a signature.
8. Per-wallet in-flight uniqueness remains enforced by PostgreSQL partial
   unique indexes, not process-local locks.
9. A cluster advisory lock serializes reconciliation workers per network.
10. Shutdown waits for the active scan to finish before releasing its lock and
    closing database pools.

## Crash-point matrix

| Failure point | Durable state | Recovery |
|---|---|---|
| Before reservation | No request record | Caller may retry |
| After reservation, before signature persistence | Processing, no signature | Reconciler may fail only after the safety window |
| Signature persisted, before RPC call | Processing + signature | Query chain history; never create a second send |
| RPC accepted, response lost | Processing + signature | Reconciler looks up the persisted signature |
| Confirmation timeout | Processing + signature | Reconciler waits for finalized evidence |
| RPC confirmed but not finalized | Processing + signature | Keep pending; do not complete |
| Broadcast returned, DB connection unavailable | Processing + signature | Return reconciliation-required; retry reconciliation |
| Ledger insert or completion update fails | Transaction rolled back; processing + signature | Reconciler atomically records verified outcome |
| Reconciliation event/cursor/commit fails | Entire reconciliation transaction rolls back | Candidate remains eligible on next cycle |
| Worker process stops during scan | DB session closes; advisory lock is released by PostgreSQL | Next worker acquires lock and resumes from durable cursor |

## Runtime behavior

The legacy and tenant withdrawal services use the same fail-closed contract for
post-broadcast persistence failures. The returned API error has HTTP status 503,
code `WITHDRAWAL_RECONCILIATION_REQUIRED`, the persisted signature and the
idempotency key. Clients must query the withdrawal status or wait for
reconciliation; they must not submit a new idempotency key for the same
financial intent.

The Solana confirmation helper now clears both its block-height polling
interval and its confirmation timeout after settlement. A slow block-height
request cannot create overlapping polling calls.

The reconciliation RPC facade uses
`getSignatureStatuses(signatures, { searchTransactionHistory: true })` so
older signatures are not limited to the RPC node's recent status cache.

## Verification

The Phase 5 CI run executes:

- Complete backend test suite against PostgreSQL 16.
- Dashboard TypeScript typecheck and production build.
- Import graph check.
- Failure-injection tests for post-broadcast SQL failure and DB pool connection
  acquisition failure.
- Reconciliation commit/evidence-write failure tests, including rollback and
  cursor retryability.
- Multi-instance advisory-lock contention and graceful stop tests.
- PostgreSQL integration test that simulates the broadcast/ledger crash window,
  proves the signed reservation remains processing, then verifies reconciliation
  completes exactly one immutable ledger row.

## Operational response

When the API returns `WITHDRAWAL_RECONCILIATION_REQUIRED`:

1. Preserve the supplied idempotency key and signature.
2. Do not submit a replacement withdrawal or create a new idempotency key.
3. Check the withdrawal record and reconciliation worker health.
4. Allow the worker to query finalized chain history.
5. If the record remains `under_review` or `unknown`, inspect the append-only
   reconciliation evidence and query an independent trusted Solana RPC before
   any manual state change.
6. Never manually mark a signed request failed solely because one RPC endpoint
   does not currently return its signature.

## Release gates

- Phase 2, Phase 3 and Phase 4 PRs must be merged in order before this stacked
  Phase 5 PR.
- Apply only migrations included in the merged release.
- Enable withdrawal reconciliation and verify its health before accepting
  production withdrawals.
- Test the configured RPC provider's historical signature lookup and
  finalized transaction availability on the target cluster.
- Do not treat passing CI as proof of live mainnet RPC/provider behavior; run a
  controlled devnet fault-injection exercise before mainnet activation.
