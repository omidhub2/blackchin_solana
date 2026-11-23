/**
 * Platform operations dashboard API.
 *
 * Authenticated with a dashboard session cookie (never a partner API key).
 * Read endpoints are available to every active dashboard role; operational
 * mutations require operator/admin and a CSRF token.
 */
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  buildClearSessionCookies,
  buildCsrfCookie,
  buildSessionCookie,
  parseCookies
} from '../../core/dashboard/dashboard-auth.service.js';
import { createDashboardAuthHook, requireDashboardRole } from '../middleware/dashboard-auth.js';
import { rateLimitHook } from '../middleware/rate-limit.js';
import { getServices } from '../services-context.js';
import {
  parseListLimit,
  parseListOffset,
  rejectUnknownKeys,
  requireObject,
  requireString,
  requireSafeInteger,
  requirePublicKey,
  requireSolAmount
} from '../validation.js';
import { badRequest, notFound, mapUniqueViolation } from '../../core/errors.js';
import {
  hashTenantWithdrawalRequest,
  solToLamports
} from '../../core/withdrawals/tenant-withdrawal-policy.service.js';
import {
  listOperationalEvents,
  recordOperationalEventSafe
} from '../../infrastructure/database/operational-event.repository.js';
import { replayEvent } from '../../infrastructure/database/webhook-outbox.repository.js';
import {
  TENANT_API_SCOPES,
  createTenant,
  issueApiCredential,
  revokeApiCredential,
  updateTenantStatus
} from '../../infrastructure/database/tenant.repository.js';

function parseTenantId(value) {
  return requireSafeInteger(Number(value), 'tenantId', { min: 1, max: Number.MAX_SAFE_INTEGER });
}

function parseOptionalTenantId(value) {
  if (value === undefined || value === null || value === '') return null;
  return parseTenantId(value);
}

function secureCookies() {
  return process.env.DASHBOARD_COOKIE_SECURE === 'true' || process.env.NODE_ENV === 'production';
}

export async function dashboardRoutes(app) {
  const services = (request) => getServices(app, request);
  const authService = () => app.services?.dashboardAuth ?? null;
  const db = () => app.services?.deps?.db ?? null;

  const authHook = createDashboardAuthHook({ getAuthService: authService });
  const operatorGuard = requireDashboardRole('admin', 'operator');
  const adminGuard = requireDashboardRole('admin');

  const distributed = app.services?.deps?.db ? { db: app.services.deps.db } : null;
  const loginLimiter = rateLimitHook({
    limit: 10,
    windowMs: 60_000,
    keyPrefix: 'dashboard-login',
    distributed
  });
  const mutationLimiter = rateLimitHook({
    limit: 30,
    windowMs: 60_000,
    keyPrefix: 'dashboard-mutation',
    distributed
  });

  // -------------------------------------------------------------------------
  // Authentication
  // -------------------------------------------------------------------------

  app.post('/auth/login', { preHandler: loginLimiter }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['email', 'password']);
    const email = requireString(body.email, 'email', { min: 3, max: 320 });
    const password = requireString(body.password, 'password', { min: 1, max: 256 });

    const auth = authService(request);
    if (!auth) {
      return reply.code(503).send({
        error: 'DASHBOARD_UNAVAILABLE',
        message: 'Dashboard authentication is not configured'
      });
    }

    const session = await auth.login({ email, password });
    const ttlSeconds = Math.max(60, Math.floor((new Date(session.expiresAt).getTime() - Date.now()) / 1000));

    reply.header('Set-Cookie', [
      buildSessionCookie(session.token, { maxAgeSeconds: ttlSeconds, secure: secureCookies() }),
      buildCsrfCookie(session.csrfToken, { maxAgeSeconds: ttlSeconds, secure: secureCookies() })
    ]);
    reply.header('Cache-Control', 'no-store');

    return {
      user: session.user,
      csrfToken: session.csrfToken,
      expiresAt: session.expiresAt
    };
  });

  app.post('/auth/logout', { preHandler: [authHook, mutationLimiter] }, async (request, reply) => {
    const auth = authService(request);
    const cookies = parseCookies(request.headers.cookie);
    await auth.logout(cookies[SESSION_COOKIE]);
    reply.header('Set-Cookie', buildClearSessionCookies());
    return { loggedOut: true };
  });

  app.get('/auth/session', { preHandler: authHook }, async (request, reply) => {
    const cookies = parseCookies(request.headers.cookie);
    reply.header('Cache-Control', 'no-store');
    return {
      user: request.dashboard.user,
      expiresAt: request.dashboard.expiresAt,
      csrfToken: cookies[CSRF_COOKIE] ?? null
    };
  });

  // -------------------------------------------------------------------------
  // Read models
  // -------------------------------------------------------------------------

  app.get('/overview', { preHandler: authHook }, async (request) => {
    const range = request.query.range;
    if (range !== undefined && !['24h', '7d', '30d'].includes(range)) {
      throw badRequest('range must be 24h, 7d or 30d', 'INVALID_RANGE');
    }
    return services(request).dashboard.overview({ range });
  });

  app.get('/wallets', { preHandler: authHook }, async (request) => {
    const type = request.query.type ?? 'hd';
    if (!['hd', 'child', 'hot'].includes(type)) {
      throw badRequest('type must be hd, child or hot', 'INVALID_WALLET_TYPE');
    }
    return services(request).dashboard.wallets({
      type,
      limit: parseListLimit(request.query.limit, 50, 200),
      offset: parseListOffset(request.query.offset),
      tenantId: parseOptionalTenantId(request.query.tenantId)
    });
  });

  app.get('/addresses', { preHandler: authHook }, async (request) => services(request).dashboard.addresses({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset),
    tenantId: parseOptionalTenantId(request.query.tenantId)
  }));

  app.get('/deposits', { preHandler: authHook }, async (request) => services(request).dashboard.deposits({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset),
    status: request.query.status ?? null,
    tenantId: parseOptionalTenantId(request.query.tenantId)
  }));

  app.get('/withdrawals', { preHandler: authHook }, async (request) => services(request).dashboard.withdrawals({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset),
    status: request.query.status ?? null,
    tenantId: parseOptionalTenantId(request.query.tenantId)
  }));

  app.get('/transactions', { preHandler: authHook }, async (request) => services(request).dashboard.transactions({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset),
    status: request.query.status ?? null,
    tenantId: parseOptionalTenantId(request.query.tenantId)
  }));

  app.get('/activity', { preHandler: authHook }, async (request) => services(request).dashboard.activity({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset)
  }));

  app.get('/webhooks', { preHandler: authHook }, async (request) => services(request).dashboard.webhooks({
    limit: parseListLimit(request.query.limit, 50, 200),
    offset: parseListOffset(request.query.offset),
    status: request.query.status ?? null
  }));

  app.get('/webhooks/endpoints', { preHandler: authHook }, async (request) => {
    const tenantId = parseTenantId(request.query.tenantId);
    return {
      items: await services(request).webhookEndpoints.list(tenantId, {
        limit: parseListLimit(request.query.limit, 50, 200),
        offset: parseListOffset(request.query.offset)
      })
    };
  });

  app.get('/credentials', { preHandler: authHook }, async (request) => services(request).dashboard.credentials({
    limit: parseListLimit(request.query.limit, 100, 200),
    offset: parseListOffset(request.query.offset)
  }));

  app.get('/tenants', { preHandler: authHook }, async (request) => services(request).dashboard.tenants({
    limit: parseListLimit(request.query.limit, 100, 200),
    offset: parseListOffset(request.query.offset)
  }));

  app.post('/tenants', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantCode', 'displayName']);
    const tenantCode = requireString(body.tenantCode, 'tenantCode', {
      min: 2, max: 64, pattern: /^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/
    });
    const displayName = requireString(body.displayName, 'displayName', { min: 1, max: 160 });

    let tenant;
    try {
      tenant = await createTenant(db(), { tenantCode, displayName });
    } catch (error) {
      throw mapUniqueViolation(error, 'A tenant with this code already exists', 'TENANT_CODE_CONFLICT');
    }

    await recordOperationalEventSafe(db(), {
      eventType: 'tenant.created',
      tenantId: tenant.id,
      payload: {
        tenantCode: tenant.tenantCode,
        displayName: tenant.displayName,
        status: tenant.status,
        createdBy: request.dashboard.user.email
      }
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ tenant });
  });

  app.put('/tenants/:tenantId/status', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['status']);
    const status = requireString(body.status, 'status', { min: 1, max: 16 });
    if (!['active', 'suspended', 'disabled'].includes(status)) {
      throw badRequest('status must be active, suspended or disabled', 'INVALID_TENANT_STATUS');
    }
    const tenant = await updateTenantStatus(db(), parseTenantId(request.params.tenantId), status);
    if (!tenant) throw notFound('Tenant not found', 'TENANT_NOT_FOUND');

    await recordOperationalEventSafe(db(), {
      eventType: 'tenant.status_changed',
      tenantId: tenant.id,
      payload: {
        status: tenant.status,
        updatedBy: request.dashboard.user.email
      }
    });
    return { tenant };
  });

  app.get('/security', { preHandler: authHook }, async (request) => services(request).dashboard.security({
    limit: parseListLimit(request.query.limit, 100, 200),
    offset: parseListOffset(request.query.offset)
  }));

  app.get('/network', { preHandler: authHook }, async (request) => services(request).dashboard.network());

  // -------------------------------------------------------------------------
  // Tenant withdrawal policy control plane (admin-only mutations)
  // -------------------------------------------------------------------------

  app.get('/tenants/:tenantId/withdrawal-policy', { preHandler: authHook }, async (request) =>
    services(request).tenantWithdrawalPolicy.getPolicy(parseTenantId(request.params.tenantId))
  );

  app.put('/tenants/:tenantId/withdrawal-policy', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, [
      'enabled', 'maxSingleLamports', 'maxDailyLamports', 'maxWeeklyLamports',
      'maxDailyCount', 'maxWeeklyCount'
    ]);
    if (typeof body.enabled !== 'boolean') {
      throw badRequest('enabled must be a boolean', 'INVALID_WITHDRAWAL_POLICY');
    }
    const result = await services(request).tenantWithdrawalPolicy.configurePolicy({
      tenantId: parseTenantId(request.params.tenantId),
      enabled: body.enabled,
      maxSingleLamports: requireString(String(body.maxSingleLamports ?? ''), 'maxSingleLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxDailyLamports: requireString(String(body.maxDailyLamports ?? ''), 'maxDailyLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxWeeklyLamports: requireString(String(body.maxWeeklyLamports ?? ''), 'maxWeeklyLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxDailyCount: requireSafeInteger(Number(body.maxDailyCount), 'maxDailyCount', { min: 1, max: 1_000_000 }),
      maxWeeklyCount: requireSafeInteger(Number(body.maxWeeklyCount), 'maxWeeklyCount', { min: 1, max: 1_000_000 }),
      updatedBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.policy_configured',
      tenantId: result.tenantId,
      payload: { enabled: result.enabled, policyVersion: result.policyVersion, updatedBy: result.updatedBy }
    });
    return result;
  });

  app.patch('/tenants/:tenantId/withdrawal-policy', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, [
      'enabled', 'maxSingleLamports', 'maxDailyLamports', 'maxWeeklyLamports',
      'maxDailyCount', 'maxWeeklyCount'
    ]);
    if (typeof body.enabled !== 'boolean') {
      throw badRequest('enabled must be a boolean', 'INVALID_WITHDRAWAL_POLICY');
    }
    const result = await services(request).tenantWithdrawalPolicy.updatePolicy({
      tenantId: parseTenantId(request.params.tenantId),
      enabled: body.enabled,
      maxSingleLamports: requireString(String(body.maxSingleLamports ?? ''), 'maxSingleLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxDailyLamports: requireString(String(body.maxDailyLamports ?? ''), 'maxDailyLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxWeeklyLamports: requireString(String(body.maxWeeklyLamports ?? ''), 'maxWeeklyLamports', {
        min: 1, max: 30, pattern: /^[1-9]\d{0,29}$/
      }),
      maxDailyCount: requireSafeInteger(Number(body.maxDailyCount), 'maxDailyCount', { min: 1, max: 1_000_000 }),
      maxWeeklyCount: requireSafeInteger(Number(body.maxWeeklyCount), 'maxWeeklyCount', { min: 1, max: 1_000_000 }),
      updatedBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.policy_configured',
      tenantId: result.tenantId,
      payload: { enabled: result.enabled, policyVersion: result.policyVersion, updatedBy: result.updatedBy, edited: true }
    });
    return result;
  });

  app.delete('/tenants/:tenantId/withdrawal-policy', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const result = await services(request).tenantWithdrawalPolicy.deletePolicy({
      tenantId: parseTenantId(request.params.tenantId)
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.policy_deleted',
      tenantId: result.tenantId,
      payload: { deletedBy: request.dashboard.user.email }
    });
    return result;
  });

  app.post('/tenants/:tenantId/withdrawal-policy/freeze', {
    preHandler: [authHook, operatorGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['reason']);
    const result = await services(request).tenantWithdrawalPolicy.freeze({
      tenantId: parseTenantId(request.params.tenantId),
      reason: requireString(body.reason, 'reason', { min: 1, max: 500 }),
      updatedBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.policy_frozen',
      tenantId: result.tenantId,
      payload: { reason: result.freezeReason, policyVersion: result.policyVersion }
    });
    return result;
  });

  app.post('/tenants/:tenantId/withdrawal-policy/unfreeze', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, []);
    const result = await services(request).tenantWithdrawalPolicy.unfreeze({
      tenantId: parseTenantId(request.params.tenantId),
      updatedBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.policy_unfrozen',
      tenantId: result.tenantId,
      payload: { policyVersion: result.policyVersion, updatedBy: request.dashboard.user.email }
    });
    return result;
  });

  app.get('/tenants/:tenantId/withdrawal-destinations', { preHandler: authHook }, async (request) => ({
    items: await services(request).tenantWithdrawalPolicy.listDestinations(
      parseTenantId(request.params.tenantId)
    )
  }));

  app.post('/tenants/:tenantId/withdrawal-destinations', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['network', 'destinationPublicKey', 'label']);
    const network = requireString(body.network, 'network', { min: 5, max: 16 });
    if (!['devnet', 'testnet', 'mainnet-beta'].includes(network)) {
      throw badRequest('Unsupported Solana network', 'INVALID_NETWORK');
    }
    const destination = await services(request).tenantWithdrawalPolicy.addDestination({
      tenantId: parseTenantId(request.params.tenantId),
      network,
      destinationPublicKey: requirePublicKey(body.destinationPublicKey, 'destinationPublicKey'),
      label: body.label === undefined ? null : requireString(body.label, 'label', { max: 100 }),
      createdBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.destination_created',
      tenantId: destination.tenantId,
      network: destination.network,
      payload: { destinationId: destination.id, status: destination.status }
    });
    return reply.code(201).send({ destination });
  });

  app.post('/tenants/:tenantId/withdrawal-destinations/:destinationId/activate', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, []);
    const destination = await services(request).tenantWithdrawalPolicy.activateDestination({
      tenantId: parseTenantId(request.params.tenantId),
      destinationId: parseTenantId(request.params.destinationId),
      approvedBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.destination_activated',
      tenantId: destination.tenantId,
      network: destination.network,
      payload: { destinationId: destination.id, approvedBy: destination.approvedBy }
    });
    return { destination };
  });

  app.post('/tenants/:tenantId/withdrawal-destinations/:destinationId/revoke', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, []);
    const destination = await services(request).tenantWithdrawalPolicy.revokeDestination({
      tenantId: parseTenantId(request.params.tenantId),
      destinationId: parseTenantId(request.params.destinationId)
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.destination_revoked',
      tenantId: destination.tenantId,
      network: destination.network,
      payload: { destinationId: destination.id }
    });
    return { destination };
  });

  app.get('/tenants/:tenantId/withdrawal-approvals', { preHandler: authHook }, async (request) => ({
    items: await services(request).tenantWithdrawalPolicy.listApprovals(
      parseTenantId(request.params.tenantId)
    )
  }));

  app.post('/tenants/:tenantId/withdrawal-approvals/:approvalReference/revoke', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, []);
    const approval = await services(request).tenantWithdrawalPolicy.revokeApproval({
      tenantId: parseTenantId(request.params.tenantId),
      approvalReference: requireString(request.params.approvalReference, 'approvalReference', {
        min: 8, max: 128, pattern: /^[A-Za-z0-9._:-]+$/
      })
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.approval_revoked',
      tenantId: approval.tenantId,
      payload: { credentialId: approval.credentialId, approvalReference: approval.approvalReference }
    });
    return { approval };
  });

  app.post('/tenants/:tenantId/withdrawal-approvals', {
    preHandler: [authHook, adminGuard, mutationLimiter]
  }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, [
      'credentialId', 'approvalReference', 'walletPublicKey',
      'destinationPublicKey', 'network', 'amountSol', 'expiresInSeconds'
    ]);
    const network = requireString(body.network, 'network', { min: 5, max: 16 });
    if (!['devnet', 'testnet', 'mainnet-beta'].includes(network)) {
      throw badRequest('Unsupported Solana network', 'INVALID_NETWORK');
    }
    const amountSol = requireSolAmount(body.amountSol);
    const amountLamports = solToLamports(amountSol);
    const approvalReference = requireString(body.approvalReference, 'approvalReference', {
      min: 8, max: 128, pattern: /^[A-Za-z0-9._:-]+$/
    });
    const walletPublicKey = requirePublicKey(body.walletPublicKey, 'walletPublicKey');
    const destinationPublicKey = requirePublicKey(body.destinationPublicKey, 'destinationPublicKey');
    const expiresInSeconds = requireSafeInteger(Number(body.expiresInSeconds ?? 300), 'expiresInSeconds', {
      min: 60, max: 900
    });
    const approval = await services(request).tenantWithdrawalPolicy.issueApproval({
      tenantId: parseTenantId(request.params.tenantId),
      credentialId: parseTenantId(body.credentialId),
      approvalReference,
      requestHash: hashTenantWithdrawalRequest({
        fromPublicKey: walletPublicKey,
        toPublicKey: destinationPublicKey,
        amountLamports,
        network,
        approvalReference
      }),
      walletPublicKey,
      destinationPublicKey,
      amountLamports,
      network,
      expiresAt: new Date(Date.now() + expiresInSeconds * 1000),
      issuer: `dashboard:${request.dashboard.user.email}`
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'tenant_withdrawal.approval_issued',
      tenantId: approval.tenantId,
      network: approval.network,
      walletPublicKey: approval.walletPublicKey,
      payload: {
        credentialId: approval.credentialId,
        approvalReference: approval.approvalReference,
        destinationPublicKey: approval.destinationPublicKey,
        amountLamports: approval.amountLamports,
        expiresAt: approval.expiresAt
      }
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send({ approval });
  });

  // -------------------------------------------------------------------------
  // Operational mutations
  // -------------------------------------------------------------------------

  app.post('/hot-wallets', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId', 'publicKey', 'label', 'maxSingleLamports']);
    const wallet = await services(request).hotWallets.register({
      tenantId: parseTenantId(body.tenantId),
      publicKey: requireString(body.publicKey, 'publicKey', { min: 32, max: 44 }),
      label: body.label === undefined ? null : requireString(body.label, 'label', { max: 100 }),
      maxSingleLamports: body.maxSingleLamports === undefined
        ? '0'
        : requireString(String(body.maxSingleLamports), 'maxSingleLamports', { max: 30, pattern: /^\d+$/ }),
      createdBy: request.dashboard.user.email
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'hot_wallet.registered',
      tenantId: wallet.tenantId,
      network: wallet.network,
      walletPublicKey: wallet.publicKey,
      hdWalletId: wallet.hdWalletId,
      payload: { hotWalletId: wallet.id, label: wallet.label }
    });
    return reply.code(201).send({ wallet });
  });

  app.post('/tenants/:tenantId/hd-wallets', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['label', 'ownerId']);
    const result = await services(request).tenantWallets.createHdWallet({
      tenantId: parseTenantId(request.params.tenantId),
      label: body.label === undefined ? null : requireString(body.label, 'label', { max: 100 }),
      ownerId: body.ownerId === undefined ? null : requireString(body.ownerId, 'ownerId', {
        max: 64,
        pattern: /^[A-Za-z0-9._:-]+$/
      })
    });
    reply.header('Cache-Control', 'no-store');
    reply.header('Pragma', 'no-cache');
    return reply.code(201).send(result);
  });

  app.post('/tenants/:tenantId/hd-wallets/:id/accounts', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['count']);
    const count = body.count === undefined
      ? 1
      : requireSafeInteger(Number(body.count), 'count', { min: 1, max: 50 });
    const result = await services(request).tenantWallets.createAccounts(
      parseTenantId(request.params.tenantId),
      parseTenantId(request.params.id),
      { count }
    );
    return reply.code(201).send(result);
  });

  app.patch('/tenants/:tenantId/hd-wallets/:id', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['status']);
    return services(request).tenantWallets.updateStatus(
      parseTenantId(request.params.tenantId),
      parseTenantId(request.params.id),
      requireString(body.status, 'status', { max: 16 })
    );
  });

  app.post('/hot-wallets/:publicKey/freeze', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId', 'reason']);
    const wallet = await services(request).hotWallets.freeze(
      parseTenantId(body.tenantId),
      requireString(request.params.publicKey, 'publicKey', { min: 32, max: 44 }),
      requireString(body.reason, 'reason', { min: 1, max: 500 })
    );
    await recordOperationalEventSafe(db(), {
      eventType: 'hot_wallet.frozen',
      tenantId: wallet.tenantId,
      network: wallet.network,
      walletPublicKey: wallet.publicKey,
      payload: { reason: wallet.freezeReason }
    });
    return { wallet };
  });

  app.post('/hot-wallets/:publicKey/unfreeze', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId']);
    const wallet = await services(request).hotWallets.unfreeze(
      parseTenantId(body.tenantId),
      requireString(request.params.publicKey, 'publicKey', { min: 32, max: 44 })
    );
    await recordOperationalEventSafe(db(), {
      eventType: 'hot_wallet.unfrozen',
      tenantId: wallet.tenantId,
      network: wallet.network,
      walletPublicKey: wallet.publicKey,
      payload: {}
    });
    return { wallet };
  });

  app.post('/webhooks', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId', 'endpointUrl', 'eventTypes']);
    const result = await services(request).webhookEndpoints.create({
      tenantId: parseTenantId(body.tenantId),
      endpointUrl: requireString(body.endpointUrl, 'endpointUrl', { min: 8, max: 2048 }),
      eventTypes: body.eventTypes
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'webhook_endpoint.created',
      tenantId: result.endpoint.tenantId,
      payload: { endpointId: result.endpoint.id }
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(result);
  });

  app.post('/webhooks/:id/rotate', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId']);
    const result = await services(request).webhookEndpoints.rotateSecret({
      tenantId: parseTenantId(body.tenantId),
      id: requireString(request.params.id, 'id', { max: 19, pattern: /^\d+$/ })
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'webhook_endpoint.rotated',
      tenantId: result.endpoint.tenantId,
      payload: { endpointId: result.endpoint.id }
    });
    reply.header('Cache-Control', 'no-store');
    return result;
  });

  app.patch('/webhooks/:id', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId', 'status']);
    return {
      endpoint: await services(request).webhookEndpoints.setStatus({
        tenantId: parseTenantId(body.tenantId),
        id: requireString(request.params.id, 'id', { max: 19, pattern: /^\d+$/ }),
        status: requireString(body.status, 'status', { max: 16 })
      })
    };
  });

  app.post('/webhooks/events/:eventId/retry', { preHandler: [authHook, operatorGuard, mutationLimiter] }, async (request) => {
    const eventId = requireString(request.params.eventId, 'eventId', { max: 64 });
    const event = await replayEvent(db(), eventId);
    if (!event) {
      throw badRequest('Webhook event is not retryable', 'WEBHOOK_EVENT_NOT_RETRYABLE');
    }
    return { event };
  });

  app.post('/tenants/:tenantId/credentials', { preHandler: [authHook, adminGuard, mutationLimiter] }, async (request, reply) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['scopes', 'expiresAt']);
    if (!Array.isArray(body.scopes) || body.scopes.length === 0) {
      throw badRequest('scopes must be a non-empty array', 'INVALID_SCOPES');
    }
    for (const scope of body.scopes) {
      if (!TENANT_API_SCOPES.includes(scope)) {
        throw badRequest(`Unsupported scope: ${scope}`, 'INVALID_SCOPES');
      }
    }
    const expiresAt = body.expiresAt === undefined ? null : new Date(body.expiresAt);
    if (expiresAt !== null && Number.isNaN(expiresAt.getTime())) {
      throw badRequest('expiresAt must be a valid ISO date', 'INVALID_REQUEST');
    }
    const result = await issueApiCredential(db(), parseTenantId(request.params.tenantId), {
      scopes: body.scopes,
      expiresAt
    });
    await recordOperationalEventSafe(db(), {
      eventType: 'api_credential.issued',
      tenantId: request.params.tenantId,
      payload: { credentialId: result.credential.id, scopes: result.credential.scopes }
    });
    reply.header('Cache-Control', 'no-store');
    return reply.code(201).send(result);
  });

  app.post('/credentials/:credentialId/revoke', { preHandler: [authHook, adminGuard, mutationLimiter] }, async (request) => {
    const body = requireObject(request.body ?? {}, 'body');
    rejectUnknownKeys(body, ['tenantId']);
    const credential = await revokeApiCredential(
      db(),
      parseTenantId(body.tenantId),
      requireString(request.params.credentialId, 'credentialId', { max: 19, pattern: /^\d+$/ })
    );
    if (!credential) {
      throw badRequest('Active credential was not found', 'CREDENTIAL_NOT_FOUND');
    }
    await recordOperationalEventSafe(db(), {
      eventType: 'api_credential.revoked',
      tenantId: body.tenantId,
      payload: { credentialId: credential.id }
    });
    return { credential };
  });

  // -------------------------------------------------------------------------
  // Server-Sent Events stream (durable replay + heartbeat)
  // -------------------------------------------------------------------------

  app.get('/stream', { preHandler: authHook }, async (request, reply) => {
    const dashboard = services(request).dashboard;
    const eventDb = db();

    let snapshot;
    try {
      snapshot = await dashboard.overview({ range: '24h' });
    } catch {
      return reply.code(503).send({
        error: 'DASHBOARD_SNAPSHOT_UNAVAILABLE',
        message: 'Unable to build the initial dashboard snapshot'
      });
    }

    const headerCursor = Number(request.headers['last-event-id']);
    const queryCursor = Number(request.query.lastEventId);
    let cursor = Number.isSafeInteger(queryCursor) && queryCursor > 0
      ? queryCursor
      : Number.isSafeInteger(headerCursor) && headerCursor > 0
        ? headerCursor
        : snapshot.lastEventId;

    reply.hijack();
    const response = reply.raw;

    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no'
    });

    const write = (chunk) => {
      try {
        response.write(chunk);
      } catch {
        // Client disconnected between checks.
      }
    };

    const sendEvent = (id, eventName, data) => {
      write(`id: ${id}\nevent: ${eventName}\ndata: ${JSON.stringify(data)}\n\n`);
    };

    write('retry: 3000\n\n');
    sendEvent(cursor, 'snapshot', snapshot);

    let closed = false;
    let polling = false;

    const poll = async () => {
      if (closed || polling) return;
      polling = true;
      try {
        const events = await listOperationalEvents(eventDb, { afterId: cursor, limit: 100 });
        for (const event of events) {
          cursor = Number(event.id);
          sendEvent(cursor, 'operational', event);
        }
      } catch {
        write('event: stream_error\ndata: {"error":"EVENT_REPLAY_UNAVAILABLE"}\n\n');
      } finally {
        polling = false;
      }
    };

    const pollTimer = setInterval(poll, 2_000);
    const heartbeatTimer = setInterval(() => {
      write(`: heartbeat ${new Date().toISOString()}\n\n`);
    }, 15_000);

    const cleanup = () => {
      if (closed) return;
      closed = true;
      clearInterval(pollTimer);
      clearInterval(heartbeatTimer);
    };

    request.raw.on('close', cleanup);
    request.raw.on('error', cleanup);
  });

}