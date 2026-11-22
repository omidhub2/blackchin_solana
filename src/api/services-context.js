/**
 * Route dependency resolution.
 *
 * Routes receive their services via an injected request context
 * (`app.decorateRequest('services', ...)`), so the API can be tested with
 * fake services and PostgreSQL/Solana are not required for unit tests.
 */
export function getServices(app, request) {
  const services = request?.services ?? app.services;

  if (!services) {
    const error = new Error('Services are not configured for this server instance');
    error.statusCode = 500;
    throw error;
  }

  return services;
}
