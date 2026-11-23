/**
 * Transactional outbox repository.
 *
 * Events are inserted in the same database transaction as the state change
 * they describe (see `emitEvent`), and delivered asynchronously with
 * at-least-once semantics. Payloads never contain secrets.
 */
import crypto from 'node:crypto';

export const OUTBOX_STATUSES = Object.freeze([
  'pending',
  'delivering',
  'delivered',
  'failed',
  'discarded'
]);

export const WEBHOOK_EVENT_TYPES = Object.freeze([
  'wallet.created',
  'wallet.child.created',
  'deposit.detected',
  'deposit.confirmed',
  'deposit.credited',
  'deposit.failed',
  'withdrawal.accepted',
  'withdrawal.created',
  'withdrawal.broadcast',
  'withdrawal.confirmed',
  'withdrawal.failed',
  'transaction.under_review',
  'transaction.status_changed'
]);

const OUTBOX_COLUMNS = `
  id,
  event_id,
  event_type,
  tenant_id,
  wallet_public_key,
  hd_wallet_id,
  network,
  payload,
  status,
  attempts,
  max_attempts,
  next_attempt_at,
  last_http_status,
  last_error,
  delivered_at,
  created_at,
  updated_at
`;

function mapOutboxRow(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    eventId: row.event_id,
    eventType: row.event_type,
    tenantId: row.tenant_id === null || row.tenant_id === undefined ? null : String(row.tenant_id),
    walletPublicKey: row.wallet_public_key,
    hdWalletId: row.hd_wallet_id === null || row.hd_wallet_id === undefined
      ? null
      : String(row.hd_wallet_id),
    network: row.network,
    payload: row.payload,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Validate an outgoing event payload.
 *
 * Rejects obviously sensitive field names so a future code path cannot leak a
 * mnemonic, private key or token into a third-party endpoint.
 */
const FORBIDDEN_KEY_PATTERN = /(mnemonic|phrase|private.?key|secret.?key|seed|token|api.?key|password|signature.?secret)/i;

export function assertPublishablePayload(value, depth = 0) {
  if (depth > 6) {
    throw new TypeError('Webhook payload is too deeply nested');
  }

  if (value === null || typeof value !== 'object') return;

  if (Array.isArray(value)) {
    for (const item of value) assertPublishablePayload(item, depth + 1);
    return;
  }

  for (const [key, item] of Object.entries(value)) {
    if (FORBIDDEN_KEY_PATTERN.test(key)) {
      throw new TypeError(`Refusing to publish sensitive webhook field: ${key}`);
    }

    assertPublishablePayload(item, depth + 1);
  }
}

/**
 * Emit an event inside the caller's transaction.
 *
 * @param {object} db pool or client (must be inside the state-change transaction)
 * @param {{ eventType: string, network: string, walletPublicKey?: string|null,
 *           hdWalletId?: string|null, payload: object, eventId?: string,
 *           maxAttempts?: number }} event
 */
export async function emitEvent(db, {
  eventType,
  network,
  tenantId = null,
  walletPublicKey = null,
  hdWalletId = null,
  payload,
  eventId = crypto.randomUUID(),
  maxAttempts = 8,
  returnMinimal = false
}) {
  if (!WEBHOOK_EVENT_TYPES.includes(eventType)) {
    throw new TypeError(`Unsupported webhook event type: ${eventType}`);
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Webhook payload must be an object');
  }

  assertPublishablePayload(payload);

  const result = await db.query(
    `
      INSERT INTO webhook_outbox (
        event_id, event_type, tenant_id, wallet_public_key, hd_wallet_id, network, payload, max_attempts
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8)
      ON CONFLICT (event_id) DO NOTHING
      RETURNING ${returnMinimal ? 'id, event_id' : OUTBOX_COLUMNS}
    `,
    [eventId, eventType, tenantId === null ? null : String(tenantId), walletPublicKey,
      hdWalletId, network, JSON.stringify(payload), maxAttempts]
  );

  const row = result.rows[0];
  return {
    created: result.rowCount === 1,
    event: returnMinimal
      ? (row ? { id: String(row.id), eventId: row.event_id } : null)
      : mapOutboxRow(row)
  };
}

/**
 * Best-effort emission for non-transactional call sites (for example a scanner
 * observation that has already been persisted). A failure is logged and never
 * rolls back or masks the underlying chain operation.
 */
export async function emitEventSafe(db, event, log = () => {}) {
  try {
    return await emitEvent(db, event);
  } catch (error) {
    log('webhook_outbox.emit_failed', {
      eventType: event?.eventType ?? null,
      message: error.message
    });
    return { created: false, event: null, error };
  }
}

/**
 * Claim a batch of due events for delivery.
 *
 * `FOR UPDATE SKIP LOCKED` lets multiple delivery workers run concurrently
 * without handing the same event to two of them.
 */
export async function claimDueEvents(db, { limit = 20 } = {}) {
  const result = await db.query(
    `
      WITH due AS (
        SELECT id
        FROM webhook_outbox
        WHERE status IN ('pending', 'failed')
          AND next_attempt_at <= NOW()
        ORDER BY next_attempt_at ASC, id ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE webhook_outbox o
      SET status = 'delivering',
          attempts = o.attempts + 1,
          updated_at = NOW()
      FROM due
      WHERE o.id = due.id
      RETURNING ${OUTBOX_COLUMNS}
    `,
    [limit]
  );

  return result.rows.map(mapOutboxRow);
}

export async function markDelivered(db, id, { httpStatus, deliveredAt = new Date() }) {
  const result = await db.query(
    `
      UPDATE webhook_outbox
      SET status = 'delivered',
          delivered_at = $3,
          last_http_status = $2,
          last_error = NULL,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${OUTBOX_COLUMNS}
    `,
    [id, httpStatus, deliveredAt]
  );

  return mapOutboxRow(result.rows[0]);
}

/**
 * Record a failed attempt and schedule the next one (or give up).
 */
export async function markFailed(db, id, {
  httpStatus = null,
  error = 'delivery failed',
  nextAttemptAt,
  discard = false
}) {
  const result = await db.query(
    `
      UPDATE webhook_outbox
      SET status = CASE
            WHEN $4::boolean THEN 'discarded'
            WHEN attempts >= max_attempts THEN 'failed'
            ELSE 'pending'
          END,
          last_http_status = $2,
          last_error = $3,
          next_attempt_at = CASE
            WHEN $4::boolean OR attempts >= max_attempts THEN next_attempt_at
            ELSE $5
          END,
          updated_at = NOW()
      WHERE id = $1
      RETURNING ${OUTBOX_COLUMNS}
    `,
    [id, httpStatus, String(error).slice(0, 500), discard, nextAttemptAt ?? new Date()]
  );

  return mapOutboxRow(result.rows[0]);
}

/**
 * Operator-triggered replay of an event (failed or discarded).
 */
export async function replayEvent(db, eventId) {
  const result = await db.query(
    `
      UPDATE webhook_outbox
      SET status = 'pending',
          attempts = 0,
          next_attempt_at = NOW(),
          last_error = NULL,
          updated_at = NOW()
      WHERE event_id = $1
        AND status IN ('failed', 'discarded', 'delivered')
      RETURNING ${OUTBOX_COLUMNS}
    `,
    [eventId]
  );

  return mapOutboxRow(result.rows[0]);
}

export async function findEventById(db, eventId) {
  const result = await db.query(
    `SELECT ${OUTBOX_COLUMNS} FROM webhook_outbox WHERE event_id = $1 LIMIT 1`,
    [eventId]
  );

  return mapOutboxRow(result.rows[0]);
}

export async function listEvents(db, { status = null, limit = 50, offset = 0 } = {}) {
  const result = await db.query(
    `
      SELECT ${OUTBOX_COLUMNS}
      FROM webhook_outbox
      WHERE ($1::text IS NULL OR status = $1)
      ORDER BY created_at DESC, id DESC
      LIMIT $2 OFFSET $3
    `,
    [status, limit, offset]
  );

  return result.rows.map(mapOutboxRow);
}

export async function countPending(db) {
  const result = await db.query(
    `SELECT COUNT(*)::int AS pending FROM webhook_outbox WHERE status IN ('pending', 'failed', 'delivering')`
  );

  return Number(result.rows[0]?.pending ?? 0);
}
