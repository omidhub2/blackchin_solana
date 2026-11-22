/**
 * HMAC-SHA256 webhook signing and verification.
 *
 * Signed content: `<timestamp>.<eventId>.<rawJsonBody>`
 * Header: `X-Blackchin-Signature: t=<unixSeconds>,v1=<hexHmac>`
 *
 * Consumers must (a) verify the HMAC with a constant-time compare, (b) reject
 * timestamps outside their tolerance window, and (c) deduplicate on event id —
 * delivery is at-least-once.
 */
import crypto from 'node:crypto';

export const SIGNATURE_HEADER = 'x-blackchin-signature';
export const EVENT_ID_HEADER = 'x-blackchin-event-id';
export const EVENT_TYPE_HEADER = 'x-blackchin-event-type';

export function computeSignature(secret, timestamp, eventId, body) {
  return crypto
    .createHmac('sha256', secret)
    .update(`${timestamp}.${eventId}.${body}`, 'utf8')
    .digest('hex');
}

export function buildSignatureHeader({ secret, eventId, body, timestamp = Math.floor(Date.now() / 1000) }) {
  const signature = computeSignature(secret, timestamp, eventId, body);

  return `t=${timestamp},v1=${signature}`;
}

/**
 * Verify a signature header.
 *
 * @param {{ secret: string, header: string, eventId: string, body: string,
 *           toleranceSeconds?: number, now?: number }} input
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifySignature({
  secret,
  header,
  eventId,
  body,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000)
}) {
  if (typeof header !== 'string' || typeof eventId !== 'string' || typeof secret !== 'string') {
    return { valid: false, reason: 'malformed' };
  }

  const parts = new Map();

  for (const segment of header.split(',')) {
    const index = segment.indexOf('=');

    if (index === -1) continue;

    parts.set(segment.slice(0, index).trim(), segment.slice(index + 1).trim());
  }

  const timestamp = Number(parts.get('t'));
  const provided = parts.get('v1');

  if (!Number.isSafeInteger(timestamp) || typeof provided !== 'string' || !/^[a-f0-9]{64}$/.test(provided)) {
    return { valid: false, reason: 'malformed' };
  }

  if (Math.abs(now - timestamp) > toleranceSeconds) {
    return { valid: false, reason: 'timestamp_out_of_tolerance' };
  }

  const expected = computeSignature(secret, timestamp, eventId, body);
  const expectedBuffer = Buffer.from(expected, 'hex');
  const providedBuffer = Buffer.from(provided, 'hex');

  if (expectedBuffer.length !== providedBuffer.length) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  if (!crypto.timingSafeEqual(expectedBuffer, providedBuffer)) {
    return { valid: false, reason: 'signature_mismatch' };
  }

  return { valid: true };
}
