# HD Wallet Architecture — Current Solana Implementation

This document describes the implemented Solana HD wallet design. The target multi-tenant wallet model is defined in [Architecture](ARCHITECTURE.md). Current tenant isolation is not implemented.

## 1. Wallet types

| Type | Created by | Key source | Storage |
|---|---|---|---|
| Standalone legacy | `POST /api/v1/wallets` | generated keypair, encrypted | `wallets` |
| HD child | `POST /api/v1/hd-wallets/:id/accounts` | derived from root mnemonic | `wallet_accounts` |

The HD root is a logical derivation namespace, not an on-chain account. Its aggregate balance is computed from child addresses.

## 2. Derivation

Scheme: `bip39+slip10-ed25519/v1`.

```
24-word BIP39 mnemonic
  -> BIP39 seed (PBKDF2-HMAC-SHA512)
  -> SLIP-0010 Ed25519 master node
  -> hardened path m/44'/501'/{accountIndex}'/0'
  -> child Ed25519 seed
  -> Solana Keypair / Base58 address
```

Every derivation level is hardened. The scheme and path are versioned and stored with the root. Changing a derivation scheme silently would make existing addresses unrecoverable.

## 3. Secret lifecycle

- Root mnemonic is encrypted using AES-256-GCM with row/purpose-bound AAD.
- Child private keys are derived when signing and are not stored as ordinary child key rows.
- Recovery phrase is provisioned once through a purpose-bound one-time token; plaintext tokens are not persisted.
- API list/read responses never expose private key material.
- Key rotation is versioned; removing a key version still referenced by rows makes those rows unreadable.
- JavaScript zeroization is best-effort, not a hardware security boundary.

Production multi-tenant deployment requires tenant-specific wallet namespace authorization and a dedicated KMS/HSM-backed signer or an equivalently isolated key service. Current environment-key encryption is not a KMS/HSM implementation.

## 4. Account allocation

Child account creation uses a PostgreSQL transaction and row/advisory locking to allocate consecutive indexes. Unique constraints on root/index, root/path and public key provide final collision protection. Batch creation is limited to 50 children per request.

## 5. Signing flow

```
authenticated request
  -> resolve wallet and validate lifecycle/network
  -> authorize tenant ownership (target requirement; not yet implemented)
  -> decrypt root material and derive child in memory
  -> verify derived public key equals registered address
  -> sign only an approved durable operation
  -> broadcast through chain adapter
  -> zeroize transient key buffers (best effort)
```

No signer API should accept arbitrary unauthenticated client-provided key material or bypass operation policy.

## 6. Tenant target

The intended deployment provisions a separate logical root/namespace per tenant and chain. Each address allocation is linked to its tenant and wallet root. Tenant context must be checked in repositories and again at the signer boundary. The current `owner_id` field is not sufficient and is not enforced.

## 7. Current scope

Implemented and tested: Solana native SOL HD derivation, child allocation, balance and native transfer signing paths.

Not implemented: EVM derivation/signing, TRON derivation/signing, SPL/ERC-20/TRC-20 token transfers, multi-tenant authorization, KMS/HSM signer integration and complete tenant address allocation.
