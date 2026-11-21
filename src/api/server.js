import Fastify from 'fastify';
import { requireApiKey } from './middleware/api-key-auth.js';
import { walletRoutes } from './routes/wallet.routes.js';
import { transferRoutes } from './routes/transfer.routes.js';

export function buildServer() {
  const app = Fastify({
    logger: true,
    bodyLimit: 32 * 1024,
    trustProxy: false,
    requestTimeout: 30_000
  });

  app.addHook('onRequest', async (request, reply) => {
    if (request.url === '/health') return;
    return requireApiKey(request, reply);
  });

  app.get('/health', async () => ({
    status: 'ok',
    service: 'blackchin-wallet-engine'
  }));

  app.register(walletRoutes);
  app.register(transferRoutes);

  app.setErrorHandler((error, request, reply) => {
    request.log.error({
      code: error.code,
      statusCode: error.statusCode,
      message: error.message
    }, 'Request failed');

    const statusCode =
      Number.isInteger(error.statusCode) &&
      error.statusCode >= 400 &&
      error.statusCode < 600
        ? error.statusCode
        : 500;

    return reply.code(statusCode).send({
      error: statusCode >= 500 ? 'INTERNAL_SERVER_ERROR' : 'REQUEST_ERROR',
      message: statusCode >= 500 ? 'The request could not be completed' : error.message
    });
  });

  return app;
}
