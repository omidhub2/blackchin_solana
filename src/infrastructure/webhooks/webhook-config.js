/**
 * Outbox / webhook delivery configuration bounds.
 *
 * Destinations must be public HTTPS endpoints; enforcement lives in
 * `infrastructure/security/ssrf-guard.js` and runs on every delivery attempt.
 */
export const DEFAULT_WEBHOOK_TIMEOUT_MS = 10_000;
export const DEFAULT_SIGNATURE_TOLERANCE_SECONDS = 300;
