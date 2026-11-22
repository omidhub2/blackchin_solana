/**
 * Tenant webhook endpoint registry. Signing secrets are encrypted at rest with
 * the same key provider as wallet material and are never returned after
 * creation/rotation.
 */

function mapEndpoint(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    endpointUrl: row.endpoint_url,
    eventTypes: row.event_types ?? [],
    status: row.status,
    rotatedAt: row.rotated_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    secretEncrypted: row.secret_encrypted,
    secretIv: row.secret_iv,
    secretAuthTag: row.secret_auth_tag,
    encryptionKeyVersion: row.encryption_key_version
  };
}

const COLUMNS = `
  id, tenant_id, endpoint_url, event_types, status, rotated_at, created_at,
  updated_at, secret_encrypted, secret_iv, secret_auth_tag, encryption_key_version
`;

export async function insertWebhookEndpoint(db, {
  tenantId, endpointUrl, eventTypes, secretEncrypted, secretIv, secretAuthTag,
  encryptionKeyVersion
}) {
  const result = await db.query(
    `INSERT INTO tenant_webhook_endpoints
       (tenant_id, endpoint_url, event_types, secret_encrypted, secret_iv,
        secret_auth_tag, encryption_key_version)
     VALUES ($1, $2, $3::text[], $4, $5, $6, $7)
     RETURNING ${COLUMNS}`,
    [String(tenantId), endpointUrl, eventTypes, secretEncrypted, secretIv,
      secretAuthTag, encryptionKeyVersion]
  );
  return mapEndpoint(result.rows[0]);
}

export async function listWebhookEndpointsForTenant(db, tenantId, { limit = 50, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM tenant_webhook_endpoints
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [String(tenantId), limit, offset]
  );
  return result.rows.map(mapEndpoint);
}

export async function findWebhookEndpointByIdForTenant(db, tenantId, id) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM tenant_webhook_endpoints
     WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [String(tenantId), id]
  );
  return mapEndpoint(result.rows[0]);
}

export async function findActiveWebhookEndpointForEvent(db, tenantId, eventType) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM tenant_webhook_endpoints
     WHERE tenant_id = $1 AND status = 'active'
       AND (cardinality(event_types) = 0 OR $2 = ANY(event_types))
     ORDER BY created_at ASC, id ASC
     LIMIT 1`,
    [String(tenantId), eventType]
  );
  return mapEndpoint(result.rows[0]);
}

export async function updateWebhookEndpointSecret(db, tenantId, id, {
  secretEncrypted, secretIv, secretAuthTag, encryptionKeyVersion
}) {
  const result = await db.query(
    `UPDATE tenant_webhook_endpoints
     SET secret_encrypted = $3, secret_iv = $4, secret_auth_tag = $5,
         encryption_key_version = $6, rotated_at = NOW(), updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [String(tenantId), id, secretEncrypted, secretIv, secretAuthTag, encryptionKeyVersion]
  );
  return mapEndpoint(result.rows[0]);
}

export async function updateWebhookEndpointStatus(db, tenantId, id, status) {
  const result = await db.query(
    `UPDATE tenant_webhook_endpoints
     SET status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${COLUMNS}`,
    [String(tenantId), id, status]
  );
  return mapEndpoint(result.rows[0]);
}