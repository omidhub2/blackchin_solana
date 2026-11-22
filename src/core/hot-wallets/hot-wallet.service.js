/**
 * Hot-wallet lifecycle and signing guard.
 *
 * A hot wallet is not "a child wallet with a label": it is an explicit,
 * tenant-scoped operational designation with its own freeze state, signing
 * switch and single-transfer ceiling. The signing key remains inside the
 * existing encrypted HD root and is resolved through the tenant signer.
 */
import { conflict, notFound } from '../errors.js';
import {
  findHotWalletByPublicKeyForTenant,
  insertHotWallet,
  listHotWalletsForTenant,
  resolveHotWalletCandidate,
  updateHotWalletStatus
} from '../../infrastructure/database/hot-wallet.repository.js';

const STATUSES = new Set(['active', 'frozen', 'disabled']);

function assertTenantId(value) {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(value))) {
    throw new TypeError('tenantId must be a positive integer');
  }
  return String(value);
}

function parseLamports(value, field) {
  if (value === undefined || value === null) return '0';
  const text = String(value);
  if (!/^\d+$/.test(text)) {
    throw conflict(`${field} must be a non-negative integer string`, 'INVALID_AMOUNT');
  }
  return text;
}

export function createHotWalletService({ db, network, log = () => {} }) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required');
  }
  if (typeof network !== 'string' || !network.trim()) {
    throw new TypeError('A Solana network is required');
  }

  return Object.freeze({
    async register({ tenantId, publicKey, label = null, maxSingleLamports = '0', createdBy = null } = {}) {
      tenantId = assertTenantId(tenantId);
      const ceiling = parseLamports(maxSingleLamports, 'maxSingleLamports');

      const candidate = await resolveHotWalletCandidate(db, tenantId, publicKey);
      if (!candidate) {
        throw notFound('HD child wallet was not found for this tenant', 'WALLET_ACCOUNT_NOT_FOUND');
      }
      if (candidate.accountStatus !== 'active' || candidate.parentStatus !== 'active') {
        throw conflict('Only an active HD child with an active parent can become a hot wallet', 'WALLET_NOT_ACTIVE');
      }
      if (candidate.network !== network || candidate.parentNetwork !== network) {
        throw conflict('Wallet network does not match the configured Solana network', 'NETWORK_MISMATCH');
      }

      const existing = await findHotWalletByPublicKeyForTenant(db, tenantId, publicKey);
      if (existing) {
        throw conflict('This wallet is already registered as a hot wallet', 'HOT_WALLET_EXISTS');
      }

      const wallet = await insertHotWallet(db, {
        tenantId,
        hdWalletId: candidate.hdWalletId,
        walletAccountId: candidate.accountId,
        publicKey: candidate.publicKey,
        network: candidate.network,
        label,
        maxSingleLamports: ceiling,
        createdBy
      });

      log('hot_wallet.registered', { tenantId, publicKey });
      return wallet;
    },

    async list(tenantId, { limit = 100, offset = 0 } = {}) {
      tenantId = assertTenantId(tenantId);
      return listHotWalletsForTenant(db, tenantId, { limit, offset });
    },

    async get(tenantId, publicKey) {
      tenantId = assertTenantId(tenantId);
      const wallet = await findHotWalletByPublicKeyForTenant(db, tenantId, publicKey);
      if (!wallet) throw notFound('Hot wallet was not found', 'HOT_WALLET_NOT_FOUND');
      return wallet;
    },

    async freeze(tenantId, publicKey, reason) {
      tenantId = assertTenantId(tenantId);
      if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
        throw conflict('A freeze reason of 1 to 500 characters is required', 'FREEZE_REASON_REQUIRED');
      }
      const updated = await updateHotWalletStatus(db, tenantId, publicKey, {
        status: 'frozen',
        signingEnabled: false,
        freezeReason: reason.trim()
      });
      if (!updated) throw notFound('Hot wallet was not found', 'HOT_WALLET_NOT_FOUND');
      log('hot_wallet.frozen', { tenantId, publicKey });
      return updated;
    },

    async unfreeze(tenantId, publicKey) {
      tenantId = assertTenantId(tenantId);
      const updated = await updateHotWalletStatus(db, tenantId, publicKey, {
        status: 'active',
        signingEnabled: true,
        freezeReason: null
      });
      if (!updated) throw notFound('Hot wallet was not found', 'HOT_WALLET_NOT_FOUND');
      log('hot_wallet.unfrozen', { tenantId, publicKey });
      return updated;
    },

    async setStatus(tenantId, publicKey, status) {
      tenantId = assertTenantId(tenantId);
      if (!STATUSES.has(status)) {
        throw conflict('status must be active, frozen or disabled', 'INVALID_STATUS');
      }
      if (status === 'frozen') {
        throw conflict('Use the freeze operation so a reason is recorded', 'FREEZE_REASON_REQUIRED');
      }
      const updated = await updateHotWalletStatus(db, tenantId, publicKey, {
        status,
        signingEnabled: status === 'active',
        freezeReason: null
      });
      if (!updated) throw notFound('Hot wallet was not found', 'HOT_WALLET_NOT_FOUND');
      return updated;
    },

    /**
     * Called immediately before a tenant withdrawal is reserved. Non-hot
     * wallets pass through unchanged; a designated hot wallet must be active,
     * signing-enabled and within its single-transfer ceiling.
     */
    async assertCanSpend({ tenantId, publicKey, amountLamports } = {}) {
      tenantId = assertTenantId(tenantId);
      const wallet = await findHotWalletByPublicKeyForTenant(db, tenantId, publicKey);
      if (!wallet) return { hotWallet: false };

      if (wallet.status !== 'active' || wallet.signingEnabled !== true) {
        throw conflict('Hot wallet is not permitted to sign', 'HOT_WALLET_NOT_ACTIVE');
      }

      const amount = BigInt(String(amountLamports));
      const ceiling = BigInt(wallet.maxSingleLamports);

      if (ceiling > 0n && amount > ceiling) {
        throw conflict('Withdrawal exceeds the hot wallet single-transfer limit', 'HOT_WALLET_LIMIT_EXCEEDED');
      }

      return { hotWallet: true, wallet };
    }
  });
}