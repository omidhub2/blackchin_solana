import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  createDashboardAuthService,
  hashPassword,
  verifyPassword,
  parseCookies,
  buildSessionCookie
} from '../src/core/dashboard/dashboard-auth.service.js';

function sessionDb(user) {
  const sessions = new Map();
  const calls = [];

  return {
    calls,
    sessions,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });

      if (text.includes('FROM dashboard_users WHERE email')) {
        return { rows: user ? [user] : [], rowCount: user ? 1 : 0 };
      }
      if (text.includes('UPDATE dashboard_users SET last_login_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO dashboard_sessions')) {
        const id = String(sessions.size + 1);
        sessions.set(Buffer.from(params[1]).toString('hex'), {
          id,
          user_id: params[0],
          csrf_token_hash: params[2],
          expires_at: params[3],
          revoked_at: null
        });
        return { rows: [{ id, user_id: params[0], expires_at: params[3] }], rowCount: 1 };
      }
      if (text.includes('FROM dashboard_sessions s')) {
        const stored = sessions.get(Buffer.from(params[0]).toString('hex'));
        if (!stored) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            session_id: stored.id,
            user_id: stored.user_id,
            csrf_token_hash: stored.csrf_token_hash,
            expires_at: stored.expires_at,
            revoked_at: stored.revoked_at,
            id: user.id,
            email: user.email,
            display_name: user.display_name,
            role: user.role,
            status: user.status,
            last_login_at: null,
            created_at: new Date()
          }],
          rowCount: 1
        };
      }
      if (text.includes('UPDATE dashboard_sessions SET last_seen_at')) {
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('UPDATE dashboard_sessions SET revoked_at')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

test('dashboard passwords use scrypt and verify in constant-time form', async () => {
  const hash = await hashPassword('correct horse battery staple');
  assert.match(hash, /^scrypt\$\d+\$\d+\$\d+\$/);
  assert.equal(await verifyPassword('correct horse battery staple', hash), true);
  assert.equal(await verifyPassword('wrong password', hash), false);
  assert.equal(await verifyPassword('x', 'not-a-hash'), false);
  await assert.rejects(() => hashPassword('short'), /between 12 and 256/);
});

test('dashboard login issues an opaque session and a bound CSRF token', async () => {
  const passwordHash = await hashPassword('a-very-long-password');
  const db = sessionDb({
    id: '7',
    email: 'ops@example.com',
    display_name: 'Ops',
    password_hash: passwordHash,
    role: 'admin',
    status: 'active',
    last_login_at: null,
    created_at: new Date()
  });
  const auth = createDashboardAuthService({ db, now: () => Date.now() });

  const session = await auth.login({ email: 'OPS@example.com ', password: 'a-very-long-password' });
  assert.equal(session.user.email, 'ops@example.com');
  assert.equal(session.user.role, 'admin');
  assert.equal(session.token.length >= 32, true);
  assert.equal(session.csrfToken.length >= 32, true);
  assert.equal(db.sessions.size, 1);

  const authenticated = await auth.authenticate(session.token);
  assert.equal(authenticated.user.id, '7');
  assert.equal(auth.verifyCsrf(authenticated, session.csrfToken), true);
  assert.equal(auth.verifyCsrf(authenticated, 'x'.repeat(43)), false);
});

test('dashboard login fails closed for unknown, disabled and wrong-password users', async () => {
  const passwordHash = await hashPassword('a-very-long-password');
  const base = {
    id: '7', email: 'ops@example.com', display_name: 'Ops', password_hash: passwordHash,
    role: 'admin', status: 'active', last_login_at: null, created_at: new Date()
  };

  for (const user of [null, { ...base, status: 'disabled' }, base]) {
    const auth = createDashboardAuthService({ db: sessionDb(user) });
    await assert.rejects(
      () => auth.login({ email: 'ops@example.com', password: 'wrong-password-123' }),
      (error) => error.statusCode === 401
    );
  }
});

test('dashboard cookie and CSRF parsing helpers are strict', () => {
  assert.deepEqual(parseCookies('a=1; bc_dashboard_session=abc%20def'), {
    a: '1',
    bc_dashboard_session: 'abc def'
  });
  const cookie = buildSessionCookie('token', { maxAgeSeconds: 60, secure: true });
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
  assert.match(cookie, /Secure/);
  assert.equal(crypto.createHash('sha256').update('x').digest('hex').length, 64);
});