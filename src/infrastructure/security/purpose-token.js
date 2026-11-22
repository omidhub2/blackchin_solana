/**
 * Purpose-bound, wallet-bound AEAD tokens that leave the service.
 *
 * The HD root mnemonic is encrypted with a sub-key derived from the master
 * encryption key and a domain separator, so token ciphertext can never be
 * decrypted as a stored root mnemonic (and vice versa).
 *
 * Token AAD binds, cryptographically and before decryption, all of:
 *
 *   blackchin:<purpose>:v2|<purpose>|<walletId>|<issuedAt>|<expiresAt>|<jti>
 *
 * A token issued for wallet A therefore fails authentication for wallet B, an
 * expired token is rejected using the server clock, and `jti` gives each token
 * a unique, loggable identity (the plaintext token is never stored or logged;
 * only its SHA-256 hash is persisted, see `storeRecoveryToken`).
 */
import crypto from 'node:crypto';

import { conflict } from '../../core/errors.js';
import { ENCRYPTION_ALGORITHM, IV_LENGTH, AUTH_TAG_LENGTH } from './hd-envelope.js';

const TOKEN_PURPOSES = new Set(['recovery-phrase', 'root-mnemonic']);
const TOKEN_VERSION = 'v2';

/** Default validity of a recovery token (one provisioning window). */
export const DEFAULT_RECOVERY_TOKEN_TTL_MS = 60 * 60 * 1000;
const MAX_RECOVERY_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function derivePurposeKey(keyProvider, purpose) {
  if (!TOKEN_PURPOSES.has(purpose)) {
    throw new TypeError('Unsupported encryption purpose');
  }

  const master = keyProvider.keyFor(keyProvider.currentVersion);

  return Buffer.from(
    crypto
      .createHmac('sha256', master)
      .update(`blackchin:${purpose}:${TOKEN_VERSION}`, 'utf8')
      .digest()
  );
}

function assertTokenFormat(token) {
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    throw new TypeError('Token must be a base64url string');
  }

  const raw = Buffer.from(token, 'base64url');

  if (raw.length <= IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new TypeError('Token is too short');
  }

  return raw;
}

/**
 * Convert a millisecond timestamp to a positive safe integer string.
 * Non-finite, fractional, negative or out-of-range values are refused.
 */
function timestampString(value, field) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`Invalid token ${field}`);
  }

  return String(value);
}

function buildAad({ purpose, walletId, issuedAt, expiresAt, jti }) {
  for (const [name, value] of Object.entries({ purpose, walletId, issuedAt, expiresAt, jti })) {
    if (typeof value !== 'string' || value.length === 0 || /[|\r\n]/.test(value)) {
      throw new TypeError(`Invalid token binding field: ${name}`);
    }
  }

  return Buffer.from(
    `blackchin:${purpose}:${TOKEN_VERSION}|${purpose}|${walletId}|${issuedAt}|${expiresAt}|${jti}`,
    'utf8'
  );
}

function invalidToken() {
  return conflict(
    'Recovery token is invalid, expired, or already used',
    'INVALID_RECOVERY_TOKEN'
  );
}

/**
 * @param {object} keyProvider from createEnvKeyProvider()
 * @param {{ now?: () => number }} [options]
 */
export function createPurposeTokenCodec(keyProvider, { now = () => Date.now() } = {}) {
  function keyFor(purpose) {
    return derivePurposeKey(keyProvider, purpose);
  }

  return Object.freeze({
    /**
     * Seal plaintext into a wallet-bound, expiring token.
     *
     * @returns {{ token: string, jti: string, issuedAt: string,
     *             expiresAt: string, tokenHash: string }}
     */
    seal(purpose, plaintext, { walletId, ttlMs = DEFAULT_RECOVERY_TOKEN_TTL_MS } = {}) {
      if (typeof plaintext !== 'string' || plaintext.length === 0) {
        throw new TypeError('Token payload must be a non-empty string');
      }

      if (walletId === undefined || walletId === null || String(walletId).length === 0) {
        throw new TypeError('A walletId binding is required');
      }

      if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 || ttlMs > MAX_RECOVERY_TOKEN_TTL_MS) {
        throw new RangeError('Token TTL is out of range');
      }

      const issuedAtMs = now();
      const expiresAtMs = issuedAtMs + ttlMs;

      const binding = {
        purpose,
        walletId: String(walletId),
        issuedAt: timestampString(issuedAtMs, 'issuedAt'),
        expiresAt: timestampString(expiresAtMs, 'expiresAt'),
        jti: crypto.randomUUID()
      };

      const bindingJson = JSON.stringify(binding);
      const bindingBuffer = Buffer.from(bindingJson, 'utf8');

      if (bindingBuffer.length > 1024) {
        throw new RangeError('Token binding is too large');
      }

      const lengthPrefix = Buffer.alloc(2);
      lengthPrefix.writeUInt16BE(bindingBuffer.length, 0);

      const iv = crypto.randomBytes(IV_LENGTH);
      const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, keyFor(purpose), iv);
      cipher.setAAD(buildAad(binding));

      const ciphertext = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
      ]);

      const token = Buffer.concat([
        iv,
        cipher.getAuthTag(),
        lengthPrefix,
        bindingBuffer,
        ciphertext
      ]).toString('base64url');

      return {
        token,
        jti: binding.jti,
        issuedAt: new Date(issuedAtMs).toISOString(),
        expiresAt: new Date(expiresAtMs).toISOString(),
        tokenHash: crypto.createHash('sha256').update(token, 'utf8').digest('hex')
      };
    },

    /**
     * Open a token for the given purpose and wallet.
     *
     * Verifies (in this order) format, expiry against the server clock, and the
     * AEAD AAD binding the wallet id. Any failure throws the same generic error.
     *
     * @returns {{ payload: string, jti: string, issuedAt: number, expiresAt: number }}
     */
    open(purpose, token, { walletId } = {}) {
      if (!TOKEN_PURPOSES.has(purpose) || purpose !== 'recovery-phrase') {
        // Only the provisioning purpose may be minted to external callers.
        throw invalidToken();
      }

      try {
        const raw = assertTokenFormat(token);

        if (walletId === undefined || walletId === null) {
          throw new TypeError('A walletId binding is required');
        }

        const envelope = parseEnvelope(raw);
        const clearBinding = bindingOf(envelope);

        if (clearBinding.purpose !== purpose || clearBinding.walletId !== String(walletId)) {
          throw invalidToken();
        }

        // The clear binding is untrusted; it only supplies the AAD that must
        // authenticate. A forged binding cannot produce a valid tag.
        const binding = {
          purpose,
          walletId: String(walletId),
          issuedAt: clearBinding.issuedAt,
          expiresAt: clearBinding.expiresAt,
          jti: clearBinding.jti
        };

        const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, keyFor(purpose), envelope.iv);
        decipher.setAAD(buildAad(binding));
        decipher.setAuthTag(envelope.authTag);

        const plaintext = Buffer.concat([
          decipher.update(envelope.ciphertext),
          decipher.final()
        ]).toString('utf8');

        const expiresAtMs = Number(binding.expiresAt);

        if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= now()) {
          throw invalidToken();
        }

        return {
          payload: plaintext,
          jti: binding.jti,
          issuedAt: Number(binding.issuedAt),
          expiresAt: expiresAtMs
        };
      } catch {
        throw invalidToken();
      }
    },

    /**
     * Generic failure for invalid tokens, so callers cannot accidentally leak
     * the reason to an untrusted caller.
     */
    invalidToken
  });
}

/**
 * A token is `iv || tag || ciphertext || bindingEnvelope`.
 *
 * The binding envelope is authenticated implicitly: it is part of the AAD and
 * the AAD is authenticated by the tag over the ciphertext. To keep the token
 * self-describing for diagnostics we append it in clear, but it is never
 * trusted without a successful decryption.
 */
function parseEnvelope(raw) {
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const rest = raw.subarray(IV_LENGTH + AUTH_TAG_LENGTH);

  if (rest.length < 2) {
    throw new TypeError('Token is truncated');
  }

  const bindingLength = rest.readUInt16BE(0);

  if (bindingLength === 0 || bindingLength > 1024 || rest.length < 2 + bindingLength + 1) {
    throw new TypeError('Token binding is malformed');
  }

  const bindingJson = rest.subarray(2, 2 + bindingLength).toString('utf8');
  const ciphertext = rest.subarray(2 + bindingLength);
  const parsed = JSON.parse(bindingJson);

  if (
    !parsed ||
    typeof parsed !== 'object' ||
    typeof parsed.purpose !== 'string' ||
    typeof parsed.walletId !== 'string' ||
    typeof parsed.jti !== 'string'
  ) {
    throw new TypeError('Token binding is malformed');
  }

  return { iv, authTag, ciphertext, binding: parsed };
}

function bindingOf(envelope) {
  const { purpose, walletId, issuedAt, expiresAt, jti } = envelope.binding;

  return {
    purpose,
    walletId,
    issuedAt: timestampString(Number(issuedAt), 'issuedAt'),
    expiresAt: timestampString(Number(expiresAt), 'expiresAt'),
    jti
  };
}
