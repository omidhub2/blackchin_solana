import { authenticateApiCredential } from '../../infrastructure/database/tenant.repository.js';
import { createTenantScopedDatabase } from '../../infrastructure/security/tenant-context.js';

function unauthorized(reply) {
  return reply.code(401).send({
    error: 'UNAUTHORIZED',
    message: 'A valid tenant API credential is required'
  });
}

/**
 * Authenticate on the privileged control-plane connection, then replace the
 * request service container with services backed exclusively by a signed,
 * request-scoped tenant database facade. Tenant routes never receive the
 * control-plane pool.
 */
export function createTenantAuthHook({
  db,
  tenantPool,
  contextSigner,
  createTenantServices
}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required for tenant authentication');
  }

  return async function requireTenantCredential(request, reply) {
    const supplied = request.headers['x-api-key'];
    if (typeof supplied !== 'string') return unauthorized(reply);

    const identity = await authenticateApiCredential(db, supplied);
    if (!identity) return unauthorized(reply);

    if (!tenantPool || !contextSigner || typeof createTenantServices !== 'function') {
      return reply.code(503).send({
        error: 'TENANT_API_UNAVAILABLE',
        message: 'Tenant-isolated database access is not configured'
      });
    }

    const tenant = Object.freeze({
      id: identity.tenant.id,
      code: identity.tenant.tenantCode,
      status: identity.tenant.status,
      credentialId: identity.credential.id,
      scopes: Object.freeze([...identity.credential.scopes])
    });

    const signedContext = contextSigner.create({
      tenantId: tenant.id,
      credentialId: tenant.credentialId
    });
    const tenantDb = createTenantScopedDatabase(tenantPool, signedContext);

    request.tenant = tenant;
    request.services = createTenantServices(tenantDb, tenant);

    // The service container is request-local and carries no admin connection.
    if (!request.services?.deps?.db || request.services.deps.db !== tenantDb) {
      throw new Error('Tenant service container is not bound to the scoped database');
    }
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
