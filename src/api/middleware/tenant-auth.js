import { authenticateApiCredential } from '../../infrastructure/database/tenant.repository.js';

function unauthorized(reply) {
  return reply.code(401).send({
    error: 'UNAUTHORIZED',
    message: 'A valid tenant API credential is required'
  });
}

/**
 * Tenant authentication hook. It only establishes a trusted request.tenant
 * context; routes must still pass tenantId through every service/repository
 * operation before this hook is enabled on customer-facing endpoints.
 */
export function createTenantAuthHook({ db }) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required for tenant authentication');
  }

  return async function requireTenantCredential(request, reply) {
    const supplied = request.headers['x-api-key'];
    if (typeof supplied !== 'string') return unauthorized(reply);

    const identity = await authenticateApiCredential(db, supplied);
    if (!identity) return unauthorized(reply);

    request.tenant = Object.freeze({
      id: identity.tenant.id,
      code: identity.tenant.tenantCode,
      status: identity.tenant.status,
      credentialId: identity.credential.id,
      scopes: Object.freeze([...identity.credential.scopes])
    });
  };
}

export function requireTenantScope(scope) {
  if (typeof scope !== 'string' || !scope.trim()) {
    throw new TypeError('A non-empty tenant scope is required');
  }

  return async function tenantScopeGuard(request, reply) {
    if (!request.tenant || !Array.isArray(request.tenant.scopes)) {
      return reply.code(401).send({
        error: 'TENANT_CONTEXT_REQUIRED',
        message: 'Tenant authentication is required'
      });
    }

    if (!request.tenant.scopes.includes(scope)) {
      return reply.code(403).send({
        error: 'INSUFFICIENT_SCOPE',
        message: 'The API credential does not grant the required scope'
      });
    }
  };
}
