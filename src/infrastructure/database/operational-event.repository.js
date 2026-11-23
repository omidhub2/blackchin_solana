/**
 * Durable operational event log.
 *
 * These events power the dashboard activity feed and the SSE replay cursor.
 * They are append-only infrastructure telemetry, not a financial ledger and
 * never contain secrets, mnemonics, API keys or raw request bodies.
 */
import crypto from 'node:crypto';

export const OPERATIONAL_EVENT_TYPES = Object.freeze([
  'wallet.created',
  'wallet.child.created',
  'wallet.status_changed',
  'deposit.detected',
  'deposit.confirmed',
  'deposit.failed',
  'deposit.under_review',
  'withdrawal.accepted',
  'withdrawal.broadcast',
  'withdrawal.confirmed',
  'withdrawal.failed',
  'withdrawal.reconciliation_required',
  'webhook.delivered',
  'webhook.failed',
  'hot_wallet.registered',
  'hot_wallet.frozen',
  'hot_wallet.unfrozen',
  'api_credential.issued',
  'api_credential.revoked',
  'webhook_endpoint.created',
  'webhook_endpoint.rotated',
  'system.health_changed',
  'tenant.created',
  'tenant.status_changed'
]);

const EVENT_TYPE_SET = new Set(OPERATIONAL_EVENT_TYPES);

const EVENT_COLUMNS = `
  id, event_id, tenant_id, event_type, network, wallet_public_key,
  hd_wallet_id, payload, created_at
`;

function mapEvent(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    eventId: row.event_id,
    tenantId: row.tenant_id === null || row.tenant_id === undefined ? null : String(row.tenant_id),
    eventType: row.event_type,
    network: row.network ?? null,
    walletPublicKey: row.wallet_public_key ?? null,
    hdWalletId: row.hd_wallet_id === null || row.hd_wallet_id === undefined
      ? null
      : String(row.hd_wallet_id),
    payload: row.payload ?? {},
    createdAt: row.created_at
  };
}

export function assertOperationalEventType(eventType) {
  if (typeof eventType !== 'string' || !EVENT_TYPE_SET.has(eventType)) {
    throw new TypeError(`Unsupported operational event type: ${eventType}`);
  }
}

/**
 * Append one operational event. Safe to call outside the originating
 * transaction: a lost telemetry event must never roll back the chain operation.
 */
export async function recordOperationalEvent(db, {
  eventType,
  tenantId = null,
  network = null,
  walletPublicKey = null,
  hdWalletId = null,
  payload = {},
  eventId = crypto.randomUUID()
} = {}) {
  assertOperationalEventType(eventType);

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new TypeError('Operational event payload must be an object');
  }

  const result = await db.query(
    `INSERT INTO operational_events
       (event_id, tenant_id, event_type, network, wallet_public_key, hd_wallet_id, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
     ON CONFLICT (event_id) DO NOTHING
     RETURNING ${EVENT_COLUMNS}`,
    [
      eventId,
      tenantId === null ? null : String(tenantId),
      eventType,
      network,
      walletPublicKey,
      hdWalletId === null ? null : String(hdWalletId),
      JSON.stringify(payload)
    ]
  );

  return { created: result.rowCount === 1, event: mapEvent(result.rows[0]) };
}

/**
 * Best-effort variant for use in request paths: telemetry failure is logged
 * but never converts a successful wallet/chain operation into an error.
 */
export async function recordOperationalEventSafe(db, event, log = () => {}) {
  try {
    return await recordOperationalEvent(db, event);
  } catch (error) {
    log('operational_event.record_failed', {
      eventType: event?.eventType ?? null,
      message: error.message
    });
    return { created: false, event: null, error };
  }
}

export async function listOperationalEvents(db, {
  afterId = 0,
  limit = 50,
  tenantId = null,
  eventType = null
} = {}) {
  const result = await db.query(
    `SELECT ${EVENT_COLUMNS}
     FROM operational_events
     WHERE id > $1
       AND ($2::bigint IS NULL OR tenant_id = $2)
       AND ($3::text IS NULL OR event_type = $3)
     ORDER BY id ASC
     LIMIT $4`,
    [afterId, tenantId === null ? null : String(tenantId), eventType, limit]
  );

  return result.rows.map(mapEvent);
}

export async function listRecentOperationalEvents(db, { limit = 25 } = {}) {
  const result = await db.query(
    `SELECT ${EVENT_COLUMNS}
     FROM operational_events
     ORDER BY id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows.map(mapEvent);
}

export async function latestOperationalEventId(db) {
  const result = await db.query('SELECT COALESCE(MAX(id), 0)::text AS last_id FROM operational_events');
  return Number(result.rows[0]?.last_id ?? 0);
}