import crypto from 'node:crypto';

const TENANT_ID_PATTERN = /^[1-9][0-9]*$/;
const KEY_PATTERN = /^[a-fA-F0-9]{64}$/;
const CONTEXT_MAX_AGE_SECONDS = 300;

function assertTenantId(value, name) {
  const normalized = String(value ?? '');
  if (!TENANT_ID_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return normalized;
}

function contextKeyFromHex(value) {
  if (typeof value !== 'string' || !KEY_PATTERN.test(value)) {
    throw new TypeError('TENANT_CONTEXT_HMAC_KEY must contain exactly 64 hexadecimal characters');
  }
  return Buffer.from(value, 'hex');
}

/**
 * Signs a short-lived, server-generated tenant identity. The signed payload
 * never comes from request-body fields; tenant and credential IDs are taken
 * from the authenticated database identity.
 */
export function createTenantContextSigner(keyHex, {
  now = () => Date.now(),
  nonce = () => crypto.randomBytes(16).toString('hex')
} = {}) {
  const key = contextKeyFromHex(keyHex);

  return Object.freeze({
    create({ tenantId, credentialId }) {
      const claims = {
        version: 1,
        tenantId: assertTenantId(tenantId, 'tenantId'),
        credentialId: assertTenantId(credentialId, 'credentialId'),
        issuedAt: Math.floor(now() / 1000),
        nonce: nonce()
      };
      const payload = JSON.stringify(claims);
      const signature = crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
      return Object.freeze({ payload, signature, claims: Object.freeze(claims) });
    }
  });
}

function queryText(query) {
  return typeof query === 'string' ? query : query?.text ?? '';
}

function isTransactionCommand(query, command) {
  return new RegExp(`^\\s*${command}\\b`, 'i').test(queryText(query));
}

async function applyContext(client, context) {
  await client.query(
    `SELECT
       set_config('app.tenant_context', $1, true),
       set_config('app.tenant_context_signature', $2, true)`,
    [context.payload, context.signature]
  );
}

/**
 * A request-scoped database facade. Every standalone query gets its own
 * transaction; explicit client transactions receive the signed context after
 * BEGIN. SET LOCAL guarantees that the context is cleared on COMMIT/ROLLBACK
 * before a pooled connection can serve another request.
 */
export function createTenantScopedDatabase(pool, context) {
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL pool is required');
  }
  if (!context || typeof context.payload !== 'string' ||
      !/^[a-f0-9]{64}$/.test(context.signature ?? '')) {
    throw new TypeError('A signed tenant context is required');
  }

  async function withTransaction(run) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await applyContext(client, context);
      const result = await run(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      client.release();
    }
  }

  function wrapClient(client) {
    let active = false;
    let released = false;

    return {
      async query(query, values) {
        if (released) throw new Error('Tenant database client has been released');

        if (isTransactionCommand(query, 'BEGIN')) {
          if (!active) {
            await client.query(query, values);
            try {
              await applyContext(client, context);
              active = true;
            } catch (error) {
              try { await client.query('ROLLBACK'); } catch {}
              throw error;
            }
            return { rows: [], rowCount: null, command: 'BEGIN' };
          }
        }

        if (isTransactionCommand(query, 'COMMIT') || isTransactionCommand(query, 'END')) {
          const result = await client.query(query, values);
          active = false;
          return result;
        }

        if (isTransactionCommand(query, 'ROLLBACK')) {
          const result = await client.query(query, values);
          active = false;
          return result;
        }

        if (!active) {
          await client.query('BEGIN');
          try {
            await applyContext(client, context);
            const result = await client.query(query, values);
            await client.query('COMMIT');
            return result;
          } catch (error) {
            try { await client.query('ROLLBACK'); } catch {}
            throw error;
          }
        }

        return client.query(query, values);
      },
      release(error) {
        if (released) return;
        released = true;
        if (active) {
          // pg Client.release(error) destroys a connection when passed an error.
          client.release(error ?? new Error('Tenant transaction released before completion'));
          return;
        }
        client.release(error);
      },
      get connection() {
        return client;
      }
    };
  }

  return Object.freeze({
    async query(query, values) {
      return withTransaction((client) => client.query(query, values));
    },
    async connect() {
      return wrapClient(await pool.connect());
    }
  });
}

/**
 * Provision the database-side verification key using the privileged
 * migration/control-plane connection. Existing keys are never overwritten
 * automatically: rotation must be coordinated across all API instances.
 */
export async function provisionTenantContextSecret(adminDb, keyHex) {
  const key = contextKeyFromHex(keyHex);
  await adminDb.query(
    `INSERT INTO private.tenant_context_secrets (singleton, secret_key)
     VALUES (TRUE, $1)
     ON CONFLICT (singleton) DO NOTHING`,
    [key]
  );
  const result = await adminDb.query(
    'SELECT secret_key FROM private.tenant_context_secrets WHERE singleton = TRUE'
  );
  const stored = Buffer.from(result.rows[0]?.secret_key ?? []);
  if (stored.length !== key.length || !crypto.timingSafeEqual(stored, key)) {
    const error = new Error('Database tenant context key does not match TENANT_CONTEXT_HMAC_KEY');
    error.code = 'TENANT_CONTEXT_KEY_MISMATCH';
    throw error;
  }
}

/** Ensure the tenant API pool is not connected as a superuser/BYPASSRLS role. */
export async function assertTenantRuntimeRole(tenantDb) {
  if (!tenantDb || typeof tenantDb.query !== 'function') {
    throw new TypeError('TENANT_DATABASE_URL must configure a tenant runtime pool');
  }
  const result = await tenantDb.query(
    `SELECT current_user AS role_name, r.rolsuper, r.rolbypassrls,
            pg_has_role(current_user, 'blackchin_tenant_runtime', 'member') AS has_runtime_role
       FROM pg_roles r
      WHERE r.rolname = current_user`
  );
  const role = result.rows[0];
  if (!role || role.rolsuper || role.rolbypassrls || !role.has_runtime_role) {
    const error = new Error('TENANT_DATABASE_URL must use a non-superuser, non-BYPASSRLS member of blackchin_tenant_runtime');
    error.code = 'TENANT_DATABASE_ROLE_UNSAFE';
    throw error;
  }
  return { roleName: role.role_name };
}

export const TENANT_CONTEXT_MAX_AGE_SECONDS = CONTEXT_MAX_AGE_SECONDS;
