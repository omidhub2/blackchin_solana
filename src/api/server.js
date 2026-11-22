import Fastify from 'fastify';
import { requireApiKey, assertApiKeyConfigured } from './middleware/api-key-auth.js';
import { walletRoutes } from './routes/wallet.routes.js';
import { transferRoutes } from './routes/transfer.routes.js';
import { hdWalletRoutes } from './routes/hd-wallet.routes.js';

const OPEN_PATHS = new Set(['/health', '/health/ready']);

/**
 * Build a shared rate-limit backend descriptor.
 *
 * Returns `null` when no database is available (tests / import-time route
 * registration), which makes the hooks use their local fallback.
 */
function buildDistributedLimiter(db) {
  if (!db || typeof db.query !== 'function') return null;

  return { db };
}

/**
 * Build the Fastify application.
 *
 * @param {{
 *   services?: object,          // injected service container (tests)
 *   logger?: boolean|object,    // Fastify logger option
 * }} [options]
 */
export function buildServer({ services, logger = true, health = null } = {}) {
  // Fail closed before the port is opened when the API key is missing.
  assertApiKeyConfigured();
  const app = Fastify({
    logger: logger === true || logger === false
      ? {
          level: process.env.LOG_LEVEL || 'info',
          // Never let a recovery token or any credential reach the log even if
          // a handler later logs the request or its body.
          redact: {
            paths: [
              'req.headers["x-api-key"]',
              'req.headers["idempotency-key"]',
              'req.body.token',
              'req.body.mnemonic',
              'req.body.confirm',
              '*.token',
              '*.mnemonic',
              '*.privateKey',
              '*.secretKey',
              '*.secret'
            ],
            censor: '[REDACTED]'
          }
        }
      : logger,
    bodyLimit: 32 * 1024,
    trustProxy: false,
    // Socket-level request timeout (defends against slow clients).
    requestTimeout: 35_000
  });

  app.decorateRequest('services', null);

  /**
   * Resolve the injected services once per request. Production passes them to
   * buildServer(); returning null keeps the server importable without a
   * database (health checks, tests) — endpoints then fail closed with 500.
   */
  app.addHook('onRequest', async (request) => {
    request.services = services ?? null;
  });

  app.addHook('preHandler', async (request, reply) => {
    if (OPEN_PATHS.has(request.url)) return;
    return requireApiKey(request, reply);
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'blackchin-wallet-engine'
  }));

  /**
   * Readiness: database reachability + background worker state. Coarse status
   * only; no infrastructure identifiers.
   */
  app.get('/health/ready', async (_request, reply) => {
    if (!health) {
      return reply.code(503).send({ ready: false, checks: { health: 'unconfigured' } });
    }

    const result = await health.ready();
    return reply.code(result.statusCode).send(result.body);
  });

  const distributed = buildDistributedLimiter(services?.deps?.db ?? null);

  app.register(walletRoutes, { distributed });
  app.register(transferRoutes, { distributed });
  app.register(hdWalletRoutes, { distributed });

  // Fastify's own client errors (invalid JSON, oversized payload) keep their
  // 4xx status instead of being masked as an internal server error.
  app.setErrorHandler((error, request, reply) => {
    const statusCode =
      Number.isInteger(error.statusCode) &&
        error.statusCode >= 400 &&
        error.statusCode < 600
        ? error.statusCode
        : 500;

    request.log.error({
      code: error.code,
      statusCode,
      message: error.message
    }, 'Request failed');

    // Preserve Fastify client-error codes (e.g. FST_ERR_CTP_INVALID_JSON_BODY).
    const keepErrorCode =
      statusCode < 500 && typeof error.code === 'string' && error.code.startsWith('FST_');

    return reply.code(statusCode).send({
      error: statusCode >= 500
        ? 'INTERNAL_SERVER_ERROR'
        : keepErrorCode
          ? error.code
          : (error.code ?? 'REQUEST_ERROR'),
      message: statusCode >= 500 ? 'The request could not be completed' : error.message
    });
  });

  // Unknown routes return 404 instead of being reported as request failures.
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({
      error: 'NOT_FOUND',
      message: 'Route not found'
    })
  );

  return app;
}
