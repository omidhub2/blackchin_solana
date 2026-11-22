/**
 * Hot-wallet registry queries. Private key material is never stored here: a
 * hot wallet is a policy-bound designation of an existing tenant HD child.
 */

function mapHotWallet(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: String(row.tenant_id),
    hdWalletId: String(row.hd_wallet_id),
    walletAccountId: String(row.wallet_account_id),
    publicKey: row.public_key,
    network: row.network,
    label: row.label,
    status: row.status,
    signingEnabled: row.signing_enabled,
    maxSingleLamports: String(row.max_single_lamports),
    freezeReason: row.freeze_reason,
    createdBy: row.created_by,
    frozenAt: row.frozen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

const COLUMNS = `
  id, tenant_id, hd_wallet_id, wallet_account_id, public_key, network, label,
  status, signing_enabled, max_single_lamports, freeze_reason, created_by,
  frozen_at, created_at, updated_at
`;

export async function findHotWalletByPublicKeyForTenant(db, tenantId, publicKey) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM hot_wallets
     WHERE tenant_id = $1 AND public_key = $2 LIMIT 1`,
    [String(tenantId), publicKey]
  );
  return mapHotWallet(result.rows[0]);
}

export async function findHotWalletByIdForTenant(db, tenantId, id) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM hot_wallets
     WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [String(tenantId), id]
  );
  return mapHotWallet(result.rows[0]);
}

export async function listHotWalletsForTenant(db, tenantId, { limit = 100, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT ${COLUMNS} FROM hot_wallets
     WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [String(tenantId), limit, offset]
  );
  return result.rows.map(mapHotWallet);
}

export async function insertHotWallet(db, {
  tenantId, hdWalletId, walletAccountId, publicKey, network, label,
  maxSingleLamports = '0', createdBy = null
}) {
  const result = await db.query(
    `INSERT INTO hot_wallets
       (tenant_id, hd_wallet_id, wallet_account_id, public_key, network, label,
        max_single_lamports, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${COLUMNS}`,
    [String(tenantId), hdWalletId, walletAccountId, publicKey, network, label,
      maxSingleLamports, createdBy]
  );
  return mapHotWallet(result.rows[0]);
}

export async function updateHotWalletStatus(db, tenantId, publicKey, {
  status, signingEnabled, freezeReason = null
}) {
  const result = await db.query(
    `UPDATE hot_wallets
     SET status = $3,
         signing_enabled = $4,
         freeze_reason = CASE WHEN $3 = 'frozen' THEN $5 ELSE NULL END,
         frozen_at = CASE WHEN $3 = 'frozen' THEN COALESCE(frozen_at, NOW()) ELSE NULL END,
         updated_at = NOW()
     WHERE tenant_id = $1 AND public_key = $2
     RETURNING ${COLUMNS}`,
    [String(tenantId), publicKey, status, signingEnabled, freezeReason]
  );
  return mapHotWallet(result.rows[0]);
}

/**
 * Resolve the tenant-owned HD child that a hot wallet designation would bind.
 * Returns null unless the account and its parent are both visible to the
 * tenant, which prevents cross-tenant registration.
 */
export async function resolveHotWalletCandidate(db, tenantId, publicKey) {
  const result = await db.query(
    `SELECT a.id AS account_id, a.public_key, a.network, a.status AS account_status,
            a.hd_wallet_id, h.id AS parent_id, h.status AS parent_status,
            h.network AS parent_network
     FROM wallet_accounts a
     INNER JOIN hd_wallets h
       ON h.id = a.hd_wallet_id AND h.tenant_id = a.tenant_id
     WHERE a.tenant_id = $1 AND a.public_key = $2
     LIMIT 1`,
    [String(tenantId), publicKey]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    accountId: String(row.account_id),
    publicKey: row.public_key,
    network: row.network,
    accountStatus: row.account_status,
    hdWalletId: String(row.hd_wallet_id),
    parentStatus: row.parent_status,
    parentNetwork: row.parent_network
  };
}