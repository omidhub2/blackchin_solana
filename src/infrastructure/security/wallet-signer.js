import { notFound } from '../../core/errors.js';
import { deriveSolanaAccount } from '../../blockchain/solana/hd/derivation.js';
import { getDefaultCipher } from './hd-envelope.js';
import { findAccountByPublicKey } from '../database/wallet-account.repository.js';
import { findHdWalletById } from '../database/hd-wallet.repository.js';
import { findWalletMetadataByPublicKey } from '../database/wallet.repository.js';
import {
  decryptLegacyPrivateKey,
  findLegacyWalletByPublicKey
} from './legacy-wallet.js';

/**
 * Internal invariant violated: stored wallet data cannot produce its key.
 * Treated as a 500 (never a client error) because it requires operator action.
 */
function keyIntegrityError(message) {
  const error = new Error(message);
  error.statusCode = 500;
  error.code = 'WALLET_KEY_INTEGRITY_ERROR';
  error.expose = false;

  return error;
}

function mnemonicAad(hdWalletId) {
  return `hd_wallets:${hdWalletId}:mnemonic:v1`;
}

/**
 * Describe where a wallet lives without decrypting anything.
 *
 * @returns {Promise<{
 *   publicKey: string,
 *   walletType: 'hd_child' | 'standalone',
 *   status: 'active' | 'disabled' | 'archived',
 *   network: string|null,
 *   hdWalletId: string|null,
 *   accountIndex: number|null,
 *   derivationPath: string|null
 * } | null>}
 */
export async function resolveWallet(db, publicKey) {
  const account = await findAccountByPublicKey(db, publicKey);

  if (account) {
    return {
      publicKey: account.publicKey,
      walletType: 'hd_child',
      status: account.status,
      network: account.network,
      hdWalletId: account.hdWalletId,
      accountIndex: account.accountIndex,
      derivationPath: account.derivationPath
    };
  }

  const legacy = await findWalletMetadataByPublicKey(publicKey);

  if (legacy) {
    return {
      publicKey: legacy.publicKey,
      walletType: 'standalone',
      // Legacy rows predate the lifecycle column and are always usable.
      status: 'active',
      network: null,
      hdWalletId: null,
      accountIndex: null,
      derivationPath: null
    };
  }

  return null;
}

/**
 * Resolve a wallet or throw 404 (read endpoints).
 */
export async function requireWallet(db, publicKey) {
  const wallet = await resolveWallet(db, publicKey);

  if (!wallet) {
    throw notFound(
      'Wallet address was not found in the local wallet database',
      'WALLET_NOT_FOUND'
    );
  }

  return wallet;
}

/**
 * Derive the signing keypair of an HD child account.
 *
 * The mnemonic is decrypted, the child seed derived for its stored index, and
 * the result is checked against the stored public key before use.
 */
export async function loadHdChildKeypair(db, account, { cipher = getDefaultCipher() } = {}) {
  const hdWallet = await findHdWalletById(db, account.hdWalletId);

  if (!hdWallet) {
    throw notFound('Parent HD wallet was not found', 'HD_WALLET_NOT_FOUND');
  }

  const mnemonic = cipher.decrypt(
    hdWallet.mnemonicEncrypted,
    hdWallet.mnemonicIv,
    hdWallet.mnemonicAuthTag,
    {
      aad: mnemonicAad(hdWallet.id),
      keyVersion: hdWallet.encryptionKeyVersion
    }
  );

  const derived = deriveChildOrThrow(mnemonic, account.accountIndex);

  if (derived.publicKey !== account.publicKey) {
    derived.secretKey.fill(0);
    zeroizeKeypair(derived.keypair);
    throw keyIntegrityError(
      'Derived public key does not match the stored wallet account; signing refused'
    );
  }

  return {
    keypair: derived.keypair,
    derivationPath: derived.derivationPath,
    hdWalletId: hdWallet.id
  };
}

function deriveChildOrThrow(mnemonic, accountIndex) {
  try {
    return deriveSolanaAccount(mnemonic, accountIndex);
  } catch (error) {
    throw keyIntegrityError('Unable to derive the signing key for this wallet account');
  }
}

/**
 * Best-effort zeroization of a signing keypair.
 *
 * web3.js `keypair.secretKey` returns a *copy* of the internal buffer, so
 * `keypair.secretKey.fill(0)` erases nothing. The 64-byte secret is instead
 * reconstructed from the private `_keypair` internals (when present) and
 * overwritten in place; every copy we created is zeroed as well.
 *
 * Node.js cannot guarantee that the GC never copies these buffers, so this is
 * best-effort hardening, not a hardware guarantee.
 */
export function zeroizeKeypair(keypair) {
  if (!keypair || typeof keypair !== 'object') return;

  const candidates = [];
  const internal = keypair._keypair;

  // `secretKey` returns a copy on each access; the internal view is the one
  // that matters and must be read once, after the copies.
  if (keypair.secretKey) candidates.push(keypair.secretKey);
  if (internal?.privateKey) candidates.push(internal.privateKey);
  if (internal?.secretKey) candidates.push(internal.secretKey);

  for (const buffer of candidates) {
    if (typeof buffer?.fill !== 'function' || typeof buffer.length !== 'number') continue;

    try {
      buffer.fill(0);
    } catch {
      // Ignore non-writable views; other candidates still get erased.
    }
  }
}

/**
 * Resolve a wallet to its signing keypair (without invoking a callback).
 * Callers MUST pass the result through `zeroizeKeypair` when done.
 */
export async function resolveSigningKeypair(db, publicKey, { cipher } = {}) {
  const account = await findAccountByPublicKey(db, publicKey);

  if (account) {
    if (account.status !== 'active') {
      const error = new Error('Wallet is not active and cannot sign transactions');
      error.statusCode = 409;
      error.code = 'WALLET_NOT_ACTIVE';
      throw error;
    }

    const loaded = await loadHdChildKeypair(db, account, { cipher });

    return {
      keypair: loaded.keypair,
      wallet: {
        publicKey: account.publicKey,
        walletType: 'hd_child',
        status: account.status,
        network: account.network,
        hdWalletId: account.hdWalletId,
        accountIndex: account.accountIndex,
        derivationPath: loaded.derivationPath
      }
    };
  }

  const legacyWallet = await findLegacyWalletByPublicKey(publicKey);

  if (!legacyWallet) {
    throw notFound('Sender wallet was not found in the wallet database', 'WALLET_NOT_FOUND');
  }

  return {
    keypair: decryptLegacyPrivateKey(legacyWallet),
    wallet: {
      publicKey: legacyWallet.publicKey,
      walletType: 'standalone',
      status: 'active',
      network: null,
      hdWalletId: null,
      accountIndex: null,
      derivationPath: null
    }
  };
}

/**
 * Run `callback` with the signing keypair for `publicKey`.
 *
 * The keypair is only valid inside the callback; it is zeroized afterwards on
 * a best-effort basis (see `zeroizeKeypair`).
 *
 * @template T
 * @param {object} db
 * @param {string} publicKey
 * @param {(ctx: { keypair: import('@solana/web3.js').Keypair, wallet: object }) => Promise<T>} callback
 * @param {{ cipher?: object }} [options]
 * @returns {Promise<T>}
 */
export async function withSigningKey(db, publicKey, callback, { cipher } = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('A signing callback is required');
  }

  const { keypair, wallet } = await resolveSigningKeypair(db, publicKey, { cipher });

  try {
    if (keypair.publicKey.toBase58() !== publicKey) {
      throw keyIntegrityError('Signing key does not match the requested wallet address');
    }

    return await callback({ keypair, wallet });
  } finally {
    zeroizeKeypair(keypair);
  }
}
