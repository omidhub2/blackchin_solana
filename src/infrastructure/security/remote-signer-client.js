/**
 * Fail-closed HTTP client for the BLACKCHIN Nitro Enclave signing gateway.
 *
 * This client transports public transaction data and an authorization
 * capability only. It never accepts or returns private keys, mnemonics, seeds,
 * or decrypted wallet material.
 *
 * The gateway is an EC2 parent-instance bridge to the enclave over vsock.
 * The enclave MUST independently verify the authorization JWS and transaction
 * message before deriving a child key and signing.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

const MAX_MESSAGE_BYTES = 1232;
const SIGNATURE_BYTES = 64;

function assertPositiveId(value, name) {
  const normalized = String(value ?? '');
  if (!/^[1-9][0-9]*$/.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer string`);
  }
  return normalized;
}

function assertBase64(value, name, { min = 1, max = MAX_MESSAGE_BYTES } = {}) {
  if (typeof value !== 'string' || value.length === 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    throw new TypeError(`${name} must be canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length < min || decoded.length > max || decoded.toString('base64') !== value) {
    throw new TypeError(`${name} has an invalid decoded length or encoding`);
  }
  return decoded;
}

function signerUnavailable(cause) {
  const error = new Error('Remote signing service is unavailable; transaction was not broadcast', { cause });
  error.statusCode = 503;
  error.code = 'REMOTE_SIGNER_UNAVAILABLE';
  return error;
}

export function createRemoteSignerClient({
  endpoint = process.env.NITRO_SIGNER_URL,
  bearerToken = process.env.NITRO_SIGNER_TOKEN,
  fetchImpl = globalThis.fetch,
  timeoutMs = 5_000,
  requestId = randomUUID
} = {}) {
  if (typeof endpoint !== 'string') {
    throw new TypeError('NITRO_SIGNER_URL must be configured');
  }
  const url = new URL(endpoint);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) {
    throw new TypeError('Nitro signer endpoint must be an HTTPS URL without embedded credentials or fragment');
  }
  if (typeof bearerToken !== 'string' || bearerToken.length < 32) {
    throw new TypeError('NITRO_SIGNER_TOKEN must contain at least 32 characters');
  }
  if (typeof fetchImpl !== 'function') throw new TypeError('A fetch implementation is required');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000) {
    throw new TypeError('timeoutMs must be between 100 and 30000');
  }
  if (typeof requestId !== 'function') throw new TypeError('requestId must be a function');

  async function signMessage(input = {}) {
    const tenantId = assertPositiveId(input.tenantId, 'tenantId');
    const hdWalletId = assertPositiveId(input.hdWalletId, 'hdWalletId');
    const accountIndex = input.accountIndex;
    if (!Number.isSafeInteger(accountIndex) || accountIndex < 0 || accountIndex > 0x7fffffff) {
      throw new TypeError('accountIndex is outside the supported hardened derivation range');
    }
    if (typeof input.publicKey !== 'string' || input.publicKey.length < 32 || input.publicKey.length > 44) {
      throw new TypeError('publicKey is invalid');
    }
    try {
      const parsedPublicKey = new PublicKey(input.publicKey);
      if (parsedPublicKey.toBase58() !== input.publicKey || parsedPublicKey.toBytes().length !== 32) {
        throw new Error('non-canonical public key');
      }
    } catch {
      throw new TypeError('publicKey must be a canonical Solana base58 public key');
    }
    if (typeof input.network !== 'string' || !['devnet', 'testnet', 'mainnet-beta'].includes(input.network)) {
      throw new TypeError('network is invalid');
    }
    if (typeof input.authorization !== 'string' || input.authorization.length < 32 || input.authorization.length > 8192) {
      throw new TypeError('A signed transaction authorization capability is required');
    }

    const message = assertBase64(input.message, 'message');
    const messageSha256 = createHash('sha256').update(message).digest('hex');
    const id = requestId();
    if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id)) {
      throw new TypeError('requestId must return a UUID');
    }

    const payload = {
      version: 1,
      requestId: id,
      tenantId,
      hdWalletId,
      accountIndex,
      derivationPath: `m/44'/501'/${accountIndex}'/0'`,
      publicKey: input.publicKey,
      network: input.network,
      message: message.toString('base64'),
      messageSha256,
      authorization: input.authorization
    };

    let response;
    try {
      response = await fetchImpl(new URL('/v1/sign-message', url), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${bearerToken}`,
          'x-request-id': id
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error'
      });
    } catch (cause) {
      throw signerUnavailable(cause);
    }

    if (!response?.ok) {
      // Never propagate remote response bodies: they may contain sensitive diagnostics.
      const error = new Error('Remote signer rejected or could not process the signing request');
      error.statusCode = 503;
      error.code = response?.status === 401 || response?.status === 403
        ? 'REMOTE_SIGNER_AUTH_FAILED'
        : 'REMOTE_SIGNER_REJECTED';
      throw error;
    }

    let result;
    try {
      const type = response.headers?.get?.('content-type') ?? '';
      if (!type.toLowerCase().includes('application/json')) throw new Error('Unexpected signer response content type');
      result = await response.json();
    } catch (cause) {
      throw signerUnavailable(cause);
    }

    if (result?.requestId !== id || result?.messageSha256 !== messageSha256 ||
        result?.publicKey !== input.publicKey) {
      const error = new Error('Remote signer response does not match the signing request');
      error.statusCode = 502;
      error.code = 'REMOTE_SIGNER_RESPONSE_MISMATCH';
      throw error;
    }

    let signature;
    try {
      signature = assertBase64(result.signature, 'signature', {
        min: SIGNATURE_BYTES,
        max: SIGNATURE_BYTES
      });
    } catch (cause) {
      throw signerUnavailable(cause);
    }

    return Object.freeze({
      requestId: id,
      publicKey: result.publicKey,
      messageSha256,
      signature
    });
  }

  return Object.freeze({ signMessage });
}
