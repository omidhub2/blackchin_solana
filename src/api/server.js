import Fastify from 'fastify';
import { requireApiKey, assertApiKeyConfigured } from './middleware/api-key-auth.js';
import { walletRoutes } from './routes/wallet.routes.js';
import { transferRoutes } from './routes/transfer.routes.js';
import { hdWalletRoutes } from './routes/hd-wallet.routes.js';
import { tenantWalletRoutes } from './routes/tenant-wallet.routes.js';
import { dashboardRoutes } from './routes/dashboard.routes.js';

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
export function buildServer({ services, logger = true, health = null, metrics = null, tenantPool = null, tenantContextSigner = null, createTenantServices = null } = {}) {
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

  app.decorate('services', services ?? null);
  app.decorate('tenantPool', tenantPool);
  app.decorate('tenantContextSigner', tenantContextSigner);
  app.decorate('createTenantServices', createTenantServices);
  app.decorateRequest('services', null);
  app.decorateRequest('tenant', null);
  app.decorateRequest('metricsStartedAt', null);

  /**
   * Resolve the injected services once per request. Production passes them to
   * buildServer(); returning null keeps the server importable without a
   * database (health checks, tests) — endpoints then fail closed with 500.
   */
  app.addHook('onRequest', async (request) => {
    request.services = services ?? null;
    if (metrics) request.metricsStartedAt = process.hrtime.bigint();
  });

  app.addHook('onResponse', async (request, reply) => {
    if (!metrics || request.metricsStartedAt === null) return;
    const elapsedNs = process.hrtime.bigint() - request.metricsStartedAt;
    metrics.recordHttpRequest({
      method: request.method,
      route: request.routeOptions?.url ?? request.routerPath ?? 'unmatched',
      statusCode: reply.statusCode,
      durationMs: Number(elapsedNs) / 1_000_000
    });
  });

  app.addHook('preHandler', async (request, reply) => {
    if (OPEN_PATHS.has(request.url)) return;
    if (request.url.startsWith('/api/v1/tenant/')) return;
    // Dashboard routes authenticate with an operator session cookie, never a
    // partner API key. The dashboard plugin enforces its own session + CSRF.
    if (request.url.startsWith('/api/v1/dashboard/')) return;
    return requireApiKey(request, reply);
  });

  app.addHook('onSend', async (_request, reply, payload) => {
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('X-Frame-Options', 'DENY');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    return payload;
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

  // Prometheus metrics are protected by the standard API-key hook. Never
  // expose request paths with IDs, query values or wallet identifiers.
  app.get('/metrics', async (_request, reply) => {
    if (!metrics) {
      return reply.code(503).send('metrics_unavailable\\n');
    }
    reply.type('text/plain; version=0.0.4; charset=utf-8');
    return metrics.render();
  });

  const distributed = buildDistributedLimiter(services?.deps?.db ?? null);

  app.register(walletRoutes, { distributed });
  app.register(transferRoutes, { distributed });
  app.register(hdWalletRoutes, { distributed });
  app.register(tenantWalletRoutes, { prefix: '/api/v1/tenant' });
  app.register(dashboardRoutes, { prefix: '/api/v1/dashboard' });

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
