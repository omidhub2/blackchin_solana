/**
 * Native SOL transfer routes (fee estimate and approved withdrawal).
 *
 * Preserved request/response contract:
 *   POST /api/v1/transfers/estimate  { fromPublicKey, toPublicKey, amountSol }
 *   POST /api/v1/transfers           + Idempotency-Key header + approved: true
 */
import { badRequest } from '../../core/errors.js';
import { rateLimitHook } from '../middleware/rate-limit.js';
import { getServices } from '../services-context.js';
import {
  rejectUnknownKeys,
  requireBoolean,
  requireIdempotencyKey,
  requireObject,
  requirePublicKey,
  requireSolAmount
} from '../validation.js';

const ESTIMATE_FIELDS = ['fromPublicKey', 'toPublicKey', 'amountSol'];
const TRANSFER_FIELDS = ['fromPublicKey', 'toPublicKey', 'amountSol', 'approved'];

export async function transferRoutes(app) {
  const services = (request) => getServices(app, request);
  const { distributed = null } = app.config ?? {};

  // Withdrawals are money-moving: fail closed without the shared limiter.
  const estimateLimiter = rateLimitHook({
    limit: 60,
    windowMs: 60_000,
    keyPrefix: 'tx-estimate',
    distributed,
    failClosed: false
  });
  const submitLimiter = rateLimitHook({ limit: 10, windowMs: 60_000, keyPrefix: 'tx-submit', distributed });

  app.post('/api/v1/transfers/estimate', { preHandler: estimateLimiter }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ESTIMATE_FIELDS);

    return services(request).withdrawals.estimate({
      fromPublicKey: requirePublicKey(body.fromPublicKey, 'fromPublicKey'),
      toPublicKey: requirePublicKey(body.toPublicKey, 'toPublicKey'),
      amountSol: requireSolAmount(body.amountSol, 'amountSol')
    });
  });

  app.post('/api/v1/transfers', { preHandler: submitLimiter }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, TRANSFER_FIELDS);

    if (body.approved !== true) {
      throw badRequest(
        'The caller must explicitly approve the transfer by setting approved: true',
        'APPROVAL_REQUIRED'
      );
    }

    const result = await services(request).withdrawals.submit({
      idempotencyKey: requireIdempotencyKey(request.headers['idempotency-key']),
      fromPublicKey: requirePublicKey(body.fromPublicKey, 'fromPublicKey'),
      toPublicKey: requirePublicKey(body.toPublicKey, 'toPublicKey'),
      amountSol: requireSolAmount(body.amountSol, 'amountSol'),
      approved: requireBoolean(body.approved, 'approved')
    });

    return reply.code(result.replayed ? 200 : 201).send(result);
  });
}
