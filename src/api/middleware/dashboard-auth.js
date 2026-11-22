/**
 * Dashboard session + CSRF guard. Partner API keys are never accepted here.
 */
import { CSRF_HEADER, SESSION_COOKIE, parseCookies } from '../../core/dashboard/dashboard-auth.service.js';

function unauthorized(reply) {
  return reply.code(401).send({
    error: 'DASHBOARD_UNAUTHORIZED',
    message: 'A valid dashboard session is required'
  });
}

export function createDashboardAuthHook({ getAuthService }) {
  if (typeof getAuthService !== 'function') {
    throw new TypeError('A dashboard auth service resolver is required');
  }

  return async function requireDashboardSession(request, reply) {
    const auth = getAuthService(request);

    if (!auth) {
      return reply.code(503).send({
        error: 'DASHBOARD_UNAVAILABLE',
        message: 'Dashboard authentication is not configured'
      });
    }

    const cookies = parseCookies(request.headers.cookie);
    const token = cookies[SESSION_COOKIE];
    const session = await auth.authenticate(token);

    if (!session) return unauthorized(reply);

    request.dashboard = Object.freeze({
      sessionId: session.sessionId,
      csrfTokenHash: session.csrfTokenHash,
      expiresAt: session.expiresAt,
      user: session.user
    });

    const method = String(request.method ?? 'GET').toUpperCase();

    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      const supplied = request.headers[CSRF_HEADER];

      if (!auth.verifyCsrf(session, supplied)) {
        return reply.code(403).send({
          error: 'CSRF_VALIDATION_FAILED',
          message: 'A valid CSRF token is required for this operation'
        });
      }
    }
  };
}

export function requireDashboardRole(...roles) {
  const allowed = new Set(roles);

  return async function dashboardRoleGuard(request, reply) {
    if (!request.dashboard?.user) {
      return reply.code(401).send({
        error: 'DASHBOARD_UNAUTHORIZED',
        message: 'A valid dashboard session is required'
      });
    }

    if (!allowed.has(request.dashboard.user.role)) {
      return reply.code(403).send({
        error: 'INSUFFICIENT_ROLE',
        message: 'This dashboard role is not permitted to perform the operation'
      });
    }
  };
}