/**
 * Versioned AES-256-GCM envelope encryption with a pluggable KEK provider.
 *
 * Each envelope gets a fresh random 256-bit DEK. Only the wrapped DEK is
 * persisted. AAD binds ciphertext to its database identity and purpose.
 * Plaintext and DEK buffers are best-effort zeroized by this module; callers
 * must zeroize plaintext returned by decrypt() after use.
 */
import crypto from 'node:crypto';
import { assertEnvelopeKeyProvider } from './envelope-key-provider.js';

const VERSION = 1;
const ALGORITHM = 'aes-256-gcm';
const DEK_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const MAX_PLAINTEXT_BYTES = 64 * 1024;

function aadBuffer(aad) {
  if (typeof aad !== 'string' || aad.length < 1 || aad.length > 1024) {
    throw new TypeError('Envelope AAD must be a non-empty string of at most 1024 characters');
  }
  return Buffer.from(aad, 'utf8');
}

function assertEnvelope(envelope) {
  if (!envelope || envelope.version !== VERSION || envelope.algorithm !== ALGORITHM ||
      typeof envelope.ciphertext !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(envelope.ciphertext) ||
      typeof envelope.iv !== 'string' || !/^[a-f0-9]{24}$/i.test(envelope.iv) ||
      typeof envelope.authTag !== 'string' || !/^[a-f0-9]{32}$/i.test(envelope.authTag) ||
      typeof envelope.wrappedKey !== 'string' || !envelope.wrappedKey.startsWith('vault:v')) {
    throw new Error('Invalid or unsupported encrypted envelope');
  }
}

export function createEnvelopeCrypto(keyProvider) {
  assertEnvelopeKeyProvider(keyProvider);

  return Object.freeze({
    version: VERSION,
    provider: 'wrapped-dek',

    async encrypt(plaintext, { aad } = {}) {
      if (!(typeof plaintext === 'string' || Buffer.isBuffer(plaintext))) {
        throw new TypeError('Plaintext must be a string or Buffer');
      }
      const input = Buffer.isBuffer(plaintext) ? Buffer.from(plaintext) : Buffer.from(plaintext, 'utf8');
      if (input.length < 1 || input.length > MAX_PLAINTEXT_BYTES) {
        input.fill(0);
        throw new RangeError('Plaintext size is outside the supported range');
      }
      const authenticatedData = aadBuffer(aad);
      const dek = crypto.randomBytes(DEK_BYTES);
      const iv = crypto.randomBytes(IV_BYTES);
      try {
        const cipher = crypto.createCipheriv(ALGORITHM, dek, iv, { authTagLength: TAG_BYTES });
        cipher.setAAD(authenticatedData);
        const ciphertext = Buffer.concat([cipher.update(input), cipher.final()]);
        const wrapped = await keyProvider.wrapKey(dek);
        if (!wrapped || typeof wrapped.wrappedKey !== 'string' ||
            !Number.isSafeInteger(wrapped.keyVersion) || wrapped.keyVersion < 1) {
          throw new Error('Key provider returned an invalid wrapped DEK');
        }
        return Object.freeze({
          version: VERSION,
          algorithm: ALGORITHM,
          ciphertext: ciphertext.toString('hex'),
          iv: iv.toString('hex'),
          authTag: cipher.getAuthTag().toString('hex'),
          wrappedKey: wrapped.wrappedKey,
          keyVersion: wrapped.keyVersion
        });
      } finally {
        dek.fill(0);
        input.fill(0);
        authenticatedData.fill(0);
      }
    },

    async decrypt(envelope, { aad } = {}) {
      assertEnvelope(envelope);
      const authenticatedData = aadBuffer(aad);
      const dek = await keyProvider.unwrapKey(envelope.wrappedKey);
      if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
        if (Buffer.isBuffer(dek)) dek.fill(0);
        authenticatedData.fill(0);
        throw new Error('Key provider returned an invalid DEK');
      }
      try {
        const decipher = crypto.createDecipheriv(
          ALGORITHM, dek, Buffer.from(envelope.iv, 'hex'), { authTagLength: TAG_BYTES }
        );
        decipher.setAAD(authenticatedData);
        decipher.setAuthTag(Buffer.from(envelope.authTag, 'hex'));
        const plaintext = Buffer.concat([
          decipher.update(Buffer.from(envelope.ciphertext, 'hex')),
          decipher.final()
        ]);
        return plaintext;
      } catch (cause) {
        throw new Error('Envelope authentication failed', { cause });
      } finally {
        dek.fill(0);
        authenticatedData.fill(0);
      }
    }
  });
}
