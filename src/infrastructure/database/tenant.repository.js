/**
 * Tenant registry and API credential repository.
 *
 * Customer credentials are high-entropy opaque values. Only a SHA-256 digest
 * is persisted; plaintext is returned exactly once by issueApiCredential().
 * This repository deliberately does not assign legacy NULL-tenant rows.
 */
import crypto from 'node:crypto';

const TENANT_STATUSES = new Set(['pending', 'active', 'suspended', 'disabled']);
const CREDENTIAL_SCOPES = new Set([
  'wallets:read',
  'wallets:write',
  'addresses:write',
  'deposits:read',
  'deposits:write',
  'withdrawals:estimate',
  'withdrawals:submit',
  'withdrawals:approve',
  'transactions:read',
  'webhooks:read',
  'webhooks:write',
  'assets:read',
  'assets:write'
]);

function mapTenant(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantCode: row.tenant_code,
    displayName: row.display_name,
    status: row.status,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapCredential(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  };
}

function invalid(message, code = 'INVALID_TENANT_INPUT') {
  const error = new TypeError(message);
  error.code = code;
  return error;
}

function validateScopes(scopes) {
  if (!Array.isArray(scopes) || scopes.length === 0 ||
      scopes.some((scope) => typeof scope !== 'string' || !CREDENTIAL_SCOPES.has(scope))) {
    throw invalid('scopes must contain one or more supported scope values');
  }
  return [...new Set(scopes)].sort();
}

function digest(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest();
}

export const TENANT_API_SCOPES = Object.freeze([...CREDENTIAL_SCOPES]);

export async function createTenant(db, { tenantCode, displayName, metadata = {} }) {
  if (typeof tenantCode !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,63}$/.test(tenantCode)) {
    throw invalid('tenantCode is invalid');
  }
  if (typeof displayName !== 'string' || !displayName.trim() || displayName.trim().length > 160) {
    throw invalid('displayName must contain 1 to 160 characters');
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw invalid('metadata must be an object');
  }

  const result = await db.query(
    `INSERT INTO tenants (tenant_code, display_name, metadata)
     VALUES ($1, $2, $3::jsonb)
     RETURNING id, tenant_code, display_name, status, metadata, created_at, updated_at`,
    [tenantCode, displayName.trim(), JSON.stringify(metadata)]
  );
  return mapTenant(result.rows[0]);
}

export async function findTenantById(db, tenantId) {
  const result = await db.query(
    `SELECT id, tenant_code, display_name, status, metadata, created_at, updated_at
     FROM tenants WHERE id = $1 LIMIT 1`,
    [tenantId]
  );
  return mapTenant(result.rows[0]);
}

export async function updateTenantStatus(db, tenantId, status) {
  if (!TENANT_STATUSES.has(status)) throw invalid('Unsupported tenant status');
  const result = await db.query(
    `UPDATE tenants SET status = $2, updated_at = NOW()
     WHERE id = $1
     RETURNING id, tenant_code, display_name, status, metadata, created_at, updated_at`,
    [tenantId, status]
  );
  return mapTenant(result.rows[0]);
}

/**
 * Issue an opaque API key. The returned key must be shown to the caller once
 * and must never be logged or stored by the caller.
 */
export async function issueApiCredential(db, tenantId, { scopes, expiresAt = null } = {}) {
  const normalizedScopes = validateScopes(scopes);
  if (expiresAt !== null && (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) ||
      expiresAt.getTime() <= Date.now())) {
    throw invalid('expiresAt must be a future valid Date');
  }

  const prefix = `bc_live_${crypto.randomBytes(6).toString('base64url')}`;
  const secret = crypto.randomBytes(32).toString('base64url');
  const apiKey = `${prefix}.${secret}`;
  const result = await db.query(
    `INSERT INTO tenant_api_credentials (tenant_id, key_prefix, secret_hash, scopes, expires_at)
     SELECT id, $2, $3, $4::text[], $5
     FROM tenants WHERE id = $1 AND status = 'active'
     RETURNING id, tenant_id, key_prefix, scopes, status, expires_at, last_used_at, revoked_at, created_at`,
    [tenantId, prefix, digest(apiKey), normalizedScopes, expiresAt]
  );

  if (result.rowCount !== 1) {
    const error = new Error('Active tenant was not found');
    error.statusCode = 404;
    error.code = 'TENANT_NOT_FOUND_OR_INACTIVE';
    throw error;
  }

  return { credential: mapCredential(result.rows[0]), apiKey };
}

/**
 * Resolve and verify a credential by its public prefix. Invalid credentials,
 * inactive tenants, revoked keys and expired keys all fail closed.
 */
export async function authenticateApiCredential(db, apiKey) {
  if (typeof apiKey !== 'string' || apiKey.length > 256) return null;
  const separator = apiKey.indexOf('.');
  if (separator < 8 || separator > 32 || separator === apiKey.length - 1) return null;
  const prefix = apiKey.slice(0, separator);

  const result = await db.query(
    `SELECT c.id AS credential_id, c.tenant_id, c.key_prefix, c.secret_hash,
            c.scopes, c.status AS credential_status, c.expires_at, c.last_used_at,
            c.revoked_at, c.created_at AS credential_created_at,
            t.tenant_code, t.display_name, t.status AS tenant_status, t.metadata,
            t.created_at AS tenant_created_at, t.updated_at AS tenant_updated_at
     FROM tenant_api_credentials c
     INNER JOIN tenants t ON t.id = c.tenant_id
     WHERE c.key_prefix = $1
     LIMIT 1`,
    [prefix]
  );
  const row = result.rows[0];
  if (!row || row.credential_status !== 'active' || row.tenant_status !== 'active' ||
      row.revoked_at || (row.expires_at && new Date(row.expires_at).getTime() <= Date.now())) {
    return null;
  }

  const expected = Buffer.from(row.secret_hash);
  const supplied = digest(apiKey);
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    return null;
  }

  await db.query(
    'UPDATE tenant_api_credentials SET last_used_at = NOW() WHERE id = $1 AND status = \'active\'',
    [row.credential_id]
  );

  return {
    tenant: mapTenant({
      id: row.tenant_id,
      tenant_code: row.tenant_code,
      display_name: row.display_name,
      status: row.tenant_status,
      metadata: row.metadata,
      created_at: row.tenant_created_at,
      updated_at: row.tenant_updated_at
    }),
    credential: mapCredential({
      id: row.credential_id,
      tenant_id: row.tenant_id,
      key_prefix: row.key_prefix,
      scopes: row.scopes,
      status: row.credential_status,
      expires_at: row.expires_at,
      last_used_at: new Date(),
      revoked_at: row.revoked_at,
      created_at: row.credential_created_at
    })
  };
}

export async function revokeApiCredential(db, tenantId, credentialId) {
  const result = await db.query(
    `UPDATE tenant_api_credentials
     SET status = 'revoked', revoked_at = COALESCE(revoked_at, NOW())
     WHERE tenant_id = $1 AND id = $2 AND status = 'active'
     RETURNING id, tenant_id, key_prefix, scopes, status, expires_at, last_used_at, revoked_at, created_at`,
    [tenantId, credentialId]
  );
  return mapCredential(result.rows[0]);
}

export async function listTenantCredentials(db, tenantId) {
  const result = await db.query(
    `SELECT id, tenant_id, key_prefix, scopes, status, expires_at, last_used_at, revoked_at, created_at
     FROM tenant_api_credentials WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC`,
    [tenantId]
  );
  return result.rows.map(mapCredential);
}
