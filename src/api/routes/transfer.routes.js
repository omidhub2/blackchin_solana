import {
  estimateTransfer,
  submitTransfer
} from '../../core/transactions/transfer.service.js';

export async function transferRoutes(app) {
  app.post('/api/v1/transfers/estimate', async (request, reply) => {
    const { fromPublicKey, toPublicKey, amountSol } = request.body ?? {};

    if (
      typeof fromPublicKey !== 'string' ||
      typeof toPublicKey !== 'string' ||
      typeof amountSol !== 'string'
    ) {
      return reply.code(400).send({
        error: 'INVALID_REQUEST',
        message: 'fromPublicKey, toPublicKey and decimal-string amountSol are required'
      });
    }

    return estimateTransfer({ fromPublicKey, toPublicKey, amountSol });
  });

  app.post('/api/v1/transfers', async (request, reply) => {
    const { fromPublicKey, toPublicKey, amountSol, approved } = request.body ?? {};

    if (
      typeof fromPublicKey !== 'string' ||
      typeof toPublicKey !== 'string' ||
      typeof amountSol !== 'string'
    ) {
      return reply.code(400).send({
        error: 'INVALID_REQUEST',
        message: 'fromPublicKey, toPublicKey and decimal-string amountSol are required'
      });
    }

    const result = await submitTransfer({
      idempotencyKey: request.headers['idempotency-key'],
      fromPublicKey,
      toPublicKey,
      amountSol,
      approved
    });

    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
