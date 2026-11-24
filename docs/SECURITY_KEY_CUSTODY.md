# BLACKCHIN key custody and HSM-portable envelope architecture

Status: **provider foundation implemented; application cut-over not complete**.

## Security boundary

The current application still contains a legacy Node.js AES key provider and HD signing path. The new Vault Transit adapter and wrapped-DEK envelope module are a foundation; they are not yet wired into HD wallet creation, child derivation, recovery, or withdrawal signing. Do not enable them for production funds until the integration and migration gates below pass.

## Target responsibility split

- API/control plane: authenticate callers, enforce tenant isolation and withdrawal policy, reserve idempotency state, and pass public transaction context to the signer.
- Neon PostgreSQL: persist wallet metadata, public child addresses, ledger state, and encrypted envelopes. It must never hold plaintext mnemonics, seeds, DEKs, or private keys.
- Vault Transit: protect per-envelope 256-bit data-encryption keys (DEKs). Vault's Transit key is a KEK; it is not a Solana signing key.
- Rust signer process: own the HD root lifecycle, unwrap a DEK through a signer-only Vault identity, decrypt the mnemonic envelope, derive the immutable Solana SLIP-0010 path, validate the expected public key, and sign. It returns only public metadata and signatures.
- HSM adapter (future): implement the same envelope-key-provider contract using a non-exportable HSM KEK for wrap/unwrap. This does not automatically make Ed25519 signing occur inside the HSM. Direct HSM signing is a separate adapter and requires verified support for Ed25519 plus the exact SLIP-0010 derivation scheme.

## Envelope format

src/infrastructure/security/envelope-crypto.js uses:
- AES-256-GCM with a fresh random 32-byte DEK for each envelope;
- a fresh 12-byte IV and 16-byte authentication tag;
- mandatory caller-supplied AAD, which must bind tenant ID, HD wallet ID, network, derivation scheme, and purpose;
- a Vault Transit-wrapped DEK and its key version;
- best-effort zeroization of local DEK and temporary buffers.

The caller must zeroize the plaintext Buffer returned by decrypt(). JavaScript and general-purpose OS memory do not provide a guarantee against copies, paging, crash dumps, or privileged process inspection.

## Vault local development

The Compose file under infra/local/vault/docker-compose.yml intentionally runs Vault dev mode:
- binds the published port only to 127.0.0.1;
- uses an explicitly local-only root token;
- keeps state in memory and loses it when the container is recreated;
- is suitable only for disposable development/test data.

Start it with npm run vault:local:up. Run infra/local/vault/bootstrap.ps1 from the repository root in PowerShell to enable Transit, create the AES-256-GCM-96 key, install the signer policy, and mint a short-lived local signer token.

Never reuse the dev token, Transit key, or dev-mode configuration on a VPS or for real funds. A production Vault deployment needs durable storage, TLS, authenticated service identities, short-lived least-privilege tokens, audit-device verification, unseal/recovery procedures, encrypted off-host backups, and a tested disaster-recovery plan.

## HSM portability contract

assertEnvelopeKeyProvider() defines the narrow interface:
- wrapKey(dek) -> { wrappedKey, keyVersion }
- unwrapKey(wrappedKey) -> Buffer(32)

Vault Transit is one implementation. A future PKCS#11/HSM implementation can satisfy the same interface. The envelope schema and wallet repository should not depend on Vault-specific HTTP details.

For direct HSM Ed25519 signing, define a separate HdSigningProvider capability only after a candidate HSM proves:
1. Ed25519 key generation/import and signing behavior;
2. hardened SLIP-0010 derivation compatibility for m/44'/501'/{accountIndex}'/0';
3. public-key regression vectors match the current wallet population;
4. key backup, rotation, HA and recovery behavior are documented.

## Required application integration gates

1. Signer service: implement a private local Rust signer service; bind to loopback/Unix socket or private container network only; authenticate requests with short-lived service credentials and bounded message sizes.
2. Root creation: generate mnemonic inside signer, derive root/child public keys, encrypt root material through the new envelope provider, and never return plaintext except through an explicit one-time client-encrypted recovery flow.
3. Child creation: replace the API's revealMnemonicForSigning() callback with signer-owned child public-key derivation. The API receives only public keys.
4. Signing: replace wallet-signer.js local Node keypair resolution with remote signer calls; bind authorization to tenant, wallet, child index, network, message hash, destination, amount, idempotency key, expiry and one-use JTI.
5. Legacy migration: separately migrate existing AES-environment-key envelopes. Never bulk-decrypt them in the API. Verify all child public keys before retiring the old key path.
6. Recovery: replace server-readable recovery phrase responses with client-public-key encrypted recovery payloads; ensure the API and logs only see ciphertext.
7. Database privileges: API and ordinary worker roles must not be able to read encrypted root-envelope columns unless explicitly required. The signer gets a narrowly scoped repository operation; keep RLS and tenant-context verification.
8. Chaos/security tests: duplicate capability, cross-tenant access, wrong network, modified message/AAD, Vault outage, DB outage, process restart, concurrent sign requests, and RPC ambiguity.

## Operational status

The provider contract, Vault Transit adapter, AES-GCM wrapped-DEK envelope primitive, unit tests, and localhost-only Vault development bootstrap are present on the feature branch. Existing wallet creation/signing still uses the legacy synchronous cipher until gates 1–7 are completed. Passing provider unit tests does not prove the complete wallet custody flow.