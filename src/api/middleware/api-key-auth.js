import crypto from 'node:crypto';

const configuredApiKey = process.env.API_ACCESS_KEY;

if (
  typeof configuredApiKey !== 'string' ||
  Buffer.byteLength(configuredApiKey, 'utf8') < 32
) {
  throw new Error(
    'API_ACCESS_KEY must be configured with at least 32 characters; API startup is disabled without it'
  );
}

const expected = Buffer.from(configuredApiKey, 'utf8');

export async function requireApiKey(request, reply) {
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
