/**
 * Strict input validation helpers (no external schema dependency).
 *
 * Every helper throws an AppError with statusCode 400 so the Fastify error
 * handler returns a consistent client error.
 */
import { PublicKey } from '@solana/web3.js';

import { badRequest } from '../core/errors.js';

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const SOL_AMOUNT = /^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{16,128}$/;

export const PATTERNS = Object.freeze({
  base58Address: BASE58_ADDRESS,
  solAmount: SOL_AMOUNT,
  idempotencyKey: IDEMPOTENCY_KEY
});

export function requireString(value, field, { min = 1, max = 255, pattern, patternMessage } = {}) {
  if (typeof value !== 'string') {
    throw badRequest(`${field} must be a string`, 'INVALID_REQUEST', { field });
  }

  const trimmed = value.trim();

  if (trimmed.length < min || trimmed.length > max) {
    throw badRequest(
      `${field} must be between ${min} and ${max} characters`,
      'INVALID_REQUEST',
      { field }
    );
  }

  if (pattern && !pattern.test(trimmed)) {
    throw badRequest(patternMessage ?? `${field} has an invalid format`, 'INVALID_REQUEST', { field });
  }

  return trimmed;
}

export function optionalString(value, field, options) {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field, options);
}

/**
 * Validate and canonicalize a Solana public key (Base58, 32 bytes).
 */
export function requirePublicKey(value, field = 'publicKey') {
  if (typeof value !== 'string' || !BASE58_ADDRESS.test(value)) {
    throw badRequest(`${field} must be a Base58 Solana address`, 'INVALID_PUBLIC_KEY', { field });
  }

  try {
    return new PublicKey(value).toBase58();
  } catch {
    throw badRequest(`${field} must be a valid Solana address`, 'INVALID_PUBLIC_KEY', { field });
  }
}

/**
 * Validate a decimal SOL amount string (max 9 decimals, positive).
 * The normalized string is returned; conversion to lamports happens in the
 * chain adapter only.
 */
export function requireSolAmount(value, field = 'amountSol') {
  if (typeof value !== 'string' || !SOL_AMOUNT.test(value)) {
    throw badRequest(
      `${field} must be a positive decimal string with at most 9 decimal places`,
      'INVALID_AMOUNT',
      { field }
    );
  }

  if (/^0(?:\.0+)?$/.test(value)) {
    throw badRequest(`${field} must be greater than zero`, 'INVALID_AMOUNT', { field });
  }

  return value;
}

export function requireSafeInteger(value, field, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw badRequest(`${field} must be an integer between ${min} and ${max}`, 'INVALID_REQUEST', { field });
  }

  return value;
}

export function requireBoolean(value, field) {
  if (typeof value !== 'boolean') {
    throw badRequest(`${field} must be a boolean`, 'INVALID_REQUEST', { field });
  }

  return value;
}

export function requireObject(value, field = 'body') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest(`${field} must be a JSON object`, 'INVALID_REQUEST', { field });
  }

  return value;
}

/**
 * Reject unknown properties so callers cannot smuggle unsupported fields
 * (e.g. a client-supplied derivation index override).
 */
export function rejectUnknownKeys(value, allowed, field = 'body') {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));

  if (unknown.length > 0) {
    throw badRequest(
      `Unsupported ${field} field(s): ${unknown.join(', ')}`,
      'INVALID_REQUEST',
      { field, unknown }
    );
  }
}

export function requireIdempotencyKey(value) {
  if (typeof value !== 'string' || !IDEMPOTENCY_KEY.test(value)) {
    throw badRequest(
      'A valid Idempotency-Key header is required (16-128 chars: A-Z a-z 0-9 . _ : -)',
      'INVALID_IDEMPOTENCY_KEY'
    );
  }

  return value;
}

/**
 * Parse a positive integer identifier from a route parameter.
 */
export function parsePositiveId(value, field) {
  if (typeof value !== 'string' || !/^\d{1,19}$/.test(value)) {
    throw badRequest(`${field} must be a positive integer`, 'INVALID_REQUEST', { field });
  }

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw badRequest(`${field} is out of range`, 'INVALID_REQUEST', { field });
  }

  return parsed;
}

/**
 * Parse a `limit` query parameter (default when absent, 400 when out of range).
 */
export function parseListLimit(value, defaultValue = 20, max = 100, field = 'limit') {
  if (value === undefined) return defaultValue;

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > max) {
    throw badRequest(
      `${field} must be an integer between 1 and ${max}`,
      'INVALID_LIMIT',
      { field }
    );
  }

  return parsed;
}

/**
 * Parse an `offset` query parameter (defaults to 0).
 */
export function parseListOffset(value, field = 'offset') {
  if (value === undefined) return 0;

  const parsed = Number(value);

  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw badRequest(`${field} must be a non-negative integer`, 'INVALID_LIMIT', { field });
  }

  return parsed;
}
