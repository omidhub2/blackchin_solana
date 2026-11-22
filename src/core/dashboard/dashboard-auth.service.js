/**
 * Dashboard operator authentication.
 *
 * Completely separate from partner API credentials:
 *  - passwords are hashed with scrypt (per-user random salt),
 *  - sessions use a random opaque token; only its SHA-256 digest is stored,
 *  - a second random CSRF token is bound to the session and required for
 *    mutating requests (double-submit + server-side digest comparison),
 *  - cookies are HTTP-only, SameSite=Strict and Secure in production.
 *
 * No password, session token or CSRF token is ever logged.
 */
import crypto from 'node:crypto';
import { promisify } from 'node:util';

import { AppError, unauthorized } from '../errors.js';
import {
  createDashboardUser,
  findDashboardSession,
  findDashboardUserByEmail,
  findDashboardUserById,
  insertDashboardSession,
  revokeDashboardSession,
  touchDashboardLogin,
  touchDashboardSession
} from '../../infrastructure/database/dashboard.repository.js';

const scrypt = promisify(crypto.scrypt);

export const SESSION_COOKIE = 'bc_dashboard_session';
export const CSRF_COOKIE = 'bc_dashboard_csrf';
export const CSRF_HEADER = 'x-csrf-token';
export const DEFAULT_SESSION_TTL_MS = 8 * 60 * 60 * 1000;

const SCRYPT = Object.freeze({ N: 16384, r: 8, p: 1, keylen: 64 });
const PASSWORD_MIN = 12;
const PASSWORD_MAX = 256;
const ROLES = new Set(['admin', 'operator', 'viewer']);

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest();
}

function safeEqualBuffers(a, b) {
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new AppError(
      `Password must be between ${PASSWORD_MIN} and ${PASSWORD_MAX} characters`,
      400,
      'WEAK_PASSWORD'
    );
  }

  const salt = crypto.randomBytes(16);
  const derived = await scrypt(password, salt, SCRYPT.keylen, SCRYPT);

  return [
    'scrypt',
    SCRYPT.N,
    SCRYPT.r,
    SCRYPT.p,
    salt.toString('base64'),
    Buffer.from(derived).toString('base64')
  ].join('$');
}

export async function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;

  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);

  if (!Number.isSafeInteger(N) || !Number.isSafeInteger(r) || !Number.isSafeInteger(p)) {
    return false;
  }

  let salt;
  let expected;

  try {
    salt = Buffer.from(parts[4], 'base64');
    expected = Buffer.from(parts[5], 'base64');
  } catch {
    return false;
  }

  if (salt.length < 8 || expected.length < 32) return false;

  const derived = Buffer.from(await scrypt(password, salt, expected.length, { N, r, p }));
  return safeEqualBuffers(derived, expected);
}

function normalizeEmail(email) {
  if (typeof email !== 'string') {
    throw new AppError('email must be a string', 400, 'INVALID_REQUEST');
  }
  const normalized = email.trim().toLowerCase();
  if (normalized.length < 3 || normalized.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    throw new AppError('A valid email address is required', 400, 'INVALID_REQUEST');
  }
  return normalized;
}

export function createDashboardAuthService({
  db,
  now = () => Date.now(),
  sessionTtlMs = DEFAULT_SESSION_TTL_MS,
  log = () => {}
}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required');
  }
  if (!Number.isSafeInteger(sessionTtlMs) || sessionTtlMs < 60_000) {
    throw new TypeError('sessionTtlMs must be at least one minute');
  }

  async function issueSession(user) {
    const token = crypto.randomBytes(32).toString('base64url');
    const csrfToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(now() + sessionTtlMs);

    const session = await insertDashboardSession(db, {
      userId: user.id,
      tokenHash: sha256(token),
      csrfTokenHash: sha256(csrfToken),
      expiresAt
    });

    return {
      sessionId: String(session.id),
      token,
      csrfToken,
      expiresAt: expiresAt.toISOString(),
      user: {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        role: user.role,
        status: user.status,
        lastLoginAt: user.lastLoginAt ?? null,
        createdAt: user.createdAt ?? null
      }
    };
  }

  return Object.freeze({
    async createUser({ email, password, displayName, role = 'viewer' } = {}) {
      const normalizedEmail = normalizeEmail(email);
      if (!ROLES.has(role)) {
        throw new AppError('role must be admin, operator or viewer', 400, 'INVALID_ROLE');
      }
      if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 160) {
        throw new AppError('displayName must contain 1 to 160 characters', 400, 'INVALID_REQUEST');
      }

      const passwordHash = await hashPassword(password);
      return createDashboardUser(db, {
        email: normalizedEmail,
        displayName: displayName.trim(),
        passwordHash,
        role
      });
    },

    async login({ email, password } = {}) {
      const normalizedEmail = normalizeEmail(email);

      if (typeof password !== 'string' || password.length === 0 || password.length > PASSWORD_MAX) {
        throw unauthorized('Invalid email or password');
      }

      const user = await findDashboardUserByEmail(db, normalizedEmail);

      // Always perform a comparable amount of work so an unknown email is not
      // trivially distinguishable by timing.
      const stored = user?.passwordHash ?? await hashPassword('invalid-password-placeholder');
      const valid = await verifyPassword(password, stored);

      if (!user || !valid || user.status !== 'active') {
        log('dashboard.login_failed', { email: normalizedEmail });
        throw unauthorized('Invalid email or password');
      }

      await touchDashboardLogin(db, user.id);
      const session = await issueSession(user);
      log('dashboard.login_succeeded', { userId: user.id, role: user.role });
      return session;
    },

    async authenticate(token) {
      if (typeof token !== 'string' || token.length < 32 || token.length > 512) return null;

      const session = await findDashboardSession(db, sha256(token));
      if (!session) return null;
      if (session.revokedAt) return null;
      if (session.user.status !== 'active') return null;
      if (new Date(session.expiresAt).getTime() <= now()) return null;

      await touchDashboardSession(db, session.sessionId).catch(() => {});

      return {
        sessionId: session.sessionId,
        csrfTokenHash: session.csrfTokenHash,
        expiresAt: session.expiresAt,
        user: session.user
      };
    },

    async logout(token) {
      if (typeof token !== 'string' || token.length === 0) return;
      const session = await findDashboardSession(db, sha256(token));
      if (session) await revokeDashboardSession(db, session.sessionId);
    },

    verifyCsrf(session, csrfToken) {
      if (!session || typeof csrfToken !== 'string' || csrfToken.length < 32) return false;
      const expected = Buffer.from(session.csrfTokenHash);
      const supplied = sha256(csrfToken);
      return safeEqualBuffers(expected, supplied);
    },

    async getUser(userId) {
      return findDashboardUserById(db, userId);
    }
  });
}

export function buildSessionCookie(token, { maxAgeSeconds, secure }) {
  const attributes = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildCsrfCookie(token, { maxAgeSeconds, secure }) {
  const attributes = [
    `${CSRF_COOKIE}=${token}`,
    'Path=/',
    'SameSite=Strict',
    `Max-Age=${maxAgeSeconds}`
  ];
  if (secure) attributes.push('Secure');
  return attributes.join('; ');
}

export function buildClearSessionCookies() {
  return [
    `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`,
    `${CSRF_COOKIE}=; Path=/; SameSite=Strict; Max-Age=0`
  ];
}

export function parseCookies(header) {
  if (typeof header !== 'string' || header.length === 0) return {};

  const cookies = {};

  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index === -1) continue;
    const key = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (key) cookies[key] = decodeURIComponent(value);
  }

  return cookies;
}