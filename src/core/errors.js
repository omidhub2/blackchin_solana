/**
 * Common error helper: errors carry an HTTP status code so the Fastify error
 * handler can map domain failures to responses without leaking internals.
 */
export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;

    if (details !== undefined) {
      this.details = details;
    }
  }
}

export function badRequest(message, code = 'INVALID_REQUEST', details) {
  return new AppError(message, 400, code, details);
}

export function unauthorized(message = 'Unauthorized') {
  return new AppError(message, 401, 'UNAUTHORIZED');
}

export function notFound(message = 'Resource not found', code = 'NOT_FOUND') {
  return new AppError(message, 404, code);
}

export function conflict(message, code = 'CONFLICT') {
  return new AppError(message, 409, code);
}

export function tooManyRequests(message = 'Too many requests') {
  return new AppError(message, 429, 'RATE_LIMITED');
}

export function serviceUnavailable(message = 'Service temporarily unavailable', code = 'SERVICE_UNAVAILABLE') {
  return new AppError(message, 503, code);
}

/**
 * Map a PostgreSQL unique-violation error into a 409 conflict.
 */
export function mapUniqueViolation(error, message, code = 'DUPLICATE') {
  if (error?.code === '23505') {
    return new AppError(message, 409, code);
  }

  return error;
}
