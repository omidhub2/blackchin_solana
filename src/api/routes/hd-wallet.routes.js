/**
 * HD root and child wallet routes.
 *
 * All routes require the global API-key hook (see server.js). The API key is a
 * single trusted-backend credential, not end-user authentication; see
 * docs/SECURITY.md for the ownership model and its limitations.
 */
import {
  optionalString,
  parseListLimit,
  parseListOffset,
  parsePositiveId,
  rejectUnknownKeys,
  requireBoolean,
  requireObject,
  requireSafeInteger,
  requireString
} from '../validation.js';
import { badRequest } from '../../core/errors.js';
import { rateLimitHook } from '../middleware/rate-limit.js';
import { getServices } from '../services-context.js';
import { MAX_BATCH_SIZE } from '../../core/wallets/child-wallet.service.js';

const CREATE_HD_FIELDS = ['label', 'ownerId'];
const CREATE_ACCOUNT_FIELDS = ['count'];
const RECOVERY_FIELDS = ['token', 'confirm'];
const STATUS_FIELDS = ['status'];

const HD_WALLET_STATUS_VALUES = ['active', 'disabled', 'archived'];
const ACCOUNT_STATUS_VALUES = ['active', 'disabled', 'archived'];

export async function hdWalletRoutes(app) {
  const services = (request) => getServices(app, request);
  const { distributed = null } = app.config ?? {};

  // Sensitive operations: fail closed if the shared limiter store is down.
  const createLimiter = rateLimitHook({ limit: 20, windowMs: 60_000, keyPrefix: 'hd-create', distributed });
  const batchLimiter = rateLimitHook({ limit: 30, windowMs: 60_000, keyPrefix: 'hd-accounts', distributed });
  const recoveryLimiter = rateLimitHook({ limit: 5, windowMs: 60_000, keyPrefix: 'hd-recovery', distributed });

  app.post('/api/v1/hd-wallets', { preHandler: createLimiter }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, CREATE_HD_FIELDS);

    const label = optionalString(body.label, 'label', { max: 100 });
    const ownerId = optionalString(body.ownerId, 'ownerId', {
      max: 64,
      pattern: /^[A-Za-z0-9._:-]+$/,
      patternMessage: 'ownerId must contain only letters, digits, dot, underscore, colon or dash'
    });

    const result = await services(request).hdWallets.createHdWallet({ label, ownerId });
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');

    return reply.code(201).send({
      wallet: result.wallet,
      recovery: result.recovery,
      nextSteps: [
        'Store the recovery phrase offline using the one-time token (POST /api/v1/hd-wallets/:id/recovery-phrase/consume).',
        'Create child wallets with POST /api/v1/hd-wallets/:id/accounts.'
      ]
    });
  });

  app.get('/api/v1/hd-wallets/:id', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');

    return services(request).hdWallets.getHdWallet(id);
  });

  app.patch('/api/v1/hd-wallets/:id', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, STATUS_FIELDS);

    const status = requireString(body.status, 'status', { max: 16 });

    if (!HD_WALLET_STATUS_VALUES.includes(status)) {
      throw badRequest('status must be active, disabled or archived');
    }

    return services(request).hdWallets.updateStatus(id, status);
  });

  /**
   * One-time recovery phrase provisioning.
   */
  app.post(
    '/api/v1/hd-wallets/:id/recovery-phrase/consume',
    { preHandler: recoveryLimiter },
    async (request, reply) => {
      const id = parsePositiveId(request.params.id, 'id');
      const body = requireObject(request.body ?? {}, 'body');
      rejectUnknownKeys(body, RECOVERY_FIELDS);

      const result = await services(request).hdWallets.consumeRecoveryPhrase({
        hdWalletId: id,
        token: requireString(body.token, 'token', { min: 32, max: 2048 }),
        confirm: requireBoolean(body.confirm, 'confirm')
      });

      reply.header('Cache-Control', 'no-store');
      reply.header('Pragma', 'no-cache');

      return result;
    }
  );

  app.get('/api/v1/hd-wallets/:id/accounts', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const limit = request.query.limit === undefined ? undefined : Number(request.query.limit);
    const offset = request.query.offset === undefined ? undefined : Number(request.query.offset);

    return services(request).childWallets.listAccounts(id, {
      limit: limit ?? undefined,
      offset: offset ?? undefined
    });
  });

  app.post(
    '/api/v1/hd-wallets/:id/accounts',
    { preHandler: batchLimiter },
    async (request, reply) => {
      const id = parsePositiveId(request.params.id, 'id');
      const body = requireObject(request.body ?? {}, 'body');
      rejectUnknownKeys(body, CREATE_ACCOUNT_FIELDS);

      const count = body.count === undefined
        ? 1
        : requireSafeInteger(body.count, 'count', { min: 1, max: MAX_BATCH_SIZE });

      const hdWallets = services(request).hdWallets;
      const result = await services(request).childWallets.createAccounts(id, {
        count,
        resolveMnemonic: () => hdWallets.revealMnemonicForSigning(id)
      });

      return reply.code(201).send({
        hdWalletId: result.hdWalletId,
        nextAccountIndex: result.nextAccountIndex,
        accounts: result.accounts
      });
    }
  );

  app.post(
    '/api/v1/hd-wallets/:id/accounts/batch',
    { preHandler: batchLimiter },
    async (request, reply) => {
      const id = parsePositiveId(request.params.id, 'id');
      const body = requireObject(request.body ?? {}, 'body');
      rejectUnknownKeys(body, CREATE_ACCOUNT_FIELDS);

      const count = requireSafeInteger(body.count, 'count', { min: 1, max: MAX_BATCH_SIZE });

      const hdWallets = services(request).hdWallets;
      const result = await services(request).childWallets.createAccounts(id, {
        count,
        resolveMnemonic: () => hdWallets.revealMnemonicForSigning(id)
      });

      return reply.code(201).send({
        hdWalletId: result.hdWalletId,
        nextAccountIndex: result.nextAccountIndex,
        accounts: result.accounts
      });
    }
  );

  app.get('/api/v1/hd-wallets/:id/accounts/:accountIndex', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const accountIndex = Number(request.params.accountIndex);

    return services(request).childWallets.getAccountAtIndex(id, accountIndex);
  });

  app.get('/api/v1/hd-wallets/:id/balance', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');

    return services(request).balances.getHdWalletBalance(id);
  });

  app.get('/api/v1/hd-wallets/:id/transactions', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');

    return services(request).transactions.listHdWalletTransactions(id, {
      limit: parseListLimit(request.query.limit, 20, 100, 'limit'),
      offset: parseListOffset(request.query.offset)
    });
  });

  /**
   * Deterministic recovery check: which address would index N have?
   */
  app.get('/api/v1/hd-wallets/:id/derive/:accountIndex', async (request) => {
    const id = parsePositiveId(request.params.id, 'id');
    const parsedIndex = /^\d{1,10}$/.test(request.params.accountIndex)
      ? Number(request.params.accountIndex)
      : NaN;
    const accountIndex = requireSafeInteger(parsedIndex, 'accountIndex', {
      min: 0,
      max: 2_147_483_647
    });

    return services(request).hdWallets.deriveAccountPreview(id, accountIndex);
  });

  app.patch('/api/v1/wallets/:publicKey/status', async (request) => {
    const publicKey = requireString(request.params.publicKey, 'publicKey', { max: 44 });
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, STATUS_FIELDS);

    const status = requireString(body.status, 'status', { max: 16 });

    if (!ACCOUNT_STATUS_VALUES.includes(status)) {
      throw badRequest('status must be active, disabled or archived');
    }

    return services(request).childWallets.setAccountStatus(publicKey, status);
  });
}
