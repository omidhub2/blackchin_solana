//! BLACKCHIN's minimal Solana HD derivation and Ed25519 signing core.
//!
//! Intended to run inside the Nitro Enclave process. This crate is not an
//! HTTP server, KMS client, vsock gateway, or authorization verifier.
//! Those boundaries must be implemented before production use. No API
//! returns mnemonic, seed, chain code, or private-key bytes.

use bip39::Mnemonic;
use ed25519_dalek::{Signer, SigningKey};
use hmac::{Hmac, Mac};
use sha2::Sha512;
use zeroize::Zeroize;

type HmacSha512 = Hmac<Sha512>;

const HARDENED_OFFSET: u32 = 0x8000_0000;
const MAX_ACCOUNT_INDEX: u32 = 0x7fff_ffff;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SignerCoreError {
    InvalidMnemonic,
    InvalidAccountIndex,
    InvalidExpectedPublicKey,
    PublicKeyMismatch,
}

impl std::fmt::Display for SignerCoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let message = match self {
            Self::InvalidMnemonic => "invalid BIP-39 mnemonic",
            Self::InvalidAccountIndex => "account index is outside the supported range",
            Self::InvalidExpectedPublicKey => "expected Solana public key must be 32 bytes",
            Self::PublicKeyMismatch => "derived public key does not match the registered wallet",
        };
        f.write_str(message)
    }
}

impl std::error::Error for SignerCoreError {}

struct Slip10Node {
    key: [u8; 32],
    chain_code: [u8; 32],
}

impl Drop for Slip10Node {
    fn drop(&mut self) {
        self.key.zeroize();
        self.chain_code.zeroize();
    }
}

fn hmac_sha512(key: &[u8], data: &[u8]) -> [u8; 64] {
    let mut mac = HmacSha512::new_from_slice(key)
        .expect("HMAC accepts keys of any length");
    mac.update(data);
    let result = mac.finalize().into_bytes();
    let mut output = [0u8; 64];
    output.copy_from_slice(&result);
    output
}

fn master_node(seed: &[u8]) -> Slip10Node {
    let mut digest = hmac_sha512(b"ed25519 seed", seed);
    let mut key = [0u8; 32];
    let mut chain_code = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    chain_code.copy_from_slice(&digest[32..]);
    digest.zeroize();
    Slip10Node { key, chain_code }
}

fn child_node(parent: &Slip10Node, index: u32) -> Slip10Node {
    let hardened_index = index + HARDENED_OFFSET;
    let mut data = [0u8; 37];
    data[0] = 0;
    data[1..33].copy_from_slice(&parent.key);
    data[33..37].copy_from_slice(&hardened_index.to_be_bytes());

    let mut digest = hmac_sha512(&parent.chain_code, &data);
    data.zeroize();
    let mut key = [0u8; 32];
    let mut chain_code = [0u8; 32];
    key.copy_from_slice(&digest[..32]);
    chain_code.copy_from_slice(&digest[32..]);
    digest.zeroize();
    Slip10Node { key, chain_code }
}

fn derive_account_node(seed: &[u8], account_index: u32) -> Slip10Node {
    let mut node = master_node(seed);
    for index in [44, 501, account_index, 0] {
        let next = child_node(&node, index);
        drop(node);
        node = next;
    }
    node
}

/// Derive and sign a serialized Solana message for the repository's immutable
/// path m/44'/501'/{account_index}'/0'.
///
/// The expected public key is checked before signing. Private material remains
/// in this process and is never returned to the caller.
pub fn sign_solana_message(
    mnemonic_phrase: &str,
    account_index: u32,
    expected_public_key: &[u8],
    message: &[u8],
) -> Result<[u8; 64], SignerCoreError> {
    if account_index > MAX_ACCOUNT_INDEX {
        return Err(SignerCoreError::InvalidAccountIndex);
    }
    if expected_public_key.len() != 32 {
        return Err(SignerCoreError::InvalidExpectedPublicKey);
    }

    let mnemonic = Mnemonic::parse(mnemonic_phrase)
        .map_err(|_| SignerCoreError::InvalidMnemonic)?;
    let mut seed = mnemonic.to_seed("");
    let node = derive_account_node(&seed, account_index);
    seed.zeroize();

    let signing_key = SigningKey::from_bytes(&node.key);
    let actual_public_key = signing_key.verifying_key().to_bytes();
    if actual_public_key.as_slice() != expected_public_key {
        return Err(SignerCoreError::PublicKeyMismatch);
    }

    let signature = signing_key.sign(message).to_bytes();
    Ok(signature)
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Verifier, VerifyingKey};

    const MNEMONIC: &str = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

    #[test]
    fn matches_blackchin_sol_address_regression_vectors() {
        let expected = [
            (0u32, "3Cy3YNTFywCmxoxt8n7UH6hg6dLo5uACowX3CFceaSnx"),
            (1u32, "5frqxtii9LeGq2bz3dSNokvZcEooF483MzeU24JrhcTA"),
            (2u32, "3SuKj3MZU9dMZ9oR1R7afttihZFkWpfUmduuv9rmfMa1"),
        ];
        let mut seed = Mnemonic::parse(MNEMONIC).unwrap().to_seed("");
        for (index, address) in expected {
            let node = derive_account_node(&seed, index);
            let signing_key = SigningKey::from_bytes(&node.key);
            let decoded = bs58::decode(address).into_vec().unwrap();
            assert_eq!(decoded, signing_key.verifying_key().to_bytes());
        }
        seed.zeroize();
    }

    #[test]
    fn signs_only_when_derived_key_matches_registered_public_key() {
        let mut seed = Mnemonic::parse(MNEMONIC).unwrap().to_seed("");
        let node = derive_account_node(&seed, 0);
        let signing_key = SigningKey::from_bytes(&node.key);
        let public_key = signing_key.verifying_key().to_bytes();
        let message = b"blackchin remote signer test message";

        let signature = sign_solana_message(MNEMONIC, 0, &public_key, message).unwrap();
        let verifying_key = VerifyingKey::from_bytes(&public_key).unwrap();
        verifying_key.verify(message, &ed25519_dalek::Signature::from_bytes(&signature)).unwrap();

        assert_eq!(
            sign_solana_message(MNEMONIC, 0, &[0u8; 32], message),
            Err(SignerCoreError::PublicKeyMismatch)
        );
        seed.zeroize();
    }

    #[test]
    fn rejects_invalid_mnemonics_and_account_indexes() {
        assert_eq!(
            sign_solana_message("not a mnemonic", 0, &[0u8; 32], b"x"),
            Err(SignerCoreError::InvalidMnemonic)
        );
        assert_eq!(
            sign_solana_message(MNEMONIC, u32::MAX, &[0u8; 32], b"x"),
            Err(SignerCoreError::InvalidAccountIndex)
        );
        assert_eq!(
            sign_solana_message(MNEMONIC, 0, &[0u8; 31], b"x"),
            Err(SignerCoreError::InvalidExpectedPublicKey)
        );
    }

    #[test]
    fn slip10_master_matches_official_vector() {
        let seed = (0u8..16u8).collect::<Vec<_>>();
        let node = master_node(&seed);
        assert_eq!(
            hex(&node.key),
            "2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7"
        );
        assert_eq!(
            hex(&node.chain_code),
            "90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb"
        );
    }

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }
}
