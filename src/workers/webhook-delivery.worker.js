/**
 * Webhook delivery worker.
 *
 * - claims due events with `FOR UPDATE SKIP LOCKED` (safe with N instances),
 * - validates the destination with the SSRF guard on every attempt,
 * - signs each payload with HMAC-SHA256 over `<ts>.<eventId>.<body>`,
 * - 2xx ⇒ delivered; anything else ⇒ exponential backoff up to `max_attempts`,
 * - never follows redirects, never sends credentials,
 * - logs contain event ids and statuses only (never payloads or secrets).
 */
import { validateWebhookDestination } from '../infrastructure/security/ssrf-guard.js';
import {
  EVENT_ID_HEADER,
  EVENT_TYPE_HEADER,
  SIGNATURE_HEADER,
  buildSignatureHeader
} from '../infrastructure/webhooks/webhook-signature.js';

export const DEFAULT_BACKOFF_BASE_MS = 2_000;
export const DEFAULT_BACKOFF_MAX_MS = 30 * 60 * 1000;

/**
 * @param {object} options
 * @param {object} options.db
 * @param {object} options.outbox   webhook-outbox repository
 * @param {string} options.endpoint
 * @param {string} options.secret
 * @param {number} [options.timeoutMs]
 * @param {number} [options.batchSize]
 * @param {number} [options.backoffBaseMs]
 * @param {number} [options.backoffMaxMs]
 * @param {number} [options.maxAttempts]
 * @param {Function} [options.fetchImpl]
 * @param {(message: string, meta?: object) => void} [options.log]
 * @param {() => number} [options.now]
 */
export function createWebhookDeliveryWorker({
  db,
  outbox,
  endpoint,
  secret,
  timeoutMs = 10_000,
  batchSize = 20,
  backoffBaseMs = DEFAULT_BACKOFF_BASE_MS,
  backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  maxAttempts,
  fetchImpl = globalThis.fetch,
  log = () => { },
  now = () => Date.now()
}) {
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new TypeError('Webhook secret must be at least 32 characters');
  }

  if (typeof fetchImpl !== 'function') {
    throw new TypeError('A fetch implementation is required');
  }

  const metrics = {
    runs: 0,
    claimed: 0,
    delivered: 0,
    retried: 0,
    discarded: 0,
    blocked: 0,
    lastRunAt: null,
    lastError: null
  };

  function backoffFor(attempts) {
    const delay = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempts - 1));

    // ±20% jitter so a burst of failures does not retry in lockstep.
    const jitter = delay * (0.8 + Math.random() * 0.4);

    return Math.round(jitter);
  }

  async function deliverOne(event) {
    // Re-validate on every attempt: DNS may have been re-pointed since claim.
    const destination = await validateWebhookDestination(endpoint);

    if (!destination.ok) {
      metrics.blocked += 1;

      await outbox.markFailed(db, event.id, {
        httpStatus: null,
        error: `destination_rejected:${destination.reason}`,
        discard: true
      });

      log('webhook.destination_rejected', { eventId: event.eventId, reason: destination.reason });
      return { delivered: false, reason: destination.reason };
    }

    const body = JSON.stringify(event.payload);
    const signatureHeader = buildSignatureHeader({
      secret,
      eventId: event.eventId,
      body,
      timestamp: Math.floor(now() / 1000)
    });

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    let response;

    try {
      response = await fetchImpl(destination.url.toString(), {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': 'application/json',
          [SIGNATURE_HEADER]: signatureHeader,
          [EVENT_ID_HEADER]: event.eventId,
          [EVENT_TYPE_HEADER]: event.eventType,
          'user-agent': 'blackchin-webhook/1'
        },
        body,
        signal: controller.signal
      });
    } catch (error) {
      const reason = error?.name === 'AbortError' ? 'timeout' : 'network_error';

      return scheduleRetry(event, { httpStatus: null, error: reason });
    } finally {
      clearTimeout(timer);
    }

    if (response.status >= 200 && response.status < 300) {
      await outbox.markDelivered(db, event.id, {
        httpStatus: response.status,
        deliveredAt: new Date(now())
      });

      metrics.delivered += 1;
      log('webhook.delivered', { eventId: event.eventId, status: response.status });

      return { delivered: true, httpStatus: response.status };
    }

    return scheduleRetry(event, {
      httpStatus: response.status,
      error: `http_${response.status}`
    });
  }

  async function scheduleRetry(event, { httpStatus, error }) {
    const attempts = event.attempts;
    const exhausted = maxAttempts !== undefined
      ? attempts >= maxAttempts
      : attempts >= event.maxAttempts;

    if (exhausted) {
      await outbox.markFailed(db, event.id, {
        httpStatus,
        error,
        discard: true
      });

      metrics.discarded += 1;
      log('webhook.discarded', { eventId: event.eventId, attempts, error });

      return { delivered: false, discarded: true, httpStatus, error };
    }

    await outbox.markFailed(db, event.id, {
      httpStatus,
      error,
      nextAttemptAt: new Date(now() + backoffFor(attempts))
    });

    metrics.retried += 1;
    log('webhook.retry_scheduled', { eventId: event.eventId, attempts, error });

    return { delivered: false, retried: true, httpStatus, error };
  }

  return Object.freeze({
    metrics,

    /**
     * Process one batch of due events.
     */
    async runOnce() {
      metrics.runs += 1;
      metrics.lastRunAt = new Date(now()).toISOString();

      const events = await outbox.claimDueEvents(db, { limit: batchSize });
      metrics.claimed += events.length;

      const results = [];

      for (const event of events) {
        try {
          results.push(await deliverOne(event));
        } catch (error) {
          metrics.lastError = error.message;
          log('webhook.delivery_error', { eventId: event.eventId, message: error.message });

          // Put the event back so another worker can retry it.
          await outbox.markFailed(db, event.id, {
            error: `worker_error:${error.message}`,
            nextAttemptAt: new Date(now() + backoffFor(event.attempts))
          }).catch(() => { });
        }
      }

      return { claimed: events.length, results };
    }
  });
}
