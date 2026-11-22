/**
 * Purpose-bound AEAD for tokens that leave the service (recovery phrases).
 *
 * The HD root mnemonic is additionally encrypted with a sub-key derived from
 * the master encryption key and a domain separator. A token produced here can
 * therefore never be decrypted as a stored root mnemonic (and vice versa),
 * which prevents "ciphertext confusion" between the two purposes.
 */
import crypto from 'node:crypto';

import { conflict } from '../../core/errors.js';
import { ENCRYPTION_ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH } from './hd-envelope.js';

const TOKEN_PURPOSES = new Set(['recovery-phrase', 'root-mnemonic']);

export function derivePurposeKey(keyProvider, purpose) {
  if (!TOKEN_PURPOSES.has(purpose)) {
    throw new TypeError('Unsupported encryption purpose');
  }

  const master = keyProvider.keyFor(keyProvider.currentVersion);

  return Buffer.from(
    crypto
      .createHmac('sha256', master)
      .update(`blackchin:${purpose}:v1`, 'utf8')
      .digest()
  );
}

function assertTokenFormat(token) {
  if (typeof token !== 'string') {
    throw new TypeError('Token must be a base64url string');
  }

  const raw = Buffer.from(token, 'base64url');

  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new TypeError('Token is too short');
  }

  return raw;
}

/**
 * @param {object} keyProvider from createEnvKeyProvider()
 */
export function createPurposeTokenCodec(keyProvider) {
  function keyFor(purpose) {
    return derivePurposeKey(keyProvider, purpose);
  }

  return Object.freeze({
    /**
     * Seal plaintext into a self-contained base64url token.
     */
    seal(purpose, plaintext) {
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new TypeError('Token payload must be a non-empty string');
      }

      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyFor(purpose), iv);
      cipher.setAAD(Buffer.from(`blackchin:${purpose}:v1`, 'utf8'));

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);

      return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url');
    },

    /**
     * Open a token. Always throws a generic conflict on any failure.
     */
    open(purpose, token) {
      try {
        const raw = assertTokenFormat(token);
        const iv = raw.subarray(0, IV_LENGTH);
        const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
        const ciphertext = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, keyFor(purpose), iv);
        decipher.setAAD(Buffer.from(`blackchin:${purpose}:v1`, 'utf8'));
        decipher.setAuthTag(authTag);

        const plaintext = Buffer.concat([
          decipher.update(ciphertext),
          decipher.final()
        ]);

        return plaintext.toString('utf8');
      } catch {
        throw conflict(
          'Recovery token is invalid, expired, or already used',
          'INVALID_RECOVERY_TOKEN'
        );
      }
    }
  });
}
