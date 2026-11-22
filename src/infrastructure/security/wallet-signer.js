import { Keypair } from '@solana/web3.js';

import { AppError, notFound } from '../../core/errors.js';
import {
  deriveSolanaAccountFromSeedBuffer,
  mnemonicToHdSeed
} from '../../blockchain/solana/hd/derivation.js';
import { getDefaultCipher } from './hd-envelope.js';
import { findAccountByPublicKey } from '../database/wallet-account.repository.js';
import { findHdWalletById } from '../database/hd-wallet.repository.js';
import { findWalletMetadataByPublicKey } from '../database/wallet.repository.js';
import {
  assertChildAllowsSigning,
  assertNetworkMatches,
  assertParentAllowsSigning,
  lockRowsForSigning
} from './lifecycle-policy.js';
import { decryptLegacyPrivateKey, findLegacyWalletByPublicKey } from './legacy-wallet.js';

const KEY_LOCK_TIMEOUT_MS = 5_000;

function keyIntegrityError() {
  const error = new Error('Stored wallet material cannot produce its signing key');
  error.statusCode = 500;
  error.code = 'WALLET_KEY_INTEGRITY_ERROR';
  error.expose = false;

  return error;
}

function mnemonicAad(hdWalletId) {
  return `hd_wallets:${hdWalletId}:mnemonic:v1`;
}

function assertSigningNetwork(walletNetwork, deploymentNetwork) {
  if (deploymentNetwork) {
    assertNetworkMatches(walletNetwork, deploymentNetwork);
  }
}

/**
 * Describe where a wallet lives without decrypting anything.
 *
 * For HD children the parent root's status and network are folded in so that
 * callers see `effectiveStatus` and never act on a stale child status.
 */
export async function resolveWallet(db, publicKey) {
  const account = await findAccountByPublicKey(db, publicKey);

  if (account) {
    const parent = await findHdWalletById(db, account.hdWalletId);
    const parentStatus = parent?.status ?? null;

    return {
      publicKey: account.publicKey,
      tenantId: account.tenantId ?? null,
      walletType: 'hd_child',
      status: account.status,
      effectiveStatus: account.status === 'active' && parentStatus === 'active'
        ? 'active'
        : (account.status === 'active' ? (parentStatus ?? 'missing') : account.status),
      parentStatus,
      network: account.network,
      hdWalletId: account.hdWalletId,
      accountIndex: account.accountIndex,
      derivationPath: account.derivationPath
    };
  }

  const legacy = await findWalletMetadataByPublicKey(db, publicKey);

  if (legacy) {
    return {
      publicKey: legacy.publicKey,
      tenantId: legacy.tenantId ?? null,
      walletType: 'standalone',
      status: 'active',
      effectiveStatus: 'active',
      parentStatus: null,
      network: null,
      hdWalletId: null,
      accountIndex: null,
      derivationPath: null
    };
  }

  return null;
}

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
 * Authoritative, lock-protected key resolution.
 *
 * 1. Opens a dedicated transaction.
 * 2. Locks the child row and parent row `FOR SHARE`.
 * 3. Re-validates child status, parent existence/status and network identity
 *    from the locked rows (never from a cache or an earlier read).
 * 4. Decrypts the mnemonic, derives the child seed and builds the keypair.
 * 5. COMMITs immediately — before any RPC/broadcast work.
 *
 * A concurrent `UPDATE hd_wallets SET status=...` either completes before the
 * locks are taken (and is observed) or waits until the transaction ends.
 */
export async function loadSigningKeypairLocked(
  db,
  { publicKey, deploymentNetwork },
  { cipher = getDefaultCipher() } = {}
) {
  const account = await findAccountByPublicKey(db, publicKey);

  if (!account) {
    return { kind: 'standalone' };
  }

  const client = await db.connect();

  try {
    await client.query(`SET LOCAL lock_timeout = '${KEY_LOCK_TIMEOUT_MS}'`);
    await client.query('BEGIN');

    const { accountRow, parentRow } = await lockRowsForSigning(client, {
      accountId: account.id,
      hdWalletId: account.hdWalletId
    });

    const lockedChild = {
      id: accountRow?.id,
      status: accountRow?.status,
      publicKey: accountRow?.public_key,
      accountIndex: Number(accountRow?.account_index),
      derivationPath: accountRow?.derivation_path,
      network: accountRow?.network
    };

    const lockedParent = parentRow
      ? {
        id: String(parentRow.id),
        status: parentRow.status,
        network: parentRow.network
      }
      : null;

    assertChildAllowsSigning(lockedChild);
    assertParentAllowsSigning(lockedParent);

    if (lockedChild.network !== lockedParent.network) {
      throw new AppError(
        'Child wallet network does not match its parent HD wallet',
        409,
        'NETWORK_MISMATCH'
      );
    }

    assertSigningNetwork(lockedChild.network, deploymentNetwork);

    if (lockedChild.publicKey !== publicKey) {
      throw keyIntegrityError();
    }

    const mnemonic = cipher.decrypt(
      pick(parentRow, 'mnemonic_encrypted'),
      pick(parentRow, 'mnemonic_iv'),
      pick(parentRow, 'mnemonic_auth_tag'),
      {
        aad: mnemonicAad(lockedParent.id),
        keyVersion: parentRow.encryption_key_version
      }
    );

    let seed;

    try {
      seed = mnemonicToHdSeed(mnemonic);
    } catch {
      throw keyIntegrityError();
    }

    let derived;

    try {
      derived = deriveSolanaAccountFromSeedBuffer(seed, lockedChild.accountIndex);
    } catch {
      throw keyIntegrityError();
    } finally {
      seed.fill(0);
    }

    if (derived.publicKey !== lockedChild.publicKey) {
      derived.secretKey.fill(0);
      throw keyIntegrityError();
    }

    await client.query('COMMIT');

    return {
      kind: 'hd_child',
      keypair: derived.keypair,
      wallet: {
        publicKey: lockedChild.publicKey,
        walletType: 'hd_child',
        status: lockedChild.status,
        parentStatus: lockedParent.status,
        network: lockedChild.network,
        hdWalletId: lockedParent.id,
        accountIndex: lockedChild.accountIndex,
        derivationPath: lockedChild.derivationPath
      }
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => { });
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Complete the standalone branch + orchestrate both wallet kinds.
 *
 * Kept as the single public entry point used by services and tests.
 */
export async function resolveSigningKeypair(db, publicKey, { cipher, deploymentNetwork } = {}) {
  const resolved = await loadSigningKeypairLocked(
    db,
    { publicKey, deploymentNetwork },
    { cipher }
  );

  if (resolved.kind !== 'standalone') {
    return { keypair: resolved.keypair, wallet: resolved.wallet };
  }

  const legacyWallet = await findLegacyWalletByPublicKey(publicKey);

  if (!legacyWallet) {
    throw notFound('Sender wallet was not found in the wallet database', 'WALLET_NOT_FOUND');
  }

  const keypair = decryptLegacyPrivateKey(legacyWallet);

  if (keypair.publicKey.toBase58() !== publicKey) {
    throw keyIntegrityError();
  }

  return {
    keypair,
    wallet: {
      publicKey: legacyWallet.publicKey,
      walletType: 'standalone',
      status: 'active',
      parentStatus: null,
      network: null,
      hdWalletId: null,
      accountIndex: null,
      derivationPath: null
    }
  };
}

function pick(row, column) {
  return row?.[column];
}

/**
 * Best-effort zeroization of a signing keypair.
 *
 * web3.js `keypair.secretKey` returns a *copy*, so `keypair.secretKey.fill(0)`
 * erases nothing. The real 64-byte secret lives in `keypair._keypair`; it is
 * overwritten in place together with every copy we created.
 *
 * Node.js cannot guarantee the GC never copies these buffers: this is
 * best-effort hardening, not a hardware guarantee.
 */
export function zeroizeKeypair(keypair) {
  if (!keypair || typeof keypair !== 'object') return;

  const candidates = [];
  const internal = keypair._keypair;

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
 * Run `callback` with the signing keypair for `publicKey`.
 *
 * The keypair is only valid inside the callback; it is zeroized afterwards on
 * a best-effort basis. Exceptions from the callback propagate unchanged after
 * zeroization.
 *
 * @param {object} db
 * @param {string} publicKey
 * @param {(ctx: { keypair: Keypair, wallet: object }) => Promise<T>} callback
 * @param {{ cipher?: object, deploymentNetwork?: string }} [options]
 */
export async function withSigningKey(db, publicKey, callback, { cipher, deploymentNetwork } = {}) {
  if (typeof callback !== 'function') {
    throw new TypeError('A signing callback is required');
  }

  const { keypair, wallet } = await resolveSigningKeypair(db, publicKey, {
    cipher,
    deploymentNetwork
  });

  try {
    return await callback({ keypair, wallet });
  } finally {
    zeroizeKeypair(keypair);
  }
}
