# Security

## 1. Custody model (read this first)

The service is a **custodial, single-tenant backend**. `API_ACCESS_KEY` is one
shared secret that authenticates a trusted backend service; it is **not**
end-user authentication, not multi-tenant isolation, and must never be shipped
to browsers or third parties.

Implemented boundary:

- every operation is authorized by the API key (fail closed when unset),
- wallet lifecycle status is enforced before signing,
- network identity is enforced (an HD child on `mainnet-beta` cannot be spent by
  a `devnet` deployment),
- withdrawals require the API key **and** `approved: true` **and** a fresh
  idempotency key.

Not implemented (and not claimed): per-user JWT/OAuth, tenant-scoped row
security, spending limits per owner, approval workflows with a second actor.
`hd_wallets.owner_id` exists so tenant-scoped authorization can be added without
a migration, but it is not enforced anywhere yet. Do not expose this API to the
public internet or to untrusted clients.

## 2. Encryption

- Algorithm: AES-256-GCM, 12-byte random IV per encryption, 16-byte auth tag.
- Key material: `ENCRYPTION_KEY` (64 hex chars = 32 bytes).
- Format-compatible with the legacy wallet storage, so the same key covers old
  standalone wallets and new HD roots.
- HD root mnemonics use additional authenticated data
  `hd_wallets:<id>:mnemonic:v1`. Copying a ciphertext to another row id makes
  decryption fail.
- Stored hex fields are format-validated before any crypto call; failures throw
  a generic `Decryption failed` error that never includes key or plaintext
  material.

### Key rotation

`ENCRYPTION_KEY_V<n>` variables supersede `ENCRYPTION_KEY` for new writes
(highest version wins). Each row stores `encryption_key_version`, so old rows
stay readable while their key variable remains configured. Removing a version
that rows still reference makes those rows undecryptable. Rotation procedure:

1. add `ENCRYPTION_KEY_V2`, restart (new writes use v2),
2. re-encrypt existing rows offline or on read/rewrite,
3. only after no row references v1, remove `ENCRYPTION_KEY`.

### Key management

- Keys come from the environment only; nothing is hardcoded or committed.
- `createEnvKeyProvider()` is a pluggable interface: a KMS/HSM-backed provider
  can be injected wherever a key provider is expected (`createServices({
  keyProvider })`). **No cloud KMS integration is implemented.**

## 3. Secret handling

- Private keys and mnemonics are never logged, never returned by list/read
  endpoints and never sent to RPC providers (only signed raw transactions and
  public keys leave the process).
- The recovery phrase leaves the service **once**, through a purpose-bound
  one-time token and an explicitly confirming endpoint; the response is marked
  `no-store`.
- Derived child keys exist only for the callback lifetime of
  `withSigningKey()`.
- Zeroization is best-effort: web3.js returns a *copy* from
  `keypair.secretKey`, so `zeroizeKeypair()` overwrites `keypair._keypair`
  buffers in place. JavaScript/Node cannot guarantee the runtime never copies
  these buffers before GC, so this is hardening, not a hardware guarantee.

## 4. Idempotency and duplicate prevention

Withdrawals:

1. `INSERT ... ON CONFLICT DO NOTHING` reserves the key as `processing`,
2. identical key + different body/wallet/operation → `409`,
3. `completed` → stored response replayed with `replayed: true`,
4. `processing` → `409` (never auto-rebroadcast),
5. `failed` → `409` (key cannot be reused).

A crash between broadcast and the completion write leaves the key in
`processing` on purpose: an operator reconciles the signature instead of risking
a double spend. If only the completion write fails after a successful broadcast,
the response is still returned and the key stays `processing`.

Deposits: `blockchain_transactions` has a unique
`(signature, wallet_public_key, direction)` constraint, so recording the same
deposit twice is a 200 replay, never a second credit.

## 5. Input and transport hardening

- No SQL string interpolation anywhere: every query is parameterized.
- Request bodies are size-limited (32 KB) and shape-validated; unknown fields
  are rejected so clients cannot inject `accountIndex`/`derivationPath`.
- Route parameters (`:id`, `:accountIndex`, `:signature`, public keys, amounts)
  are validated before any service call.
- 500 responses are generic; internal messages stay in the server log.
- Fixed-window, in-memory rate limits: HD root creation 20/min, account
  creation 30/min, recovery provisioning 5/min, estimates 60/min, withdrawals
  10/min — **per process**. Multi-instance deployments need a shared limiter at
  the ingress.
- TLS must terminate at the reverse proxy; the server binds to `127.0.0.1` by
  default.
- PostgreSQL connections to remote hosts must use `sslmode=verify-full`
  (enforced at startup).

## 6. Threat model (abridged)

| Threat | Mitigation | Residual risk |
|---|---|---|
| Stolen API key | rate limits, no key material in responses | full withdrawal authority for every wallet |
| Compromised DB backup | AES-256-GCM, key lives outside the DB | key and backup stolen together |
| Malicious RPC provider | amounts verified against parsed transfers; destination checked | RPC could hide/reorder data (no light-client checks) |
| Double spend via retries | idempotency reservation, unique ledger identity | manual reconciliation of `processing` rows |
| Ciphertext swapping between rows | AAD includes row id and purpose | — |
| Recovery token interception | purpose-derived key, single redemption, `no-store` | token valid for the configured window until redeemed |
| Memory scraping on host | minimal key lifetime, best-effort zeroization | process memory is not protected by an HSM |

## 7. Backup and recovery

- Back up PostgreSQL (wallets, hd_wallets, wallet_accounts,
  blockchain_transactions) **and** the encryption key, separately. Neither is
  useful without the other.
- A root mnemonic recovered offline re-derives every child address and private
  key (`m/44'/501'/{i}'/0'`), which is the disaster-recovery path for account
  rows that are lost but whose index is known.
- Test restores in a non-production environment; never restore production keys
  into a development database.
