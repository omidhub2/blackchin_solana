/**
 * Persistent cursor state for the native SOL deposit scanner.
 *
 * One row per (network, scope). `scope` identifies what is watched, e.g.
 * `all` (every HD child + standalone wallet on that network) or
 * `hd:<id>` for a single root.
 */
import crypto from 'node:crypto';

const CURSOR_COLUMNS = `
  id,
  network,
  scope,
  last_signature,
  last_slot,
  last_block_time,
  last_run_at,
  last_error,
  status,
  created_at,
  updated_at
`;

const SCOPE_PATTERN = /^(?:all|hd:\d+|account:[1-9A-HJ-NP-Za-km-z]{32,44})$/;

export function assertScope(scope) {
  if (typeof scope !== 'string' || !SCOPE_PATTERN.test(scope)) {
    throw new TypeError('Invalid scanner scope');
  }

  return scope;
}

function mapCursor(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    network: row.network,
    scope: row.scope,
    lastSignature: row.last_signature,
    lastSlot: row.last_slot === null ? null : Number(row.last_slot),
    lastBlockTime: row.last_block_time,
    lastRunAt: row.last_run_at,
    lastError: row.last_error,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Create the cursor row if missing and return it.
 */
export async function ensureCursor(db, { network, scope, runAt = null }) {
  assertScope(scope);

  const result = await db.query(
    `
      INSERT INTO deposit_scanner_cursors (network, scope, last_run_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (network, scope) DO NOTHING
      RETURNING ${CURSOR_COLUMNS}
    `,
    [network, scope, runAt]
  );

  if (result.rowCount === 1) {
    return mapCursor(result.rows[0]);
  }

  return findCursor(db, { network, scope });
}

export async function findCursor(db, { network, scope }) {
  assertScope(scope);

  const result = await db.query(
    `
      SELECT ${CURSOR_COLUMNS}
      FROM deposit_scanner_cursors
      WHERE network = $1 AND scope = $2
      LIMIT 1
    `,
    [network, scope]
  );

  return mapCursor(result.rows[0]);
}

/**
 * Mark the scan as running. Fails closed when another scanner already owns
 * the row in this process cluster (status is advisory only; the outbox-style
 * `FOR UPDATE SKIP LOCKED` claim is used by the worker itself).
 */
export async function markCursorRunning(db, cursorId, runAt = null) {
  const result = await db.query(
    `
      UPDATE deposit_scanner_cursors
      SET status = 'running', last_run_at = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${CURSOR_COLUMNS}
    `,
    [cursorId, runAt]
  );

  return mapCursor(result.rows[0]);
}

/**
 * Advance the cursor. This is the ONLY place a cursor moves forward, and it is
 * called after the corresponding transaction has been persisted.
 */
export async function advanceCursor(db, cursorId, { lastSignature, lastSlot, lastBlockTime }) {
  const result = await db.query(
    `
      UPDATE deposit_scanner_cursors
      SET status = 'idle',
          last_signature = $2,
          last_slot = $3,
          last_block_time = $4,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${CURSOR_COLUMNS}
    `,
    [cursorId, lastSignature, lastSlot ?? null, lastBlockTime ?? null]
  );

  return mapCursor(result.rows[0]);
}

export async function markCursorError(db, cursorId, message) {
  const result = await db.query(
    `
      UPDATE deposit_scanner_cursors
      SET status = 'error', last_error = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${CURSOR_COLUMNS}
    `,
    [cursorId, String(message ?? 'unknown error').slice(0, 500)]
  );

  return mapCursor(result.rows[0]);
}

/**
 * Try to become the single scanner for (network, scope) across instances.
 *
 * Uses a PostgreSQL session-level advisory lock held on a dedicated client for
 * the lifetime of the scan run. Returns `null` when another instance holds it.
 */
export async function acquireScannerLock(client, { network, scope }) {
  const lockId = scannerLockId(network, scope);
  const result = await client.query('SELECT pg_try_advisory_lock($1) AS acquired', [lockId]);

  return result.rows[0]?.acquired === true
    ? {
      release: async () => {
        await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => { });
      }
    }
    : null;
}

/**
 * Stable 63-bit advisory lock id derived from network + scope.
 */
export function scannerLockId(network, scope) {
  const digest = crypto
    .createHash('sha256')
    .update(`deposit-scanner:${network}:${scope}`, 'utf8')
    .digest();

  return digest.readBigInt64BE(0) & 0x7fffffffffffffffn;
}
