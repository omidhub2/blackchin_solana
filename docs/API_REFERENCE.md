# API Reference

Base path: `/api/v1`. Every endpoint except `GET /health` requires
`X-API-Key: <API_ACCESS_KEY>`.

Custody/ownership model: the API key authenticates **one trusted backend
service**, not end users. There is no per-user ownership check yet; see
`SECURITY.md`.

Error envelope:

```json
{ "error": "INVALID_REQUEST", "message": "human readable" }
```

Common status codes: `400` validation, `401` missing/invalid API key,
`404` unknown resource, `409` conflict/idempotency, `429` rate limited,
`500` internal (message is generic), `502`/`503` Solana RPC failure.

---

## HD roots

### `POST /hd-wallets`

Creates a root with a fresh 24-word BIP39 mnemonic.

Body (all optional): `label` (≤100 chars), `ownerId` (`[A-Za-z0-9._:-]{1,64}`).
Unknown fields are rejected.

```json
{
  "wallet": {
    "id": "1", "ownerId": null, "label": "treasury", "network": "devnet",
    "derivationScheme": "bip39+slip10-ed25519/v1",
    "derivationPathTemplate": "m/44'/501'/{accountIndex}'/0'",
    "nextAccountIndex": 0, "status": "active", "phraseProvisioned": false,
    "createdAt": "...", "updatedAt": "..."
  },
  "recovery": {
    "token": "<base64url, one-time>", "wordCount": 24,
    "expiresAt": "<ISO, informational>", "warning": "..."
  },
  "nextSteps": ["..."]
}
```

`201`. Rate limit: 20/min per IP.

### `GET /hd-wallets/:id`

Returns root metadata. Never returns mnemonic material. `404` if unknown.

### `PATCH /hd-wallets/:id`

Body `{ "status": "active" | "disabled" | "archived" }`. Disabled/archived roots
cannot create accounts and cannot sign.

### `POST /hd-wallets/:id/recovery-phrase/consume`

One-time phrase provisioning. Body `{ "token": "...", "confirm": true }`.
Responses carry `Cache-Control: no-store`.

- `200` `{ hdWalletId, mnemonic, wordCount, warning }`
- `409 CONFIRMATION_REQUIRED` — `confirm` was not `true`
- `409 RECOVERY_PHRASE_ALREADY_PROVISIONED` — already revealed once
- `409 INVALID_RECOVERY_TOKEN` — tampered/foreign token

Authorized operators only (malicious use does not yield a phrase without the
server-side token). Rate limit: 5/min.

### `GET /hd-wallets/:id/derive/:accountIndex`

Deterministic recovery check: which public key does this index map to?
Returns `{ hdWalletId, accountIndex, derivationPath, publicKey }`.

---

## Child accounts

### `GET /hd-wallets/:id/accounts?limit=&offset=`

`{ hdWalletId, total, limit, offset, items: [account] }`; items ordered by
`accountIndex`. `limit` 1–500 (default 100).

### `POST /hd-wallets/:id/accounts`

Body optional `{ "count": 1 }` (1–50). `201`:

```json
{ "hdWalletId": "1", "nextAccountIndex": 3, "accounts": [
  { "id": "10", "hdWalletId": "1", "publicKey": "...", "accountIndex": 0,
    "derivationPath": "m/44'/501'/0'/0'", "walletType": "hd_child",
    "network": "devnet", "status": "active", "createdAt": "...", "updatedAt": "..." }
] }
```

Never returns private keys. Concurrent requests never receive the same index.

### `POST /hd-wallets/:id/accounts/batch`

Same contract; `count` is required (1–50). All-or-nothing per request.

### `GET /hd-wallets/:id/accounts/:accountIndex`

Single account by derivation index. `404 WALLET_ACCOUNT_NOT_FOUND` if absent.

### `GET /hd-wallets/:id/balance`

Aggregate of all children (deduplicated by public key, summed with BigInt):

```json
{
  "hdWalletId": "1", "network": "devnet", "commitment": "confirmed",
  "accountCount": 3, "truncated": false, "complete": true,
  "totalLamports": "3000000001", "totalSol": "3.000000001",
  "accounts": [ { "publicKey": "...", "accountIndex": 0, "derivationPath": "...",
                  "status": "active", "lamports": "1000000001", "sol": "...", "error": null } ],
  "syncedAt": "..."
}
```

If some RPC calls fail, `complete` is `false` and the affected entries carry
`error` (`RPC_ERROR` / `RPC_RATE_LIMITED`). If **all** calls fail the endpoint
returns `503`.

### `GET /hd-wallets/:id/transactions?limit=&offset=&direction=`

Recorded deposits/withdrawals (`blockchain_transactions`), newest first.
`limit` 1–100 (default 20).

### `PATCH /wallets/:publicKey/status`

Body `{ "status": "active" | "disabled" | "archived" }` for an HD child
(standalone wallets have no lifecycle column).

---

## Wallet endpoints (standalone and HD child)

### `POST /wallets`

Creates a legacy standalone wallet (`Keypair.generate()`); unchanged contract.

### `GET /wallets/:publicKey`

Standalone metadata, or the child account record if it is an HD child.
`404 WALLET_NOT_FOUND` when neither exists.

### `GET /wallets/:publicKey/balance`

```json
{ "publicKey": "...", "walletType": "hd_child", "hdWalletId": "1",
  "accountIndex": 0, "derivationPath": "m/44'/501'/0'/0'",
  "network": "devnet", "commitment": "confirmed",
  "lamports": "2000000", "sol": "0.002", "syncedAt": "..." }
```

### `GET /wallets/:publicKey/deposit-address`

`{ publicKey, walletType, hdWalletId, accountIndex, network, depositAddress, memo }`.
Native SOL only; SPL tokens are not credited.

### `GET /wallets/:publicKey/transactions?limit=`

Live scan of recent signatures from RPC (`limit` 1–50). Not a historical indexer.

### `GET /wallets/:publicKey/deposits?limit=&offset=`
### `GET /wallets/:publicKey/withdrawals?limit=&offset=`

Recorded ledger rows for that wallet.

---

## Transfers (native SOL withdrawals)

### `GET /transfers/:signature?publicKey=<recipient>`

Read-only verification: `{ found, confirmed, confirmationStatus, signature,
publicKey, walletType, hdWalletId, network, slot, blockTime, transfers[],
totalLamports, status, failureReason }`.

### `POST /transfers/:signature/confirm`

Body `{ "publicKey": "<recipient>" }`. Verifies the transaction on-chain and
records it once (unique signature constraint). `201` when created, `200` when it
already existed.

- `409 TRANSACTION_NOT_FOUND` — signature unknown on this network
- `409 TRANSACTION_FAILED` — transaction failed on-chain
- `409 NO_MATCHING_TRANSFER` — no native SOL transfer to that address
- `409 TRANSACTION_NOT_CONFIRMED` — retry once confirmed

### `GET /deposits/:signature?publicKey=`

Refreshes confirmation state of a recorded deposit and returns the record.

### `POST /transfers/estimate`

Body `{ "fromPublicKey", "toPublicKey", "amountSol" }` (amount is a decimal
string, max 9 decimals). Returns lamport amounts, fee, and whether the balance
is sufficient. Never signs. Rate limit 60/min.

### `POST /transfers`

Body `{ "fromPublicKey", "toPublicKey", "amountSol", "approved": true }` and a
mandatory `Idempotency-Key` header (16–128 chars of `A-Za-z0-9._:-`).

- `201` broadcast and confirmed
- `200` replayed response for the same key + identical body
- `400 APPROVAL_REQUIRED` — `approved` is not exactly `true`
- `400 INVALID_IDEMPOTENCY_KEY`
- `409 IDEMPOTENCY_KEY_REUSED` — same key, different request
- `409 IDEMPOTENCY_IN_PROGRESS` — previous attempt still processing/failed
- `409 WALLET_NOT_ACTIVE` / `409 NETWORK_MISMATCH`

Rate limit 10/min. Idempotency details in `SECURITY.md`.
