# Security Hardening & Production Readiness — Audit (Phase 2)

Baseline commit: `3f2d8cd`.

Scope of this audit: every file under `src/`, `Solana/`, `PostgreSQL/`,
`config/`, `scripts/`, `migrations/`, `test/`, plus `package.json`, `.env.example`
and `docs/`.

## Dependency map (actual)

```
src/index.js
  ├─ PostgreSQL/walletStorage.js (pool, legacy AES-GCM, saveWallet, loadWalletByPublicKey)
  ├─ core/services.js  (composition root: createServices)
  │    ├─ infrastructure/dependencies.js  (pool + Solana RPC facade + cipher)
  │    ├─ core/hd-wallet/hd-wallet.service.js        → hd-wallet.repository
  │    ├─ core/wallets/child-wallet.service.js       → wallet-account.repository, hd-wallet.repository
  │    ├─ core/balance/hd-balance.service.js         → wallet-signer.resolveWallet, RPC
  │    ├─ core/deposits/deposit.service.js           → blockchain-transaction.repository, wallet-signer, RPC
  │    ├─ core/withdrawals/withdrawal.service.js     → wallet-signer.withSigningKey, idempotency, ledger
  │    ├─ core/transactions/transaction-history.service.js
  │    └─ core/wallet/standalone-wallet.service.js   → PostgreSQL/createWallet.js
  └─ api/server.js → routes/{wallet,transfer,hd-wallet}.routes.js
       └─ middleware/{api-key-auth, rate-limit}.js, validation.js
Solana/solTransfer.js  (adapter implementation; sendSol, sendSolWithSigner, parsing)
```

## Findings

### P0-1 Recovery token is not bound to an HD wallet

- **File/function:** `src/infrastructure/security/purpose-token.js` (`seal`/`open`),
  `src/core/hd-wallet/hd-wallet.service.js` (`consumeRecoveryPhrase`).
- **Existing behavior:** the token is an AEAD blob whose AAD is only
  `blackchin:recovery-phrase:v1`. It carries no wallet id, no issue time, no
  unique token id.
- **Risk:** a token minted for root A opens for root B. The only thing that
  prevented a cross-root replay was `phrase_provisioned_at IS NULL` on the
  target root — i.e. if root B had never been provisioned, a token from root A
  would decrypt and, worse, would be *delivered as root B's phrase* (wrong
  secret handed to the operator), and root B would be marked provisioned,
  permanently locking its real phrase.
- **Required correction:** bind wallet id, purpose, `iat`, `exp`, and a unique
  nonce (`jti`) into the AEAD AAD; verify all of them, plus server-side expiry,
  on redemption; deliver the decrypted payload's wallet id and compare it.
- **Tests:** wallet-A token on wallet B, expiry, tampering, wrong purpose,
  nonce reuse, concurrent redemption.

### P0-2 Expiration is informational only

- **File/function:** `hd-wallet.service.js` `createHdWallet` returns
  `recovery.expiresAt`, and `consumeRecoveryPhrase` never checks it.
- **Risk:** the API advertises a 1-hour window that does not exist. Tokens are
  valid forever until redeemed.
- **Required correction:** encode `exp` inside the authenticated token and
  compare against the server clock at redemption; return a generic error.

### P0-3 One-time redemption is not atomic with the token check

- **File/function:** `consumeRecoveryPhrase` → `markPhraseProvisioned`
  (`UPDATE ... WHERE phrase_provisioned_at IS NULL`).
- **Existing behavior:** the conditional update gives single-winner semantics
  for the *phrase*, but nothing records token redemption, so two concurrent
  requests both decrypt the phrase before one of them loses the race.
- **Risk:** no duplicate secret is stored, but the loser receives nothing while
  having passed the "is this token valid" gate; token replay state is inferred
  from row state rather than recorded explicitly. There is no way to audit which
  token id was redeemed.
- **Required correction:** additive migration storing `recovery_token_hash`,
  `recovery_token_expires_at`; redemption must be a single conditional update
  that pins the token hash and marks it consumed in one statement.

### P0-4 No redaction guarantee for recovery requests

- **File/function:** `src/api/server.js` `setErrorHandler`, route error paths.
- **Existing behavior:** Fastify's logger serializes request metadata (URL,
  ip, headers) but not bodies. Errors are generic already.
- **Risk:** low, but tokens could leak through a future `request.log` of the
  body or through a validation message echoing input.
- **Required correction:** explicit redaction list on the Fastify logger and a
  test asserting token values never appear in error payloads.

### P0-5 Child signing does not consult the parent HD root

- **File/function:** `src/infrastructure/security/wallet-signer.js`
  `resolveSigningKeypair`.
- **Existing behavior:** child `status` is checked; the parent row is fetched
  only to decrypt the mnemonic. `hd_wallets.status` (`disabled`/`archived`) is
  ignored.
- **Risk:** disabling an HD root does **not** stop its children from spending.
  This is the most serious lifecycle gap found.
- **Required correction:** verify parent existence, status, and network inside
  the signing path, immediately before key derivation.

### P0-6 Child network is not compared to the deployment network at signing

- **File/function:** `withdrawal.service.js#submit` checks `wallet.network`
  against the configured network, but the signer/base path does not.
- **Risk:** a caller using the signer directly (workers, future code) could sign
  for a wallet belonging to another network.
- **Required correction:** enforce network equality in the signing path.

### P1-7 Parent status can change between authorization and broadcast

- **File/function:** `withdrawal.service.js#submit` → `withSigningKey`.
- **Risk:** TOCTOU: root disabled after the status check but before signing.
- **Required correction:** re-read the parent row with `FOR SHARE` in a short
  transaction immediately before signing and hold that transaction only until
  the keypair is derived (released before any RPC call).

### P1-8 Secret buffers: mnemonic stays a JS string

- **File/function:** `wallet-signer.loadHdChildKeypair`, `slip10-ed25519.js`,
  `derivation.js#deriveSolanaAccount`, `hd-envelope.js#decrypt`.
- **Existing behavior:** `secretKey`/seed buffers are zeroed in `finally`, but
  the decrypted mnemonic and intermediate `chainCode` copies remain immutable
  strings/buffers owned by the GC.
- **Risk:** plaintext lingers longer than necessary; failure paths in
  `derivation.js` did not zero the seed buffer.
- **Required correction:** expose a buffer-based derivation entry point that
  zeroes seed, master key and chain codes in `finally`; keep the existing
  string API for compatibility.

### P1-9 No persistent deposit scanner

- **File/function:** `deposit.service.js` is request-driven only.
- **Risk:** deposits are only recorded when a client calls
  `/transfers/:signature/confirm`. There is no background reconciliation, no
  cursor, no restart safety.
- **Required correction:** new worker + cursor table + tests.

### P1-10 No outbox / webhook delivery

- **File/function:** none exists (`grep -r webhook` → no matches).
- **Risk:** consumers must poll; no delivery guarantee.
- **Required correction:** outbox table + delivery worker + HMAC + SSRF guard.

### P2-11 Rate limiter is process-local

- **File/function:** `src/api/middleware/rate-limit.js`.
- **Risk:** N instances ⇒ N× the configured limit.
- **Required correction:** PostgreSQL-backed shared limiter, fail-closed for
  sensitive routes, local fallback for development.

### P1-12 SPL tokens are neither supported nor explicitly rejected

- **File/function:** `Solana/solTransfer.js#extractIncomingTransfers` only scans
  `program === 'system'`. A token transfer to the wallet is silently ignored.
- **Risk:** operators may assume token deposits are tracked (they are not).
- **Required correction:** document as unsupported and reject explicitly where
  a caller asks for token support.

### P2-13 Ledger "immutability" is policy-only

- **File/function:** `blockchain-transaction.repository.js`.
- **Existing behavior:** the repo exposes no update of amounts, but the table is
  writable by the application role.
- **Required correction:** database trigger rejecting changes to the identity
  and amount columns; documented as enforced at the DB layer from now on.

### P2-14 `/health` exposes service identity only

- Reviewed: returns `{ status, service }`. No secrets. Kept, and extended with
  scanner/worker readiness in `GET /health/ready`.

### Items verified as already correct

- Parameterized SQL everywhere (no interpolation of user values).
- API key compared with `timingSafeEqual`, lazy read, fail-closed.
- Amounts: decimal strings → BigInt lamports; no float arithmetic in money paths.
- Unknown request fields rejected (`rejectUnknownKeys`).
- Withdrawals require API key + `approved: true` + idempotency key; uncertain
  broadcasts are never replayed.
- Deposits are verified against parsed transactions (destination + success).
- `wallets` legacy table untouched by HD migrations.
