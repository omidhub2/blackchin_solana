/**
 * Fixed-window in-memory rate limiter for sensitive endpoints.
 *
 * Scope: a single API process. For multi-instance deployments put a shared
 * limiter (API gateway / Redis) in front; this guard only protects against
 * accidental or abusive retry storms reaching one node.
 */
import { tooManyRequests } from '../../core/errors.js';

export function createRateLimiter({
  limit,
  windowMs,
  now = () => Date.now()
}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Rate limiter limit must be a positive integer');
  }

  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Rate limiter window must be a positive integer');
  }

  const buckets = new Map();

  function sweep(current) {
    for (const [key, bucket] of buckets) {
      if (bucket.resetAt <= current) {
        buckets.delete(key);
      }
    }
  }

  return Object.freeze({
    /**
     * Consume one unit for `key`.
     * @returns {{ allowed: boolean, remaining: number, resetAt: number }}
     */
    consume(key) {
      const current = now();
      let bucket = buckets.get(key);

      if (!bucket || bucket.resetAt <= current) {
        if (buckets.size > 10_000) sweep(current);
        bucket = { count: 0, resetAt: current + windowMs };
        buckets.set(key, bucket);
      }

      bucket.count += 1;

      return {
        allowed: bucket.count <= limit,
        remaining: Math.max(0, limit - bucket.count),
        resetAt: bucket.resetAt
      };
    },

    reset() {
      buckets.clear();
    }
  });
}

/**
 * Fastify preHandler that applies an in-memory limiter per route+client.
 */
export function rateLimitHook({ limit, windowMs, keyPrefix = 'rl' }) {
  const limiter = createRateLimiter({ limit, windowMs });

  return async function rateLimit(request) {
    const result = limiter.consume(`${keyPrefix}:${request.ip}`);

    if (!result.allowed) {
      throw tooManyRequests(
        `Rate limit exceeded; retry after ${new Date(result.resetAt).toISOString()}`
      );
    }
  };
}
