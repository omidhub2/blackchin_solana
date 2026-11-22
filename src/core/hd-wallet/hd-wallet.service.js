/**
 * HD root (master wallet) service.
 *
 * The HD root is a logical grouping, not an on-chain account: its balance is
 * the sum of its child accounts (see balance.service.js).
 */
import { conflict, notFound } from '../errors.js';
import { createPurposeTokenCodec } from '../../infrastructure/security/purpose-token.js';
import {
  insertHdWallet,
  findHdWalletById,
  markPhraseProvisioned,
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

const RECOVERY_TOKEN_TTL_MS = 60 * 60 * 1000;

function mnemonicAad(hdWalletId) {
  return `hd_wallets:${hdWalletId}:mnemonic:v1`;
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
  const tokenCodec = createPurposeTokenCodec(keyProvider);

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
     * Returns public metadata plus a one-time recovery token. The token is an
     * AEAD-sealed copy of the phrase using a purpose-derived sub-key; it is
     * never persisted and can be redeemed once through
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
        await client.query('COMMIT');

        const stored = await findHdWalletById(db, created.id);

        return {
          wallet: toHdWalletMetadata(stored),
          recovery: {
            token: tokenCodec.seal('recovery-phrase', mnemonic),
            wordCount: mnemonic.split(' ').length,
            expiresAt: new Date(now().getTime() + RECOVERY_TOKEN_TTL_MS).toISOString(),
            warning:
              'This token can open the HD root mnemonic once. Store the phrase offline in a safe place, then discard the token. The phrase is never returned again.'
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

      const mnemonic = tokenCodec.open('recovery-phrase', token);
      const marked = await markPhraseProvisioned(db, hdWalletId);

      if (!marked) {
        throw conflict(
          'The recovery phrase for this HD wallet has already been provisioned',
          'RECOVERY_PHRASE_ALREADY_PROVISIONED'
        );
      }

      return {
        hdWalletId: hdWallet.id,
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
