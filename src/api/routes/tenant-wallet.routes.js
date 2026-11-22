/**
 * Tenant-scoped Solana HD wallet API.
 *
 * This plugin authenticates every request with a tenant credential and passes
 * only the authenticated tenant id to tenant-isolated service methods.
 */
import { createTenantAuthHook, requireTenantScope } from '../middleware/tenant-auth.js';
import { getServices } from '../services-context.js';
import {
  optionalString, parsePositiveId, rejectUnknownKeys, requireBoolean,
  requireObject, requireSafeInteger, requireString
} from '../validation.js';
import { badRequest } from '../../core/errors.js';
import { rateLimitHook } from '../middleware/rate-limit.js';
import { MAX_BATCH_SIZE } from '../../core/wallets/child-wallet.service.js';

const CREATE_FIELDS = ['label', 'ownerId'];
const STATUS_VALUES = ['active', 'disabled', 'archived'];

export async function tenantWalletRoutes(app) {
  const db = app.services?.deps?.db;
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('Tenant API requires the configured database');
  }

  app.addHook('preHandler', createTenantAuthHook({ db }));
  const distributed = { db };
  const createLimiter = rateLimitHook({ limit: 10, windowMs: 60_000, keyPrefix: 'tenant-hd-create', distributed });
  const accountLimiter = rateLimitHook({ limit: 20, windowMs: 60_000, keyPrefix: 'tenant-address-create', distributed });
  const recoveryLimiter = rateLimitHook({ limit: 5, windowMs: 60_000, keyPrefix: 'tenant-recovery', distributed });
  const services = (request) => getServices(app, request).tenantWallets;
  const tenantId = (request) => request.tenant.id;

  app.post('/hd-wallets', {
    preHandler: [requireTenantScope('wallets:write'), createLimiter]
  }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, CREATE_FIELDS);
    const label = optionalString(body.label, 'label', { max: 100 });
    const ownerId = optionalString(body.ownerId, 'ownerId', {
      max: 64,
      pattern: /^[A-Za-z0-9._:-]+$/,
      patternMessage: 'ownerId must contain only letters, digits, dot, underscore, colon or dash'
    });
    const result = await services(request).createHdWallet({ tenantId: tenantId(request), label, ownerId });
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(result);
  });

  app.get('/hd-wallets/:id', {
    preHandler: requireTenantScope('wallets:read')
  }, async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    return services(request).getHdWallet(tenantId(request), id);
  });

  app.patch('/hd-wallets/:id', {
    preHandler: requireTenantScope('wallets:write')
  }, async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['status']);
    const status = requireString(body.status, 'status', { max: 16 });
    if (!STATUS_VALUES.includes(status)) throw badRequest('status must be active, disabled or archived');
    return services(request).updateStatus(tenantId(request), id, status);
  });

  app.post('/hd-wallets/:id/recovery-phrase/consume', {
    preHandler: [requireTenantScope('wallets:write'), recoveryLimiter]
  }, async (request, reply) => {
    const id = parsePositiveId(request.params.id, 'id');
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['token', 'confirm']);
    const result = await services(request).consumeRecoveryPhrase({
      tenantId: tenantId(request),
      hdWalletId: id,
      token: requireString(body.token, 'token', { min: 32, max: 2048 }),
      confirm: requireBoolean(body.confirm, 'confirm')
    });
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    return result;
  });

  app.get('/hd-wallets/:id/accounts', {
    preHandler: requireTenantScope('wallets:read')
  }, async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);
    return services(request).listAccounts(tenantId(request), id, {
      limit: limit ?? undefined,
      offset: offset ?? undefined
    });
  });

  app.post('/hd-wallets/:id/accounts', {
    preHandler: [requireTenantScope('addresses:write'), accountLimiter]
  }, async (request, reply) => {
    const id = parsePositiveId(request.params.id, 'id');
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['count']);
    const count = body.count === undefined ? 1 :
      requireSafeInteger(body.count, 'count', { min: 1, max: MAX_BATCH_SIZE });
    const result = await services(request).createAccounts(tenantId(request), id, { count });
    return reply.code(201).send(result);
  });

  app.get('/hd-wallets/:id/accounts/:accountIndex', {
    preHandler: requireTenantScope('wallets:read')
  }, async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const parsed = /^\d{1,10}$/.test(request.params.accountIndex)
      ? Number(request.params.accountIndex) : NaN;
    const index = requireSafeInteger(parsed, 'accountIndex', { min: 0, max: 2_147_483_647 });
    return services(request).getAccountAtIndex(tenantId(request), id, index);
  });
}
