/**
 * BIP39 mnemonic handling and Solana HD derivation.
 *
 * Scheme (documented in docs/HD_WALLET_ARCHITECTURE.md and never changed
 * silently):
 *
 *   mnemonic (BIP39, 256-bit entropy, 24 words, English wordlist)
 *     -> BIP39 seed: PBKDF2-HMAC-SHA512(mnemonic, "mnemonic"+passphrase, 2048, 64)
 *     -> SLIP-0010 Ed25519 master node (hardened-only)
 *     -> m/44'/501'/{accountIndex}'/0'
 *     -> 32-byte Ed25519 private seed
 *     -> Keypair.fromSeed(seed)   (Solana 64-byte secret key = seed || public key)
 */
import { Keypair } from '@solana/web3.js';
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from '@scure/bip39';
import { wordlist as englishWordlist } from '@scure/bip39/wordlists/english.js';

import {
  deriveSlip10MasterKey,
  deriveSlip10Path,
  parseHardenedPath,
  SLIP10_CURVE,
  SLIP10_MAX_INDEX
} from './slip10-ed25519.js';

export const DEFAULT_MNEMONIC_WORDS = 24;
export const DEFAULT_MNEMONIC_ENTROPY_BITS = 256;
export const SOLANA_COIN_TYPE = 501;
export const DERIVATION_SCHEME = 'bip39+slip10-ed25519/v1';
export const DERIVATION_PATH_TEMPLATE = "m/44'/501'/{accountIndex}'/0'";
export const MAX_ACCOUNT_INDEX = SLIP10_MAX_INDEX;
export const WORDLIST_NAME = 'english';

const SUPPORTED_MNEMONIC_WORDS = new Set([12, 15, 18, 21, 24]);

/**
 * Generate a cryptographically secure BIP39 mnemonic.
 * @param {number} entropyBits 128-256, default 256 (24 words)
 */
export function generateHdMnemonic(entropyBits = DEFAULT_MNEMONIC_ENTROPY_BITS) {
  if (!Number.isSafeInteger(entropyBits) || entropyBits < 128 || entropyBits > 256 || entropyBits % 32 !== 0) {
    throw new RangeError('Mnemonic entropy must be 128, 160, 192, 224 or 256 bits');
  }

  const mnemonic = generateMnemonic(englishWordlist, entropyBits);

  if (!validateMnemonic(mnemonic, englishWordlist)) {
    // Should be impossible; fail closed rather than persisting bad material.
    throw new Error('Generated mnemonic failed checksum validation');
  }

  return mnemonic;
}

/**
 * Normalize user-supplied mnemonic input (trim, collapse whitespace, lowercase).
 */
export function normalizeMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string') {
    throw new TypeError('Mnemonic must be a string');
  }

  return mnemonic.trim().toLowerCase().replace(/\s+/g, ' ');
}

/**
 * Validate a BIP39 mnemonic (checksum + supported wordlist).
 */
export function validateHdMnemonic(mnemonic) {
  if (typeof mnemonic !== 'string') {
    return false;
  }

  const normalized = normalizeMnemonic(mnemonic);
  const words = normalized.length === 0 ? 0 : normalized.split(' ').length;

  if (!SUPPORTED_MNEMONIC_WORDS.has(words)) {
    return false;
  }

  return validateMnemonic(normalized, englishWordlist);
}

/**
 * Derive the 64-byte BIP39 seed.
 * An optional BIP39 passphrase is supported and part of the derivation
 * identity: a different passphrase produces a completely different wallet.
 */
export function mnemonicToHdSeed(mnemonic, passphrase = '') {
  const normalized = normalizeMnemonic(mnemonic);

  if (!validateHdMnemonic(normalized)) {
    throw new TypeError('Mnemonic is invalid: unsupported words or failed checksum');
  }

  if (typeof passphrase !== 'string') {
    throw new TypeError('BIP39 passphrase must be a string');
  }

  return Buffer.from(mnemonicToSeedSync(normalized, passphrase));
}

/**
 * Build the derivation path for an account index.
 */
export function deriveAccountPath(accountIndex) {
  validateAccountIndex(accountIndex);

  return DERIVATION_PATH_TEMPLATE.replace('{accountIndex}', String(accountIndex));
}

export function validateAccountIndex(accountIndex) {
  if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > MAX_ACCOUNT_INDEX) {
    throw new RangeError(
      `Account index must be an integer between 0 and ${MAX_ACCOUNT_INDEX}`
    );
  }

  return accountIndex;
}

/**
 * Make sure a caller-supplied path matches the supported template for the
 * given account index. Paths are never silently rewritten.
 */
export function assertSupportedDerivationPath(path, accountIndex) {
  parseHardenedPath(path);

  const expected = deriveAccountPath(accountIndex);

  if (path !== expected) {
    throw new TypeError(
      `Derivation path ${path} does not match the supported scheme (expected ${expected})`
    );
  }

  return path;
}

/**
 * Derive the 32-byte Ed25519 private seed for an account index from a seed.
 * @param {Uint8Array|Buffer} seed BIP39 seed (64 bytes)
 * @param {number} accountIndex
 * @returns {Buffer}
 */
export function deriveEd25519Seed(seed, accountIndex) {
  let master;
  let node;

  try {
    master = deriveSlip10MasterKey(seed);
    node = deriveSlip10Path(master, deriveAccountPath(accountIndex));

    return Buffer.from(node.key);
  } finally {
    master?.key?.fill(0);
    master?.chainCode?.fill(0);
    node?.key?.fill(0);
    node?.chainCode?.fill(0);
  }
}

/**
 * Derive a Solana keypair for the given account index.
 *
 * @param {string} mnemonic
 * @param {number} accountIndex
 * @param {{ passphrase?: string }} [options]
 * @returns {{ keypair: Keypair, publicKey: string, derivationPath: string,
 *             scheme: string, curve: string, accountIndex: number,
 *             secretKey: Buffer }}
 */
export function deriveSolanaAccount(mnemonic, accountIndex, { passphrase = '' } = {}) {
  const seed = mnemonicToHdSeed(mnemonic, passphrase);

  try {
    return deriveSolanaAccountFromSeedBuffer(seed, accountIndex);
  } finally {
    seed.fill(0);
  }
}

/**
 * Buffer-based derivation: the preferred entry point for signing code.
 *
 * The caller's seed buffer is NOT zeroed (the caller owns it); every
 * intermediate buffer created here (master key, chain codes, child seed) is
 * zeroed before returning, including on failure.
 */
export function deriveSolanaAccountFromSeedBuffer(seed, accountIndex) {
  validateAccountIndex(accountIndex);

  if (!(seed instanceof Uint8Array) || seed.length === 0) {
    throw new TypeError('A BIP39 seed buffer is required');
  }

  let master;
  let node;
  let childSeed;

  try {
    master = deriveSlip10MasterKey(seed);
    node = deriveSlip10Path(master, deriveAccountPath(accountIndex));

    childSeed = Buffer.from(node.key);

    const keypair = Keypair.fromSeed(childSeed);
    const secretKey = Buffer.from(keypair.secretKey);
    const publicKey = keypair.publicKey.toBase58();

    if (secretKey.length !== 64) {
      throw new Error('Derived Solana secret key must be 64 bytes');
    }

    if (!Buffer.from(secretKey.subarray(32)).equals(Buffer.from(keypair.publicKey.toBytes()))) {
      throw new Error('Derived secret key does not embed its public key');
    }

    return {
      keypair,
      publicKey,
      derivationPath: deriveAccountPath(accountIndex),
      scheme: DERIVATION_SCHEME,
      curve: SLIP10_CURVE,
      accountIndex,
      secretKey
    };
  } finally {
    master?.key?.fill(0);
    master?.chainCode?.fill(0);
    node?.key?.fill(0);
    node?.chainCode?.fill(0);
    childSeed?.fill(0);
  }
}

/**
 * Derive only the public key for an account index (used for reconciliation
 * and recovery checks).
 */
export function deriveSolanaPublicKey(mnemonic, accountIndex, options) {
  const derived = deriveSolanaAccount(mnemonic, accountIndex, options);

  try {
    derived.secretKey.fill(0);

    return {
      publicKey: derived.publicKey,
      derivationPath: derived.derivationPath
    };
  } finally {
    if (derived.keypair.secretKey.fill) {
      derived.keypair.secretKey.fill(0);
    }
  }
}
