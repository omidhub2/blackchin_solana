import test from 'node:test';
import assert from 'node:assert/strict';

import {
  OPERATIONAL_EVENT_TYPES,
  listOperationalEvents,
  recordOperationalEvent,
  recordOperationalEventSafe
} from '../src/infrastructure/database/operational-event.repository.js';

function buildDb() {
  const calls = [];
  const rows = [];

  return {
    calls,
    rows,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });

      if (text.includes('INSERT INTO operational_events')) {
        const row = {
          id: String(rows.length + 1),
          event_id: params[0],
          tenant_id: params[1],
          event_type: params[2],
          network: params[3],
          wallet_public_key: params[4],
          hd_wallet_id: params[5],
          payload: JSON.parse(params[6]),
          created_at: new Date()
        };
        rows.push(row);
        return { rows: [row], rowCount: 1 };
      }
      if (text.includes('FROM operational_events') && text.includes('WHERE id >')) {
        return {
          rows: rows.filter((row) => Number(row.id) > Number(params[0])),
          rowCount: rows.length
        };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test('operational events validate types and persist tenant attribution', async () => {
  const db = buildDb();
  const result = await recordOperationalEvent(db, {
    eventType: 'wallet.child.created',
    tenantId: 42,
    network: 'devnet',
    walletPublicKey: 'So11111111111111111111111111111111111111112',
    hdWalletId: '9',
    payload: { accountIndex: 3 }
  });

  assert.equal(result.created, true);
  assert.equal(result.event.tenantId, '42');
  assert.equal(result.event.eventType, 'wallet.child.created');
  assert.deepEqual(result.event.payload, { accountIndex: 3 });
  assert.equal(db.calls[0].params[1], '42');
});

test('operational events reject unknown event types', async () => {
  const db = buildDb();
  await assert.rejects(
    () => recordOperationalEvent(db, { eventType: 'unknown.event' }),
    /Unsupported operational event type/
  );
  assert.equal(db.calls.length, 0);
});

test('best-effort operational events never mask the caller failure', async () => {
  const logs = [];
  const db = {
    async query() {
      throw new Error('telemetry unavailable');
    }
  };
  const result = await recordOperationalEventSafe(db, {
    eventType: 'deposit.confirmed'
  }, (message) => logs.push(message));

  assert.equal(result.created, false);
  assert.equal(logs[0], 'operational_event.record_failed');
});

test('operational event replay is cursor based and ordered', async () => {
  const db = buildDb();
  await recordOperationalEvent(db, { eventType: 'wallet.created', tenantId: 1 });
  await recordOperationalEvent(db, { eventType: 'deposit.detected', tenantId: 1 });

  const events = await listOperationalEvents(db, { afterId: 1, limit: 10 });
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'deposit.detected');
  assert.equal(OPERATIONAL_EVENT_TYPES.includes('withdrawal.broadcast'), true);
});