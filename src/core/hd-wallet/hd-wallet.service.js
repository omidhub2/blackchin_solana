/**
 * HD root (master wallet) service.
 *
 * The HD root is a logical grouping, not an on-chain account: its balance is
 * the sum of its child accounts (see balance.service.js).
 */
import crypto from 'node:crypto';

import { AppError, conflict, notFound } from '../errors.js';
import {
  createPurposeTokenCodec,
  DEFAULT_RECOVERY_TOKEN_TTL_MS
} from '../../infrastructure/security/purpose-token.js';
import {
  insertHdWallet,
  findHdWalletById,
  redeemRecoveryToken,
  storeRecoveryToken,
  toHdWalletMetadata,
  updateHdWalletStatus
} from '../../infrastructure/database/hd-wallet.repository.js';
import {
  deriveSolanaAccount,
  DERIVATION_PATH_TEMPLATE,
  DERIVATION_SCHEME,
  generateHdMnemonic
} from '../../blockchain/solana/hd/derivation.js';

export const HD_WALLET_STATUSES = Object.freeze(['active', 'provisioning', 'disabled', 'archived']);

const RECOVERY_TOKEN_TTL_MS = DEFAULT_RECOVERY_TOKEN_TTL_MS;

function mnemonicAad(hdWalletId) {
  return `hd_wallets:${hdWalletId}:mnemonic:v1`;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * @param {{ db: object, cipher: object, keyProvider: object, network: string,
 *           now?: () => Date }} deps
 */
export function createHdWalletService({
  db,
  cipher,
  keyProvider,
  network,
  now = () => new Date()
}) {
  const tokenCodec = createPurposeTokenCodec(keyProvider, {
    now: () => now().getTime()
  });

  /**
   * Encrypt the mnemonic bound to the row id (used as AAD) and store it.
   * Runs inside the caller's transaction so a partial root can never exist.
   */
  async function sealMnemonic(client, hdWalletId, mnemonic) {
    const sealed = cipher.encrypt(mnemonic, {
      aad: mnemonicAad(hdWalletId),
      keyVersion: cipher.currentVersion
    });

    await client.query(
      `
        UPDATE hd_wallets
        SET mnemonic_encrypted = $2,
            mnemonic_iv = $3,
            mnemonic_auth_tag = $4,
            encryption_key_version = $5,
            status = 'active',
            updated_at = NOW()
        WHERE id = $1
      `,
      [hdWalletId, sealed.ciphertext, sealed.iv, sealed.authTag, cipher.currentVersion]
    );
  }

  async function requireHdWallet(hdWalletId) {
    const hdWallet = await findHdWalletById(db, hdWalletId);

    if (!hdWallet) {
      throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
    }

    return hdWallet;
  }

  return Object.freeze({
    /**
     * Create a new HD root with a fresh 24-word BIP39 mnemonic.
     *
     * Returns public metadata plus a one-time recovery token. The plaintext
     * token is never persisted: only its SHA-256 hash and server-side expiry
     * are written, in the same transaction as the root. Both are cleared when
     * the phrase is provisioned. The token can be redeemed once through
     * `consumeRecoveryPhrase()`.
     *
     * @param {{ label?: string|null, ownerId?: string|null }} [input]
     */
    async createHdWallet({ label = null, ownerId = null } = {}) {
      const mnemonic = generateHdMnemonic(256);
      const client = await db.connect();

      try {
        await client.query('BEGIN');

        const created = await insertHdWallet(client, {
          ownerId,
          label,
          network,
          derivationScheme: DERIVATION_SCHEME,
          derivationPathTemplate: DERIVATION_PATH_TEMPLATE,
          // Placeholders (NOT NULL) are replaced by the encrypted mnemonic in
          // the same transaction before COMMIT; no plaintext is written.
          mnemonicEncrypted: 'pending',
          mnemonicIv: 'pending',
          mnemonicAuthTag: 'pending',
          encryptionKeyVersion: cipher.currentVersion,
          status: 'provisioning'
        });

        await sealMnemonic(client, created.id, mnemonic);

        // The token is bound to this root id and expires server-side. Only its
        // SHA-256 hash and expiry are persisted, inside the same transaction.
        const sealedToken = tokenCodec.seal('recovery-phrase', mnemonic, {
          walletId: created.id,
          ttlMs: RECOVERY_TOKEN_TTL_MS
        });

        const persisted = await storeRecoveryToken(client, created.id, {
          tokenHash: sealedToken.tokenHash,
          expiresAt: new Date(sealedToken.expiresAt)
        });

        // Fail closed: a token may only leave the process once it can actually
        // be redeemed. Anything other than exactly one persisted row means the
        // binding was not stored, so the transaction is rolled back below and
        // the token is never returned.
        if (persisted !== 1) {
          throw new AppError(
            'Recovery token could not be persisted',
            500,
            'RECOVERY_TOKEN_PERSISTENCE_FAILED'
          );
        }

        await client.query('COMMIT');

        const stored = await findHdWalletById(db, created.id);

        return {
          wallet: toHdWalletMetadata(stored),
          recovery: {
            token: sealedToken.token,
            tokenId: sealedToken.jti,
            wordCount: mnemonic.split(' ').length,
            issuedAt: sealedToken.issuedAt,
            expiresAt: sealedToken.expiresAt,
            warning:
              'This token can open the HD root mnemonic once, before it expires. Store the phrase offline in a safe place, then discard the token. The phrase is never returned again.'
          }
        };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async getHdWallet(hdWalletId) {
      return toHdWalletMetadata(await requireHdWallet(hdWalletId));
    },

    /**
     * Decrypt the BIP39 mnemonic for internal signing/recovery only.
     * Never serialize the result to an API response.
     */
    async revealMnemonicForSigning(hdWalletId) {
      const hdWallet = await requireHdWallet(hdWalletId);

      if (hdWallet.status === 'archived') {
        throw conflict('HD wallet is archived and cannot be used', 'HD_WALLET_ARCHIVED');
      }

      return cipher.decrypt(
        hdWallet.mnemonicEncrypted,
        hdWallet.mnemonicIv,
        hdWallet.mnemonicAuthTag,
        {
          aad: mnemonicAad(hdWallet.id),
          keyVersion: hdWallet.encryptionKeyVersion
        }
      );
    },

    /**
     * Redeem the one-time token for the recovery phrase.
     * Succeeds exactly once per HD root, then the token is dead for good.
     */
    async consumeRecoveryPhrase({ hdWalletId, token, confirm }) {
      const hdWallet = await requireHdWallet(hdWalletId);

      if (confirm !== true) {
        throw conflict(
          'Explicit confirmation is required to reveal the recovery phrase',
          'CONFIRMATION_REQUIRED'
        );
      }

      if (hdWallet.phraseProvisionedAt !== null) {
        throw conflict(
          'The recovery phrase for this HD wallet has already been provisioned',
          'RECOVERY_PHRASE_ALREADY_PROVISIONED'
        );
      }

      // Verifies purpose, wallet binding, server-side expiry and AEAD tag.
      const opened = tokenCodec.open('recovery-phrase', token, {
        walletId: hdWalletId
      });

      const tokenHash = sha256Hex(token);

      // Authoritative one-time check: a single conditional UPDATE. Losing
      // racers get `redeemed: false` and never receive the phrase.
      const redemption = await redeemRecoveryToken(db, hdWalletId, tokenHash);

      if (!redemption.redeemed) {
        throw conflict(
          'Recovery token is invalid, expired, or already used',
          'INVALID_RECOVERY_TOKEN'
        );
      }

      const mnemonic = opened.payload;

      return {
        hdWalletId: hdWallet.id,
        tokenId: opened.jti,
        mnemonic,
        wordCount: mnemonic.split(' ').length,
        warning:
          'Write this phrase down offline and never share it. It controls every child wallet of this HD root.'
      };
    },

    async updateStatus(hdWalletId, status) {
      if (!HD_WALLET_STATUSES.includes(status)) {
        throw conflict('Invalid HD wallet status', 'INVALID_STATUS');
      }

      const updated = await updateHdWalletStatus(db, hdWalletId, status);

      if (!updated) {
        throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
      }

      return toHdWalletMetadata(updated);
    },

    /**
     * Deterministic recovery check: which public key would account N have?
     * Derived from the stored mnemonic, so it also proves the root material is
     * still decryptable.
     */
    async deriveAccountPreview(hdWalletId, accountIndex) {
      const mnemonic = await this.revealMnemonicForSigning(hdWalletId);
      const derived = deriveSolanaAccount(mnemonic, accountIndex);

      derived.secretKey.fill(0);
      derived.keypair.secretKey.fill(0);

      return {
        hdWalletId: String(hdWalletId),
        accountIndex,
        derivationPath: derived.derivationPath,
        publicKey: derived.publicKey
      };
    }
  });
}
