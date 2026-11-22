# HD Wallet Architecture

This document describes the hierarchical deterministic (HD) wallet layer
implemented in `src/blockchain/solana/hd`, `src/core/hd-wallet`,
`src/core/wallets`, `src/infrastructure/database` and `src/infrastructure/security`.

## 1. Two wallet types

| Type | Created by | Key source | Stored in |
|---|---|---|---|
| Standalone | `POST /api/v1/wallets` (`Keypair.generate()`) | encrypted 64-byte secret key | `wallets` |
| HD child | `POST /api/v1/hd-wallets/:id/accounts` | derived from the HD root mnemonic | `wallet_accounts` |

Both resolve through the same unified code path (`wallet-signer.js`), so
balance, deposit and withdrawal endpoints work identically for both. Existing
standalone wallets are untouched by the HD migration.

## 2. HD root (master wallet)

An HD root is a **logical grouping**, not an on-chain account. It stores:

- a BIP39 mnemonic (24 words / 256-bit entropy) encrypted with AES-256-GCM,
- the derivation scheme and path template that produced its children,
- `next_account_index`, the monotonically increasing allocator,
- a lifecycle status (`active`, `provisioning`, `disabled`, `archived`).

The aggregate balance of a root is computed from its children
(`GET /api/v1/hd-wallets/:id/balance`); the root never has a balance of its own.

### Recovery phrase provisioning

Creating a root returns a **one-time recovery token**:

```json
{
  "wallet": { "id": "1", "status": "active", ... },
  "recovery": { "token": "...", "wordCount": 24, "expiresAt": "...", "warning": "..." }
}
```

The token is the mnemonic sealed with a *purpose-derived* sub-key
(`HMAC-SHA256(masterKey, "blackchin:recovery-phrase:v2")`), so token ciphertext
can never be mistaken for the stored root ciphertext (different key **and**
different AEAD AAD). The AAD additionally binds the purpose, the wallet id, the
issue time, the expiry and a random `jti`, so a token minted for one root cannot
authenticate against another.

Persistence rules:

- The **plaintext token is never stored** (and never logged); only the token's
  SHA-256 hash (`recovery_token_hash`) and its server-side expiry
  (`recovery_token_expires_at`) are written to `hd_wallets`, inside the same
  transaction that creates the root.
- The token is returned only after that write succeeded; if the write does not
  affect exactly one row the transaction is rolled back and no token is
  returned.
- Redemption is a single conditional `UPDATE` that matches on the stored hash,
  an un-provisioned row and a not-yet-expired `recovery_token_expires_at`.
  Concurrent redemptions therefore produce exactly one winner.
- On successful redemption both `recovery_token_hash` and
  `recovery_token_expires_at` are cleared together with
  `phrase_provisioned_at` being set, so the token is dead permanently.

`POST /api/v1/hd-wallets/:id/recovery-phrase/consume` with `{ "confirm": true }`
redeems it exactly once. After that the phrase can never be retrieved through
the API again. Operators must store it offline before closing the provisioning
window.

## 3. Mnemonic and derivation scheme

Scheme identifier (stored per root, never changed silently):
`bip39+slip10-ed25519/v1`.

```
mnemonic (BIP39, English wordlist, 256-bit entropy, 24 words)
      │
      │  PBKDF2-HMAC-SHA512(mnemonic, "mnemonic" + passphrase, 2048 iters, 64 bytes)
      ▼
BIP39 seed (64 bytes)
      │
      │  SLIP-0010 Ed25519 master node (HMAC-SHA512 key = "ed25519 seed")
      ▼
master key (32-byte private key + 32-byte chain code)
      │
      │  hardened-only derivation of m/44'/501'/{accountIndex}'/0'
      ▼
child 32-byte Ed25519 private seed
      │
      │  Keypair.fromSeed(seed)
      ▼
Solana keypair (64-byte secret key = seed || public key, Base58 address)
```

- The path template is `m/44'/501'/{accountIndex}'/0'` (`501` = Solana coin type).
- Every level is **hardened**; SLIP-0010 forbids non-hardened Ed25519 children.
- `accountIndex` is a non-negative safe integer `< 2^31`.
- The implementation lives in `slip10-ed25519.js` (HMAC-SHA512, explicit
  standard version) and is validated against the official SLIP-0010 vectors and
  against `Keypair.fromSeed()`.

### Why these conversions are kept distinct

| Value | Meaning |
|---|---|
| mnemonic phrase | 24 words, the only recovery secret |
| BIP39 seed | 64-byte PBKDF2 output, intermediate |
| SLIP-0010 master key | 32-byte key + chain code, intermediate |
| child Ed25519 seed | 32-byte node key after path derivation |
| Solana secret key | 64 bytes (seed ‖ public key) produced by `Keypair.fromSeed` |

### Determinism

For the same mnemonic, passphrase, scheme and path, `deriveSolanaAccount()`
always returns the same public key. This is asserted in
`test/hd-derivation.test.js`, including a fixed regression vector — if that
vector ever changes, existing wallets would become unreachable.

An optional BIP39 passphrase is supported by the derivation library
(`deriveSolanaAccount(mnemonic, index, { passphrase })`) and changes the seed.
The HD root storage does **not** persist a passphrase; roots created through the
API use an empty passphrase.

## 4. Child wallet lifecycle

`createAccountsInTransaction()` performs, in one PostgreSQL transaction:

1. `SELECT ... FOR UPDATE` on the root row + `pg_advisory_xact_lock` (serializes allocators),
2. reserve `count` consecutive indexes from `next_account_index`,
3. decrypt the root mnemonic and derive each child key in memory,
4. `INSERT INTO wallet_accounts` (single statement, `UNNEST` of arrays),
5. `COMMIT`.

Any failure rolls the transaction back and rewinds `next_account_index` when no
account exists above the reservation (`rewindAccountIndex`). Unique constraints
`(hd_wallet_id, account_index)`, `(hd_wallet_id, derivation_path)` and
`public_key` are the final safety net. Private keys are **not** stored: they are
derived again only when signing.

Batch creation is capped at 50 accounts per request.

## 5. Signing process

```
request → resolve wallet (wallet_accounts → standalone wallets)
        → validate lifecycle status / network
        → HD child: decrypt root mnemonic (AES-256-GCM + AAD)
                    → SLIP-0010 derive child seed → Keypair.fromSeed
          standalone: decrypt stored secret key
        → verify derived public key == stored public key
        → sign + broadcast inside the callback lifetime
        → zeroize keypair buffers
```

`withSigningKey()` is the only entry point that exposes a keypair, and only
inside the callback. Mismatch between the stored public key and the derived
key aborts with `WALLET_KEY_INTEGRITY_ERROR` (500, requires operator action).

## 6. Database structure

| Table | Purpose |
|---|---|
| `wallets` | unchanged legacy standalone wallets |
| `hd_wallets` | encrypted root mnemonic, scheme, allocation counter, status |
| `wallet_accounts` | derived children with unique index/path/public key |
| `blockchain_transactions` | immutable deposit/withdrawal ledger |
| `api_idempotency_keys` | idempotency reservations (now also stores wallet + signature) |

See `DATABASE_SCHEMA.md`.

## 7. Security boundaries

- Private keys and mnemonics never cross the API boundary (except the
  deliberately one-time recovery provisioning).
- Root material is AAD-bound to its row id, so moving a ciphertext to another
  row breaks decryption.
- Key rotation is supported through key-versioned encryption variables.
- Zeroization is best-effort: web3.js `Keypair.secretKey` returns a copy, so
  `zeroizeKeypair()` overwrites the internal buffer in place; Node.js may still
  copy buffers during GC.
- Ownership: a single API key guards a single trusted backend. The schema is
  prepared (`hd_wallets.owner_id`) for tenant-scoped authentication, which is
  **not** implemented.
