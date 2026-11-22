# BLACKCHIN — Real-Time Dashboard

## 1. Goals

The operator dashboard updates without a page refresh and never displays fake
live data. If a metric is unavailable, it is shown as unavailable.

## 2. Transport

Server-Sent Events (SSE) at:

```
GET /api/v1/dashboard/stream
```

SSE was chosen over WebSocket because:

- updates are server-to-client only,
- it works through standard HTTP ingress,
- `EventSource` provides a simple reconnection model,
- the durable cursor lives in PostgreSQL, not in process memory.

The stream requires a valid dashboard session cookie. It is not authenticated
with a partner API key.

## 3. Event protocol

On connect:

```
retry: 3000

id: <lastEventId>
event: snapshot
data: { ...overview snapshot... }
```

For each new operational event:

```
id: <operational_events.id>
event: operational
data: { id, eventId, eventType, tenantId, network, walletPublicKey, hdWalletId, payload, createdAt }
```

Heartbeat every 15 seconds:

```
: heartbeat 2026-11-22T12:00:00.000Z
```

Replay errors:

```
event: stream_error
data: {"error":"EVENT_REPLAY_UNAVAILABLE"}
```

## 4. Replay and reliability

- `operational_events` is append-only and indexed by `id`.
- The client stores the last numeric event ID in `localStorage`.
- On reconnect, the client sends `?lastEventId=<id>`; the server also honors
  the standard `Last-Event-ID` header.
- The server polls the table every 2 seconds for events after the cursor.
- The client deduplicates by `eventId` and caps the in-memory set.
- Reconnect uses exponential backoff capped at 30 seconds.
- Browser `online`/`offline` events update the connection indicator.
- A fresh snapshot is sent on every connection, so a client that missed events
  resynchronizes automatically.

Connection states shown in the UI:

- **Live** — stream open and snapshot received,
- **Reconnecting** — stream lost, retry scheduled,
- **Offline** — browser reports no network,
- **Stale data** — query has not refreshed within the expected window.

## 5. Event types

- `wallet.created`
- `wallet.child.created`
- `wallet.status_changed`
- `deposit.detected`
- `deposit.confirmed`
- `deposit.failed`
- `deposit.under_review`
- `withdrawal.accepted`
- `withdrawal.broadcast`
- `withdrawal.confirmed`
- `withdrawal.failed`
- `withdrawal.reconciliation_required`
- `webhook.delivered`
- `webhook.failed`
- `hot_wallet.registered`
- `hot_wallet.frozen`
- `hot_wallet.unfrozen`
- `api_credential.issued`
- `api_credential.revoked`
- `webhook_endpoint.created`
- `webhook_endpoint.rotated`
- `system.health_changed`

## 6. Snapshot contents

The snapshot includes:

- platform counters (wallets, addresses, deposits, withdrawals, transactions,
  webhooks, credentials),
- wallet/address/deposit/withdrawal time series for the selected range,
- RPC probe status and latency,
- scanner cursor status,
- signer status (`application_encrypted`, `kms: false`),
- webhook worker metrics when enabled,
- recent operational events,
- `lastEventId` for cursor initialization.

## 7. Dashboard pages

| Route | Purpose |
|---|---|
| `/` | Overview, statistics, charts, service health, recent activity |
| `/wallets` | Wallet inventory hub |
| `/hd-wallets` | HD roots and root creation |
| `/child-wallets` | Derived accounts and batch generation |
| `/hot-wallets` | Hot-wallet registration, freeze/unfreeze |
| `/addresses` | Address registry, copy and QR |
| `/deposits` | Deposit operations and status filters |
| `/withdrawals` | Withdrawal intents and signatures |
| `/transactions` | Unified transaction explorer |
| `/activity` | Durable operational event log |
| `/webhooks` | Delivery events, endpoints, rotation, retry |
| `/api-credentials` | Credential issuance and revocation |
| `/network` | RPC, scanner cursors and asset scope |
| `/security` | Policies, hot wallets and credential surface |
| `/settings` | Language, session and operating notes |

## 8. Internationalization

- English and Persian dictionaries.
- Locale persisted in `localStorage`.
- `document.documentElement.dir` switches between `ltr` and `rtl`.
- Logical CSS properties (`ms-*`, `me-*`, `ps-*`, `pe-*`, `start-*`, `end-*`)
  keep layout correct in both directions.

## 9. Limitations

- SSE is a single-process stream backed by PostgreSQL polling; it is not a
  distributed pub/sub system. Polling every 2 seconds is adequate for the
  current event volume and keeps correctness independent of process memory.
- The dashboard shows platform-wide data to authorized operators. Partner
  tenant isolation is enforced by the partner API, not by dashboard filters.
- No fake metrics are generated. Unavailable services are labeled explicitly.