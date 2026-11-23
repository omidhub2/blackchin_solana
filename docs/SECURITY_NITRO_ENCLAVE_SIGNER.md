# BLACKCHIN Nitro Enclave Remote Signing Architecture

Status: implementation foundation only; **not production-enabled**.

Target branch: `feat/nitro-enclave-remote-signer`

## Security objective

The API, tenant workers, database runtime roles, and EC2 parent instance must never receive a plaintext HD mnemonic, BIP-39 seed, SLIP-0010 private node, or Solana child secret key during normal signing. Only an attested Nitro Enclave may decrypt root material, derive the configured child path, and sign.

AWS KMS is the envelope-key authority. It does **not** perform Solana Ed25519 signing. Ed25519 derivation and signing happen inside the enclave.

## Components and trust boundaries

1. **BLACKCHIN API / policy control plane** — authenticates the tenant, checks the withdrawal policy, reserves the idempotency key, and issues a short-lived, single-use signing authorization.
2. **PostgreSQL** — stores wallet metadata and encrypted root envelopes. The ordinary API/worker DB roles must not be granted access to plaintext key material (none is stored).
3. **Parent-instance signer gateway** — authenticates the API over private TLS/mTLS, validates request size/rate limits, and relays messages over vsock. It is an untrusted relay; it must not decrypt wallet data or hold signing keys.
4. **Nitro Enclave** — validates the KMS attestation path and authorization capability, decrypts the data key, decrypts the root mnemonic, derives `m/44'/501'/{accountIndex}'/0'`, validates the resulting public key, parses the Solana message, checks the authorization claims against the message, and returns only a 64-byte Ed25519 signature.
5. **AWS KMS** — holds the symmetric envelope KEK and releases plaintext data keys only to an enclave presenting an attestation document that matches the key policy.
6. **Solana RPC** — receives the fully signed transaction from the parent/API after the signature has been durably persisted in the idempotency row.

## Envelope format and wallet creation

Do not keep using `ENCRYPTION_KEY` as the production root-encryption key.

For each HD root:
- Generate the BIP-39 mnemonic inside the enclave.
- Request an AES-256 data key from KMS using an attested `GenerateDataKey` call. The response must use `CiphertextForRecipient`; plaintext key material is only decrypted inside the enclave.
- Encrypt the mnemonic inside the enclave with AES-256-GCM and AAD binding at minimum tenant ID, HD wallet ID, network, derivation scheme, and envelope version.
- Persist only the mnemonic ciphertext, IV, authentication tag, KMS-encrypted data key (`CiphertextBlob`), KMS key ARN/version metadata, and envelope version.
- Never include mnemonic, seed, data key, or private key in logs, traces, events, crash dumps, or ordinary API responses.

The recovery phrase is a special one-time disclosure flow. Prefer encrypting the phrase to a client-generated ephemeral public key so the API and parent gateway only relay ciphertext. The existing server-side recovery-token plaintext flow must not be treated as enclave-safe until it has been replaced or explicitly threat-modelled.

## Signing authorization capability

A tenant policy approval is not, by itself, a signer authorization. The control plane must mint a short-lived JWS using ES256 (a dedicated asymmetric KMS signing key) after all policy checks and the durable withdrawal reservation succeed.

Required claims:
- `iss`, `aud`, `iat`, `exp`, `jti`
- `tenantId`, `hdWalletId`, `accountIndex`, `publicKey`
- `network`, `messageSha256`, `amountLamports`, `destination`
- `idempotencyKey`, `approvalReference`, `policyVersion`

The enclave pins the policy-signing public key and verifies the JWS, audience, expiry, request ID, network, wallet identity, derivation path, message hash, destination, and exact lamport amount. A capability must be one-use. Enforce replay protection with a durable nonce/jti registry or a bounded, strongly consistent authorization service; an in-memory enclave cache alone is insufficient across enclave restarts or replicas.

## Solana transaction flow

1. API validates request and policy; creates durable idempotency reservation.
2. API obtains recent blockhash and constructs a canonical native SOL transfer message.
3. API computes SHA-256 of the serialized message and obtains a short-lived signing capability bound to that hash and all transaction fields.
4. API sends public wallet context, serialized message, and capability to the signer gateway. It does not send a mnemonic or private key.
5. Gateway relays the request to the enclave over vsock.
6. Enclave verifies capability and message semantics; decrypts envelope using KMS attestation; derives the expected child key; verifies derived public key equals the registered public key; signs the exact message bytes; wipes owned buffers on a best-effort basis.
7. Gateway returns the signature. API attaches it to the transaction and verifies the signature locally before serialization.
8. API persists the transaction signature **before** broadcast, then submits raw transaction to Solana RPC.
9. Existing reconciliation resolves ambiguous RPC/database outcomes by the persisted signature. Never re-sign/rebroadcast an ambiguous withdrawal under a new idempotency key.

The signer must reject any unsupported program, extra instruction, unexpected fee payer, wrong network, wrong derivation scheme, destination mismatch, amount mismatch, stale/used capability, or message-hash mismatch.

## KMS and Nitro controls

- Use a symmetric KMS key dedicated to wallet envelope data keys, separate from the ES256 capability-signing key.
- Restrict KMS decrypt/data-key operations with attestation condition keys such as `kms:RecipientAttestation:ImageSha384` and/or PCR conditions for the approved EIF.
- Use production EIF measurements; **never authorize debug-mode all-zero PCR values**.
- Enclave has no external network. KMS access is through the parent `vsock-proxy` allowlist and Nitro Enclaves SDK.
- Do not bake secrets, mnemonic fixtures, credentials, or production configuration into the EIF or Docker image.
- Parent instance uses IMDSv2 and a least-privilege instance profile; no long-lived AWS credentials in environment variables.
- CloudTrail records KMS use. Do not log sensitive request bodies or authorization tokens.
- Deploy immutable EIF artifacts; require reviewed builds and measurement promotion before updating KMS policy.

## Migration from the current AES-256-GCM environment-key envelope

Migration must be a separate, audited operation:
1. Freeze wallet creation and signing or run a controlled maintenance window.
2. Build a one-time migration enclave image that supports the existing envelope version and new KMS envelope version.
3. Deliver the legacy `ENCRYPTION_KEY` to the enclave only as a KMS-encrypted secret, never as a plain environment variable on the parent instance.
4. The enclave decrypts each old mnemonic, validates it by re-deriving a sample of registered public keys, then re-encrypts it under a fresh KMS data key and new AAD.
5. Write new envelope columns/version transactionally; retain old ciphertext only until post-migration verification and backup policy permit deletion.
6. Verify every registered child public key and derivation path before marking a root migrated.
7. Remove legacy key material from application secrets only after all roots and recovery flows have migrated.
8. Keep legacy signer path disabled for migrated wallets; fail closed if an envelope version is unknown.

Never perform bulk decrypt/re-encrypt in the ordinary API process.

## Failure and concurrency requirements

- No local-key fallback when `SIGNER_MODE=nitro`; signer unavailable means no signature and no broadcast.
- Signer timeout is ambiguous only if the signer may have produced a signature. The API must not broadcast unless it receives a validated signature and persists the resulting transaction signature.
- Idempotency and one-processing-withdrawal-per-wallet constraints remain enforced in PostgreSQL.
- Enclave authorization replay protection must be durable across replicas and restarts.
- Test RPC loss before and after signature persistence, DB loss before broadcast, gateway/enclave restart, concurrent identical requests, different concurrent requests from one wallet, duplicate capability, and malformed/oversized messages.

## Delivery gates

### Gate A — repository contract
- Remote signer client with strict input/response binding and no private-key fields.
- Transaction adapter accepts a remote signature, attaches it, and verifies it.
- Unit tests prove there is no local signer fallback in Nitro mode.

### Gate B — enclave implementation
- Reproducible EIF build, vsock protocol, KMS attested data-key decrypt, AES-GCM envelope, BIP-39 + SLIP-0010 derivation, Ed25519 signing, capability verification, buffer handling.

### Gate C — AWS deployment
- Nitro-capable EC2 instance, enclave allocator, vsock proxy allowlist, IAM roles, KMS policies pinned to measured EIF, private gateway transport, CloudTrail alarms.

### Gate D — migration and integration
- Existing wallet migration, recovery phrase E2E, API-to-enclave-to-Solana Devnet flow, signature persistence and reconciliation.

### Gate E — chaos and security
- Race, restart, RPC outage, DB outage, replay, tampering, cross-tenant, wrong-network, malformed message, and dependency/audit tests.

**Current repository status:** Gate A is being introduced on the feature branch. Gates B–E require implementation and an AWS Nitro-capable environment with account permissions and KMS/EC2 configuration. A passing Node CI suite cannot prove Nitro attestation or a real Devnet transfer.
