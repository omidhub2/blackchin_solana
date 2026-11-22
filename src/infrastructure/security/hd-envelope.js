/**
 * AES-256-GCM envelope for HD root material.
 *
 * Format-compatible with the legacy wallet storage: hex ciphertext, hex IV
 * (12 bytes) and hex auth tag (16 bytes), so the same ENCRYPTION_KEY can be
 * reused during migration.
 *
 * Additions over the legacy helper:
 * - optional AAD binding ciphertext to its record/purpose,
 * - a key version so the key can later be rotated,
 * - a pluggable key provider (environment today, KMS/HSM later).
 */
import crypto from 'node:crypto';

export const ENCRYPTION_ALGORITHM = 'aes-256-gcm';
export const ENCRYPTION_KEY_LENGTH = 32;
export const IV_LENGTH = 12;
export const AUTH_TAG_LENGTH = 16;
export const CURRENT_KEY_VERSION = 1;

const HEX_32_BYTES = /^[a-fA-F0-9]{64}$/;
const HEX_CIPHERTEXT = /^(?:[a-fA-F0-9]{2})+$/;
const HEX_IV = /^[a-fA-F0-9]{24}$/;
const HEX_TAG = /^[a-fA-F0-9]{32}$/;

/**
 * Build a key provider from the environment.
 *
 * `ENCRYPTION_KEY` is version 1. `ENCRYPTION_KEY_V{n}` supersedes it for
 * rotation: new writes use the highest configured version, reads use the
 * version stored with the record.
 */
export function createEnvKeyProvider(env = process.env) {
  const keys = new Map();

  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;

    if (name === 'ENCRYPTION_KEY' && HEX_32_BYTES.test(value)) {
      keys.set(1, Buffer.from(value, 'hex'));
      continue;
    }

    const match = name.match(/^ENCRYPTION_KEY_V(\d+)$/);
    if (match && HEX_32_BYTES.test(value)) {
      const version = Number(match[1]);
      if (Number.isSafeInteger(version) && version > 0) {
        keys.set(version, Buffer.from(value, 'hex'));
      }
    }
  }

  if (keys.size === 0) {
    throw new Error(
      'ENCRYPTION_KEY must be configured with exactly 64 hexadecimal characters (or ENCRYPTION_KEY_V<n>)'
    );
  }

  const currentVersion = Math.max(...keys.keys());

  return Object.freeze({
    currentVersion,
    keyFor(version) {
      const key = keys.get(version);

      if (!key) {
        throw new Error(`No encryption key configured for version ${version}`);
      }

      return key;
    }
  });
}

/**
 * Create a stateless cipher facade around a key provider.
 */
export function createCipher(keyProvider) {
  if (!keyProvider || typeof keyProvider.keyFor !== 'function') {
    throw new TypeError('A key provider with keyFor(version) is required');
  }

  function cipherFor(version) {
    const key = keyProvider.keyFor(version);

    if (!Buffer.isBuffer(key) || key.length !== ENCRYPTION_KEY_LENGTH) {
      throw new Error('Encryption key must be 32 bytes');
    }

    return key;
  }

  return Object.freeze({
    currentVersion: keyProvider.currentVersion,

    /**
     * Encrypt a UTF-8 string.
     * @returns {{ ciphertext: string, iv: string, authTag: string, keyVersion: number }}
     */
    encrypt(plaintext, { aad = '', keyVersion = keyProvider.currentVersion } = {}) {
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new TypeError('Encryption input must be a non-empty string');
      }

      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, cipherFor(keyVersion), iv);

      if (aad) {
        cipher.setAAD(Buffer.from(aad, 'utf8'));
      }

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);

      return {
        ciphertext: ciphertext.toString('hex'),
        iv: iv.toString('hex'),
        authTag: cipher.getAuthTag().toString('hex'),
        keyVersion
      };
    },

    /**
     * Decrypt and authenticate stored fields.
     * Throws a generic error: it never contains key material or plaintext.
     */
    decrypt(ciphertext, iv, authTag, { aad = '', keyVersion = CURRENT_KEY_VERSION } = {}) {
      if (typeof ciphertext !== 'string' || !HEX_CIPHERTEXT.test(ciphertext)) {
        throw new Error('Invalid encrypted data format');
      }

      if (typeof iv !== 'string' || !HEX_IV.test(iv)) {
        throw new Error('Invalid encryption IV');
      }

      if (typeof authTag !== 'string' || !HEX_TAG.test(authTag)) {
        throw new Error('Invalid authentication tag');
      }

      try {
        const decipher = crypto.createDecipheriv(
          ENCRYPTION_ALGORITHM,
          cipherFor(keyVersion),
          Buffer.from(iv, 'hex')
        );

        if (aad) {
          decipher.setAAD(Buffer.from(aad, 'utf8'));
        }

        decipher.setAuthTag(Buffer.from(authTag, 'hex'));

        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(ciphertext, 'hex')),
          decipher.final()
        ]);

        return plaintext.toString('utf8');
      } catch (error) {
        throw new Error(
          'Decryption failed: authentication failed or encryption key is incorrect',
          { cause: error }
        );
      }
    }
  });
}

let defaultCipher;

/**
 * Lazily created cipher backed by the process environment.
 */
export function getDefaultCipher() {
  if (!defaultCipher) {
    defaultCipher = createCipher(createEnvKeyProvider());
  }

  return defaultCipher;
}
