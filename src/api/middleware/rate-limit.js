/**
 * Distributed rate limiting.
 *
 * - `PostgresRateLimiter` stores fixed-window counters in `rate_limit_counters`
 *   and increments them in a single atomic UPSERT, so N API instances share one
 *   budget.
 * - `createRateLimiter` (the previous in-memory implementation) is retained as
 *   the local/development fallback and for tests.
 * - Sensitive routes fail closed when the shared store is unavailable; low-risk
 *   read routes may fall back locally (`failClosed: false`).
 *
 * Keys are hashes of `route:ip`. Raw API keys are never used as cache keys and
 * never logged.
 */
import crypto from 'node:crypto';

import { AppError, tooManyRequests } from '../../core/errors.js';

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
    backend: 'memory',

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

function hashKey(value) {
  return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').slice(0, 48);
}

/**
 * Fixed-window counter in PostgreSQL.
 *
 * The UPSERT is a single statement: either it inserts a fresh window or it
 * increments the existing one; `window_ends_at` is reset when the old window
 * has expired. That keeps it atomic without an explicit transaction.
 */
export function createPostgresRateLimiter({ db, limit, windowMs, prefix = 'rl', now = () => Date.now() }) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database executor is required');
  }

  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError('Rate limiter limit must be a positive integer');
  }

  if (!Number.isSafeInteger(windowMs) || windowMs < 1) {
    throw new TypeError('Rate limiter window must be a positive integer');
  }

  return Object.freeze({
    backend: 'postgres',

    async consume(clientKey) {
      const bucketKey = `${prefix}:${hashKey(clientKey)}`;
      const current = new Date(now());
      const expiresAt = new Date(current.getTime() + windowMs);

      const result = await db.query(
        `
          INSERT INTO rate_limit_counters AS c
            (bucket_key, window_started_at, window_ends_at, hit_count, updated_at)
          VALUES ($1, $2, $3, 1, $2)
          ON CONFLICT (bucket_key) DO UPDATE
          SET hit_count = CASE
                WHEN c.window_ends_at <= $2 THEN 1
                ELSE c.hit_count + 1
              END,
              window_started_at = CASE
                WHEN c.window_ends_at <= $2 THEN $2
                ELSE c.window_started_at
              END,
              window_ends_at = CASE
                WHEN c.window_ends_at <= $2 THEN $3
                ELSE c.window_ends_at
              END,
              updated_at = $2
          RETURNING hit_count, window_ends_at
        `,
        [bucketKey, current, expiresAt]
      );

      const row = result.rows[0];
      const hitCount = Number(row.hit_count);
      const resetAt = new Date(row.window_ends_at).getTime();

      return {
        allowed: hitCount <= limit,
        remaining: Math.max(0, limit - hitCount),
        resetAt
      };
    },

    /**
     * Opportunistic cleanup of expired windows (safe to call periodically).
     */
    async sweep() {
      await db.query('DELETE FROM rate_limit_counters WHERE window_ends_at <= NOW()');
    }
  });
}

/**
 * Fastify preHandler factory.
 *
 * @param {{ limit: number, windowMs: number, keyPrefix?: string,
 *           distributed?: { db: object } | null, failClosed?: boolean,
 *           localFallback?: boolean }} options
 */
export function rateLimitHook({
  limit,
  windowMs,
  keyPrefix = 'rl',
  distributed = null,
  failClosed = true,
  localFallback = true
}) {
  const local = localFallback ? createRateLimiter({ limit, windowMs }) : null;

  // The shared limiter is resolved lazily: production passes `{ db }`, while
  // tests and the import-time route registry pass `null`.
  const sharedCache = { limiter: null };

  function getShared() {
    if (!distributed) return null;

    if (!sharedCache.limiter) {
      const db = typeof distributed === 'function' ? distributed() : distributed.db;

      sharedCache.limiter = db
        ? createPostgresRateLimiter({ db, limit, windowMs, prefix: keyPrefix })
        : null;
    }

    return sharedCache.limiter;
  }

  return async function rateLimit(request) {
    const clientKey = `${keyPrefix}:${request.ip}`;
    const shared = getShared();

    if (shared) {
      try {
        const result = await shared.consume(clientKey);

        if (!result.allowed) {
          throw tooManyRequests(
            `Rate limit exceeded; retry after ${new Date(result.resetAt).toISOString()}`
          );
        }

        return;
      } catch (error) {
        if (error instanceof AppError) throw error;

        // Shared store unavailable.
        if (failClosed) {
          const unavailable = new AppError(
            'Rate limiting backend unavailable; request rejected',
            503,
            'RATE_LIMITER_UNAVAILABLE'
          );
          throw unavailable;
        }
      }
    }

    if (!local) return;

    const result = local.consume(clientKey);

    if (!result.allowed) {
      throw tooManyRequests(
        `Rate limit exceeded; retry after ${new Date(result.resetAt).toISOString()}`
      );
    }
  };
}
