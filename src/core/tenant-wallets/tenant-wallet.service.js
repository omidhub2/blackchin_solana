/**
 * Tenant-isolated Solana HD wallet operations.
 *
 * Every public method requires tenantId explicitly. This service is separate
 * from the legacy single-credential services until tenant API routing is
 * enabled, and never queries legacy rows with tenant_id IS NULL.
 */
import crypto from 'node:crypto';

import { AppError, conflict, notFound } from '../errors.js';
import {
  createPurposeTokenCodec,
  DEFAULT_RECOVERY_TOKEN_TTL_MS
} from '../../infrastructure/security/purpose-token.js';
import {
  findHdWalletByIdForTenant,
  insertHdWalletForTenant,
  updateHdWalletStatusForTenant,
  storeRecoveryTokenForTenant,
  redeemRecoveryTokenForTenant,
  allocateAccountIndexesForTenant,
  insertWalletAccountsForTenant,
  findAccountByIdForTenant,
  findAccountByPublicKeyForTenant,
  findAccountAtIndexForTenant,
  findAccountByPathForTenant,
  listAccountsByHdWalletForTenant,
  countAccountsByHdWalletForTenant,
  updateAccountStatusForTenant
} from '../../infrastructure/database/tenant-wallet.repository.js';
import { toHdWalletMetadata } from '../../infrastructure/database/hd-wallet.repository.js';
import {
  deriveSolanaAccount,
  DERIVATION_PATH_TEMPLATE,
  DERIVATION_SCHEME,
  generateHdMnemonic,
  validateAccountIndex
} from '../../blockchain/solana/hd/derivation.js';
import { ACCOUNT_STATUSES } from '../../infrastructure/database/wallet-account.repository.js';
import { emitEvent } from '../../infrastructure/database/webhook-outbox.repository.js';
import { recordOperationalEventSafe } from '../../infrastructure/database/operational-event.repository.js';
import { zeroizeKeypair } from '../../infrastructure/security/wallet-signer.js';

const HD_WALLET_STATUSES = Object.freeze(['active', 'provisioning', 'disabled', 'archived']);
const MAX_BATCH_SIZE = 50;
const DEFAULT_LIST_LIMIT = 100;
const MAX_LIST_LIMIT = 500;

function assertTenantContext(tenantId) {
  if (
    (typeof tenantId !== 'string' && typeof tenantId !== 'number' && typeof tenantId !== 'bigint') ||
    !/^[1-9][0-9]*$/.test(String(tenantId))
  ) {
    throw new TypeError('tenantId must be a positive integer');
  }
  return String(tenantId);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function mapUniqueViolation(error) {
  if (error?.code === '23505') {
    if (String(error.constraint).includes('public_key')) {
      return conflict('A wallet with this public key already exists', 'DUPLICATE_PUBLIC_KEY');
    }
    return conflict('Derivation index or path is already allocated for this HD wallet', 'DUPLICATE_ACCOUNT_INDEX');
  }
  return error;
}

export function createTenantWalletService({
  db, cipher, keyProvider, network, now = () => new Date(), log = () => {}
}) {
  if (!db || typeof db.connect !== 'function') throw new TypeError('A database pool is required');
  if (!cipher || typeof cipher.encrypt !== 'function' || typeof cipher.decrypt !== 'function') {
    throw new TypeError('A wallet encryption cipher is required');
  }
  if (!keyProvider || typeof keyProvider.keyFor !== 'function') {
    throw new TypeError('An encryption key provider is required');
  }
  if (typeof network !== 'string' || !network.trim()) throw new TypeError('A Solana network is required');

  const tokenCodec = createPurposeTokenCodec(keyProvider, { now: () => now().getTime() });

  function decryptMnemonic(hdWallet) {
    return cipher.decrypt(
      hdWallet.mnemonicEncrypted,
      hdWallet.mnemonicIv,
      hdWallet.mnemonicAuthTag,
      {
        aad: `hd_wallets:${hdWallet.id}:mnemonic:v1`,
        keyVersion: hdWallet.encryptionKeyVersion
      }
    );
  }

  async function requireHdWallet(tenantId, hdWalletId) {
    const wallet = await findHdWalletByIdForTenant(db, tenantId, hdWalletId);
    if (!wallet) throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
    return wallet;
  }

  async function sealMnemonic(client, tenantId, hdWalletId, mnemonic) {
    const sealed = cipher.encrypt(mnemonic, {
      aad: `hd_wallets:${hdWalletId}:mnemonic:v1`,
      keyVersion: cipher.currentVersion
    });
    const result = await client.query(
      `UPDATE hd_wallets
       SET mnemonic_encrypted = $3, mnemonic_iv = $4, mnemonic_auth_tag = $5,
           encryption_key_version = $6, status = 'active', updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [String(tenantId), hdWalletId, sealed.ciphertext, sealed.iv, sealed.authTag, cipher.currentVersion]
    );
    if (result.rowCount !== 1) {
      throw new AppError('Tenant HD wallet could not be sealed', 500, 'HD_WALLET_SEAL_FAILED');
    }
  }

  return Object.freeze({
    async createHdWallet({ tenantId, label = null, ownerId = null } = {}) {
      tenantId = assertTenantContext(tenantId);
      const mnemonic = generateHdMnemonic(256);
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const created = await insertHdWalletForTenant(client, tenantId, {
          ownerId, label, network, derivationScheme: DERIVATION_SCHEME,
          derivationPathTemplate: DERIVATION_PATH_TEMPLATE,
          mnemonicEncrypted: 'pending', mnemonicIv: 'pending',
          mnemonicAuthTag: 'pending', encryptionKeyVersion: cipher.currentVersion,
          status: 'provisioning'
        });
        if (!created) throw new AppError('Tenant HD wallet creation failed', 500, 'HD_WALLET_CREATE_FAILED');

        await sealMnemonic(client, tenantId, created.id, mnemonic);
        const sealedToken = tokenCodec.seal('recovery-phrase', mnemonic, {
          walletId: created.id, ttlMs: DEFAULT_RECOVERY_TOKEN_TTL_MS
        });
        const persisted = await storeRecoveryTokenForTenant(client, tenantId, created.id, {
          tokenHash: sealedToken.tokenHash,
          expiresAt: new Date(sealedToken.expiresAt)
        });
        if (persisted !== 1) {
          throw new AppError('Recovery token could not be persisted', 500, 'RECOVERY_TOKEN_PERSISTENCE_FAILED');
        }
        await emitEvent(client, {
          eventType: 'wallet.created',
          tenantId,
          network,
          hdWalletId: created.id,
          payload: {
            walletId: String(created.id),
            label,
            network,
            status: 'active'
          }
        });
        await client.query('COMMIT');
        const stored = await requireHdWallet(tenantId, created.id);
        await recordOperationalEventSafe(db, {
          eventType: 'wallet.created',
          tenantId,
          network,
          hdWalletId: created.id,
          payload: { walletId: String(created.id), label, network }
        }, log);
        return {
          wallet: toHdWalletMetadata(stored),
          recovery: {
            token: sealedToken.token,
            tokenId: sealedToken.jti,
            wordCount: mnemonic.split(' ').length,
            issuedAt: sealedToken.issuedAt,
            expiresAt: sealedToken.expiresAt,
            warning: 'This token can open the HD root mnemonic once, before it expires. Store the phrase offline in a safe place, then discard the token. The phrase is never returned again.'
          }
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getHdWallet(tenantId, hdWalletId) {
      return toHdWalletMetadata(await requireHdWallet(tenantId, hdWalletId));
    },

    async revealMnemonicForSigning(tenantId, hdWalletId) {
      const wallet = await requireHdWallet(tenantId, hdWalletId);
      if (wallet.status === 'archived') {
        throw conflict('HD wallet is archived and cannot be used', 'HD_WALLET_ARCHIVED');
      }
      return decryptMnemonic(wallet);
    },

    async consumeRecoveryPhrase({ tenantId, hdWalletId, token, confirm } = {}) {
      const wallet = await requireHdWallet(tenantId, hdWalletId);
      if (confirm !== true) {
        throw conflict('Explicit confirmation is required to reveal the recovery phrase', 'CONFIRMATION_REQUIRED');
      }
      if (wallet.phraseProvisionedAt !== null) {
        throw conflict('The recovery phrase for this HD wallet has already been provisioned', 'RECOVERY_PHRASE_ALREADY_PROVISIONED');
      }
      const opened = tokenCodec.open('recovery-phrase', token, { walletId: hdWalletId });
      const redemption = await redeemRecoveryTokenForTenant(db, tenantId, hdWalletId, sha256Hex(token));
      if (!redemption.redeemed) {
        throw conflict('Recovery token is invalid, expired, or already used', 'INVALID_RECOVERY_TOKEN');
      }
      return {
        hdWalletId: wallet.id,
        tokenId: opened.jti,
        mnemonic: opened.payload,
        wordCount: opened.payload.split(' ').length,
        warning: 'Write this phrase down offline and never share it. It controls every child wallet of this HD root.'
      };
    },

    async updateStatus(tenantId, hdWalletId, status) {
      if (!HD_WALLET_STATUSES.includes(status)) throw conflict('Invalid HD wallet status', 'INVALID_STATUS');
      const updated = await updateHdWalletStatusForTenant(db, tenantId, hdWalletId, status);
      if (!updated) throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
      return toHdWalletMetadata(updated);
    },

    async deriveAccountPreview(tenantId, hdWalletId, accountIndex) {
      validateAccountIndex(accountIndex);
      const wallet = await requireHdWallet(tenantId, hdWalletId);
      if (wallet.status === 'archived') {
        throw conflict('HD wallet is archived and cannot be used', 'HD_WALLET_ARCHIVED');
      }
      let mnemonic = decryptMnemonic(wallet);
      let derived;
      try {
        derived = deriveSolanaAccount(mnemonic, accountIndex);
        return {
          hdWalletId: String(hdWalletId),
          accountIndex,
          derivationPath: derived.derivationPath,
          publicKey: derived.publicKey
        };
      } finally {
        mnemonic = '';
        derived?.secretKey?.fill(0);
        zeroizeKeypair(derived?.keypair);
      }
    },

    async createAccounts(tenantId, hdWalletId, { count = 1 } = {}) {
      tenantId = assertTenantContext(tenantId);
      if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BATCH_SIZE) {
        throw conflict(`count must be an integer between 1 and ${MAX_BATCH_SIZE}`, 'INVALID_BATCH_SIZE');
      }
      const client = await db.connect();
      let mnemonic = '';
      const derived = [];
      try {
        await client.query('BEGIN');
        const allocation = await allocateAccountIndexesForTenant(client, tenantId, hdWalletId, count);
        if (!allocation) throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
        const { hdWallet, indexes } = allocation;
        if (hdWallet.status !== 'active') {
          throw conflict(`HD wallet is ${hdWallet.status} and cannot create new accounts`, 'HD_WALLET_NOT_ACTIVE');
        }
        mnemonic = decryptMnemonic(hdWallet);
        for (const accountIndex of indexes) {
          derived.push(deriveSolanaAccount(mnemonic, accountIndex));
        }
        const accounts = await insertWalletAccountsForTenant(client, tenantId, derived.map((account) => ({
          hdWalletId,
          publicKey: account.publicKey,
          accountIndex: account.accountIndex,
          derivationPath: account.derivationPath,
          network: hdWallet.network,
          scheme: hdWallet.derivationScheme
        })));
        for (const account of accounts) {
          await emitEvent(client, {
            eventType: 'wallet.child.created',
            tenantId,
            network: hdWallet.network,
            walletPublicKey: account.publicKey,
            hdWalletId,
            payload: {
              accountId: account.id,
              hdWalletId: String(hdWalletId),
              publicKey: account.publicKey,
              accountIndex: account.accountIndex,
              derivationPath: account.derivationPath,
              network: hdWallet.network
            }
          });
        }
        await client.query('COMMIT');
        for (const account of accounts) {
          await recordOperationalEventSafe(db, {
            eventType: 'wallet.child.created',
            tenantId,
            network: hdWallet.network,
            walletPublicKey: account.publicKey,
            hdWalletId,
            payload: {
              accountId: account.id,
              accountIndex: account.accountIndex,
              publicKey: account.publicKey
            }
          }, log);
        }
        return { hdWalletId: String(hdWalletId), accounts, nextAccountIndex: hdWallet.nextAccountIndex };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw mapUniqueViolation(error);
      } finally {
        mnemonic = '';
        for (const account of derived) {
          account.secretKey?.fill(0);
          zeroizeKeypair(account.keypair);
        }
        client.release();
      }
    },

    async getAccountById(tenantId, accountId) {
      const account = await findAccountByIdForTenant(db, tenantId, accountId);
      if (!account) throw notFound('Wallet account was not found', 'WALLET_ACCOUNT_NOT_FOUND');
      return account;
    },

    async getAccountByPublicKey(tenantId, publicKey) {
      return findAccountByPublicKeyForTenant(db, tenantId, publicKey);
    },

    async getAccountAtIndex(tenantId, hdWalletId, accountIndex) {
      validateAccountIndex(accountIndex);
      const account = await findAccountAtIndexForTenant(db, tenantId, hdWalletId, accountIndex);
      if (!account) throw notFound('Wallet account was not found for this derivation index', 'WALLET_ACCOUNT_NOT_FOUND');
      return account;
    },

    async getAccountByPath(tenantId, hdWalletId, derivationPath) {
      const account = await findAccountByPathForTenant(db, tenantId, hdWalletId, derivationPath);
      if (!account) throw notFound('Wallet account was not found for this derivation path', 'WALLET_ACCOUNT_NOT_FOUND');
      return account;
    },

    async listAccounts(tenantId, hdWalletId, { limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
      await requireHdWallet(tenantId, hdWalletId);
      const normalizedLimit = Math.min(Math.max(Number.isSafeInteger(limit) ? limit : DEFAULT_LIST_LIMIT, 1), MAX_LIST_LIMIT);
      const normalizedOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;
      const [items, total] = await Promise.all([
        listAccountsByHdWalletForTenant(db, tenantId, hdWalletId, { limit: normalizedLimit, offset: normalizedOffset }),
        countAccountsByHdWalletForTenant(db, tenantId, hdWalletId)
      ]);
      return { hdWalletId: String(hdWalletId), total, limit: normalizedLimit, offset: normalizedOffset, items };
    },

    async setAccountStatus(tenantId, publicKey, status) {
      if (!ACCOUNT_STATUSES.includes(status)) throw conflict('Invalid wallet account status', 'INVALID_ACCOUNT_STATUS');
      const updated = await updateAccountStatusForTenant(db, tenantId, publicKey, status);
      if (!updated) throw notFound('Wallet account was not found', 'WALLET_ACCOUNT_NOT_FOUND');
      await recordOperationalEventSafe(db, {
        eventType: 'wallet.status_changed',
        tenantId,
        network: updated.network,
        hdWalletId: updated.hdWalletId,
        payload: { walletId: String(updated.hdWalletId), status }
      }, log);
      return updated;
    },

    async isIndexAllocated(tenantId, hdWalletId, accountIndex) {
      validateAccountIndex(accountIndex);
      const account = await findAccountAtIndexForTenant(db, tenantId, hdWalletId, accountIndex);
      return {
        hdWalletId: String(hdWalletId), accountIndex,
        allocated: account !== null, publicKey: account?.publicKey ?? null
      };
    },

    async nextIndexPreview(tenantId, hdWalletId) {
      const wallet = await requireHdWallet(tenantId, hdWalletId);
      return { hdWalletId: String(hdWalletId), nextAccountIndex: wallet.nextAccountIndex };
    }
  });
}
