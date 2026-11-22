import crypto from 'node:crypto';

const MIN_KEY_BYTES = 32;

let cached = { raw: undefined, expected: null };

/**
 * Read and validate the configured API key on use.
 *
 * Validation is lazy (not at import time) so the module can be imported by
 * tests and tooling without a key, while every request still fails closed when
 * `API_ACCESS_KEY` is missing or too short (401/500-free startup check is done
 * by `assertApiKeyConfigured()` in the server bootstrap).
 */
function readConfiguredKey() {
  const raw = process.env.API_ACCESS_KEY;

  if (cached.raw === raw) {
    return cached.expected;
  }

  cached = {
    raw,
    expected:
      typeof raw === 'string' && Buffer.byteLength(raw, 'utf8') >= MIN_KEY_BYTES
        ? Buffer.from(raw, 'utf8')
        : null
  };

  return cached.expected;
}

/**
 * Throws when the API key is not configured. Called once during startup so a
 * misconfigured deployment never opens the port.
 */
export function assertApiKeyConfigured() {
  const expected = readConfiguredKey();

  if (!expected) {
    throw new Error(
      `API_ACCESS_KEY must be configured with at least ${MIN_KEY_BYTES} characters; API startup is disabled without it`
    );
  }

  return true;
}

export async function requireApiKey(request, reply) {
  const expected = readConfiguredKey();

  // Fail closed: an unconfigured server rejects every authenticated request.
  if (!expected) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'A valid X-API-Key header is required'
    });
  }

  const suppliedHeader = request.headers['x-api-key'];

  if (typeof suppliedHeader !== 'string') {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'A valid X-API-Key header is required'
    });
  }

  const supplied = Buffer.from(suppliedHeader, 'utf8');

  if (
    supplied.length !== expected.length ||
    !crypto.timingSafeEqual(supplied, expected)
  ) {
    return reply.code(401).send({
      error: 'UNAUTHORIZED',
      message: 'A valid X-API-Key header is required'
    });
  }
}
