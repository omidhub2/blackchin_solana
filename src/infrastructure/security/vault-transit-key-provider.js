/**
 * HashiCorp Vault Transit adapter for wrapping 256-bit per-envelope DEKs.
 *
 * The DEK is encrypted by a Vault-managed AES-256-GCM-96 Transit key. Vault
 * never returns its KEK. The caller receives the DEK only after an authorized
 * unwrap operation; production policy must grant decrypt only to the isolated
 * signer identity, never to the public API identity.
 */
import { assertEnvelopeKeyProvider } from './envelope-key-provider.js';

const DEK_BYTES = 32;
const DEFAULT_TIMEOUT_MS = 3_000;
const VAULT_CIPHERTEXT = /^vault:v([1-9][0-9]*):[A-Za-z0-9+/=]+$/;

function fail(code, cause) {
  const error = new Error('Vault Transit key operation failed');
  error.code = code;
  if (cause) error.cause = cause;
  return error;
}

function canonicalBase64(value) {
  if (typeof value !== 'string' || value.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value;
}

export function createVaultTransitKeyProvider({
  address = process.env.VAULT_ADDR,
  token = process.env.VAULT_SIGNER_TOKEN,
  keyName = process.env.VAULT_TRANSIT_KEY_NAME || 'blackchin-envelope',
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  if (typeof address !== 'string') throw new TypeError('VAULT_ADDR is required');
  const base = new URL(address);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password ||
      base.search || base.hash) {
    throw new TypeError('VAULT_ADDR must be an HTTP(S) origin without credentials, query or fragment');
  }
  if (base.protocol !== 'https:' && !['localhost', '127.0.0.1', '::1'].includes(base.hostname)) {
    throw new TypeError('Non-local Vault endpoints must use HTTPS');
  }
  if (typeof token !== 'string' || token.length < 16) {
    throw new TypeError('VAULT_SIGNER_TOKEN is required');
  }
  if (typeof keyName !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(keyName)) {
    throw new TypeError('Vault Transit key name is invalid');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 15_000) {
    throw new TypeError('timeoutMs must be between 100 and 15000');
  }

  const endpoint = (operation) =>
    new URL(`/v1/transit/${operation}/${encodeURIComponent(keyName)}`, base);

  async function request(operation, body) {
    let response;
    try {
      response = await fetchImpl(endpoint(operation), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-vault-token': token
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (cause) {
      throw fail('VAULT_TRANSPORT_ERROR', cause);
    }

    if (!response?.ok) {
      // Do not read or expose Vault's error body; it may contain sensitive detail.
      throw fail(response?.status === 403 ? 'VAULT_PERMISSION_DENIED' : 'VAULT_REQUEST_REJECTED');
    }

    let result;
    try {
      const contentType = response.headers?.get?.('content-type') ?? '';
      if (!contentType.toLowerCase().includes('application/json')) throw new Error('invalid content type');
      result = await response.json();
    } catch (cause) {
      throw fail('VAULT_INVALID_RESPONSE', cause);
    }
    if (!result?.data || typeof result.data !== 'object') {
      throw fail('VAULT_INVALID_RESPONSE');
    }
    return result.data;
  }

  const provider = {
    // Transit reports the key version in the returned ciphertext. This value
    // is a logical provider version, not a promise that Vault cannot rotate it.
    currentVersion: 1,

    async wrapKey(dek) {
      if (!Buffer.isBuffer(dek) || dek.length !== DEK_BYTES) {
        throw new TypeError('DEK must be a 32-byte Buffer');
      }
      const data = await request('encrypt', { plaintext: dek.toString('base64') });
      if (typeof data.ciphertext !== 'string' || !VAULT_CIPHERTEXT.test(data.ciphertext)) {
        throw fail('VAULT_INVALID_RESPONSE');
      }
      const version = Number(data.ciphertext.match(/^vault:v([1-9][0-9]*):/)[1]);
      if (!Number.isSafeInteger(version)) throw fail('VAULT_INVALID_RESPONSE');
      return Object.freeze({ wrappedKey: data.ciphertext, keyVersion: version });
    },

    async unwrapKey(wrappedKey) {
      if (typeof wrappedKey !== 'string' || !VAULT_CIPHERTEXT.test(wrappedKey)) {
        throw new TypeError('Wrapped DEK is not a valid Vault Transit ciphertext');
      }
      const data = await request('decrypt', { ciphertext: wrappedKey });
      if (!canonicalBase64(data.plaintext)) throw fail('VAULT_INVALID_RESPONSE');
      const dek = Buffer.from(data.plaintext, 'base64');
      if (dek.length !== DEK_BYTES) {
        dek.fill(0);
        throw fail('VAULT_INVALID_RESPONSE');
      }
      return dek;
    }
  };

  return Object.freeze(assertEnvelopeKeyProvider(provider));
}
