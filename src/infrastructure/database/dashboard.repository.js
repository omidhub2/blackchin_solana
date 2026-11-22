/**
 * Read models for the platform operations dashboard.
 *
 * The dashboard is an operator surface: it may read across tenants, but it
 * never exposes private key material, mnemonics, API secrets or webhook
 * signing secrets. Partner-facing tenant isolation continues to be enforced by
 * the tenant API and its repositories.
 */

function mapUser(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    status: row.status,
    lastLoginAt: row.last_login_at,
    createdAt: row.created_at
  };
}

export async function findDashboardUserByEmail(db, email) {
  const result = await db.query(
    `SELECT id, email, display_name, password_hash, role, status, last_login_at, created_at
     FROM dashboard_users WHERE email = lower(btrim($1)) LIMIT 1`,
    [email]
  );
  const row = result.rows[0];
  if (!row) return null;
  return { ...mapUser(row), passwordHash: row.password_hash };
}

export async function findDashboardUserById(db, id) {
  const result = await db.query(
    `SELECT id, email, display_name, role, status, last_login_at, created_at
     FROM dashboard_users WHERE id = $1 LIMIT 1`,
    [id]
  );
  return mapUser(result.rows[0]);
}

export async function createDashboardUser(db, { email, displayName, passwordHash, role = 'viewer' }) {
  const result = await db.query(
    `INSERT INTO dashboard_users (email, display_name, password_hash, role)
     VALUES (lower(btrim($1)), $2, $3, $4)
     RETURNING id, email, display_name, role, status, last_login_at, created_at`,
    [email, displayName, passwordHash, role]
  );
  return mapUser(result.rows[0]);
}

export async function touchDashboardLogin(db, userId) {
  await db.query(
    'UPDATE dashboard_users SET last_login_at = NOW(), updated_at = NOW() WHERE id = $1',
    [userId]
  );
}

export async function insertDashboardSession(db, {
  userId, tokenHash, csrfTokenHash, expiresAt
}) {
  const result = await db.query(
    `INSERT INTO dashboard_sessions (user_id, token_hash, csrf_token_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, user_id, expires_at, created_at`,
    [userId, tokenHash, csrfTokenHash, expiresAt]
  );
  return result.rows[0];
}

export async function findDashboardSession(db, tokenHash) {
  const result = await db.query(
    `SELECT s.id AS session_id, s.user_id, s.csrf_token_hash, s.expires_at,
            s.revoked_at, u.id, u.email, u.display_name, u.role, u.status,
            u.last_login_at, u.created_at
     FROM dashboard_sessions s
     INNER JOIN dashboard_users u ON u.id = s.user_id
     WHERE s.token_hash = $1
     LIMIT 1`,
    [tokenHash]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    sessionId: String(row.session_id),
    csrfTokenHash: row.csrf_token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    user: mapUser(row)
  };
}

export async function touchDashboardSession(db, sessionId) {
  await db.query(
    'UPDATE dashboard_sessions SET last_seen_at = NOW() WHERE id = $1',
    [sessionId]
  );
}

export async function revokeDashboardSession(db, sessionId) {
  await db.query(
    `UPDATE dashboard_sessions SET revoked_at = COALESCE(revoked_at, NOW())
     WHERE id = $1`,
    [sessionId]
  );
}

export async function purgeExpiredDashboardSessions(db) {
  const result = await db.query(
    `DELETE FROM dashboard_sessions
     WHERE expires_at <= NOW() OR revoked_at IS NOT NULL`,
    []
  );
  return result.rowCount;
}

/**
 * Platform-wide counters. Every value comes from persisted operational state;
 * nothing is synthesized.
 */
export async function getOverviewStats(db, { since = null } = {}) {
  const result = await db.query(
    `SELECT
       (SELECT COUNT(*)::text FROM tenants) AS tenants,
       (SELECT COUNT(*)::text FROM tenants WHERE status = 'active') AS active_tenants,
       (SELECT COUNT(*)::text FROM hd_wallets) AS hd_wallets,
       (SELECT COUNT(*)::text FROM wallet_accounts) AS child_wallets,
       (SELECT COUNT(*)::text FROM hot_wallets) AS hot_wallets,
       (SELECT COUNT(*)::text FROM hot_wallets WHERE status = 'frozen') AS frozen_hot_wallets,
       ((SELECT COUNT(*) FROM wallet_accounts) +
         (SELECT COUNT(*) FROM wallets))::text AS registered_addresses,
       ((SELECT COUNT(*) FROM wallet_accounts WHERE status = 'active') +
         (SELECT COUNT(*) FROM wallets))::text AS monitored_addresses,
       (SELECT COUNT(*)::text FROM blockchain_transactions WHERE direction = 'deposit') AS deposits_total,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE direction = 'deposit' AND status IN ('confirmed', 'credited')) AS deposits_confirmed,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE direction = 'deposit' AND status IN ('detected', 'confirming')) AS deposits_pending,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE direction = 'deposit' AND status IN ('failed', 'rejected')) AS deposits_failed,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE direction = 'deposit' AND status = 'under_review') AS deposits_under_review,
       (SELECT COUNT(*)::text FROM api_idempotency_keys WHERE operation = 'withdrawal') AS withdrawals_total,
       (SELECT COUNT(*)::text FROM api_idempotency_keys
          WHERE operation = 'withdrawal' AND status = 'completed') AS withdrawals_confirmed,
       (SELECT COUNT(*)::text FROM api_idempotency_keys
          WHERE operation = 'withdrawal' AND status = 'processing') AS withdrawals_pending,
       (SELECT COUNT(*)::text FROM api_idempotency_keys
          WHERE operation = 'withdrawal' AND status = 'failed') AS withdrawals_failed,
       (SELECT COUNT(*)::text FROM blockchain_transactions) AS transactions_total,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE status IN ('confirmed', 'credited')) AS transactions_confirmed,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE status IN ('detected', 'confirming')) AS transactions_pending,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE status IN ('failed', 'rejected')) AS transactions_failed,
       (SELECT COUNT(*)::text FROM blockchain_transactions
          WHERE status = 'under_review') AS transactions_under_review,
       (SELECT COUNT(*)::text FROM webhook_outbox WHERE status = 'pending') AS webhooks_pending,
       (SELECT COUNT(*)::text FROM webhook_outbox WHERE status = 'delivered') AS webhooks_delivered,
       (SELECT COUNT(*)::text FROM webhook_outbox
          WHERE status IN ('failed', 'discarded')) AS webhooks_failed,
       (SELECT COUNT(*)::text FROM tenant_webhook_endpoints WHERE status = 'active') AS webhook_endpoints,
       (SELECT COUNT(*)::text FROM tenant_api_credentials WHERE status = 'active') AS active_credentials,
       (SELECT COUNT(*)::text FROM dashboard_users WHERE status = 'active') AS dashboard_users,
       (SELECT COUNT(*)::text FROM operational_events
          WHERE ($1::timestamptz IS NULL OR created_at >= $1)) AS events_in_range`,
    [since]
  );

  const row = result.rows[0] ?? {};
  const number = (key) => Number(row[key] ?? 0);

  return {
    tenants: number('tenants'),
    activeTenants: number('active_tenants'),
    hdWallets: number('hd_wallets'),
    childWallets: number('child_wallets'),
    hotWallets: number('hot_wallets'),
    frozenHotWallets: number('frozen_hot_wallets'),
    registeredAddresses: number('registered_addresses'),
    monitoredAddresses: number('monitored_addresses'),
    deposits: {
      total: number('deposits_total'),
      confirmed: number('deposits_confirmed'),
      pending: number('deposits_pending'),
      failed: number('deposits_failed'),
      underReview: number('deposits_under_review')
    },
    withdrawals: {
      total: number('withdrawals_total'),
      confirmed: number('withdrawals_confirmed'),
      pending: number('withdrawals_pending'),
      failed: number('withdrawals_failed')
    },
    transactions: {
      total: number('transactions_total'),
      confirmed: number('transactions_confirmed'),
      pending: number('transactions_pending'),
      failed: number('transactions_failed'),
      underReview: number('transactions_under_review')
    },
    webhooks: {
      pending: number('webhooks_pending'),
      delivered: number('webhooks_delivered'),
      failed: number('webhooks_failed'),
      endpoints: number('webhook_endpoints')
    },
    activeCredentials: number('active_credentials'),
    dashboardUsers: number('dashboard_users'),
    eventsInRange: number('events_in_range')
  };
}

export async function getScannerStatus(db) {
  const result = await db.query(
    `SELECT status, COUNT(*)::text AS cursors,
            MAX(last_run_at) AS last_run_at,
            MAX(last_error) FILTER (WHERE last_error IS NOT NULL) AS last_error
     FROM deposit_scanner_cursors
     GROUP BY status`,
    []
  );

  const rows = result.rows.map((row) => ({
    status: row.status,
    cursors: Number(row.cursors),
    lastRunAt: row.last_run_at,
    lastError: row.last_error
  }));

  return {
    cursors: rows,
    lastRunAt: rows.reduce((latest, row) => {
      if (!row.lastRunAt) return latest;
      return !latest || new Date(row.lastRunAt) > new Date(latest) ? row.lastRunAt : latest;
    }, null)
  };
}

export async function listHdWallets(db, { limit = 50, offset = 0, tenantId = null } = {}) {
  const result = await db.query(
    `SELECT h.id, h.tenant_id, h.label, h.network, h.status, h.owner_id,
            h.next_account_index, h.phrase_provisioned_at, h.created_at, h.updated_at,
            (SELECT COUNT(*)::text FROM wallet_accounts a
              WHERE a.hd_wallet_id = h.id) AS child_count
     FROM hd_wallets h
     WHERE ($1::bigint IS NULL OR h.tenant_id = $1)
     ORDER BY h.created_at DESC, h.id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    label: row.label,
    ownerId: row.owner_id,
    network: row.network,
    status: row.status,
    nextAccountIndex: Number(row.next_account_index),
    childCount: Number(row.child_count),
    phraseProvisioned: row.phrase_provisioned_at !== null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listChildWallets(db, { limit = 50, offset = 0, tenantId = null } = {}) {
  const result = await db.query(
    `SELECT a.id, a.tenant_id, a.hd_wallet_id, a.public_key, a.account_index,
            a.derivation_path, a.wallet_type, a.network, a.status,
            a.created_at, a.updated_at, h.label AS parent_label
     FROM wallet_accounts a
     LEFT JOIN hd_wallets h ON h.id = a.hd_wallet_id
     WHERE ($1::bigint IS NULL OR a.tenant_id = $1)
     ORDER BY a.created_at DESC, a.id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    hdWalletId: String(row.hd_wallet_id),
    parentLabel: row.parent_label,
    publicKey: row.public_key,
    accountIndex: Number(row.account_index),
    derivationPath: row.derivation_path,
    walletType: row.wallet_type,
    network: row.network,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listHotWallets(db, { limit = 50, offset = 0, tenantId = null } = {}) {
  const result = await db.query(
    `SELECT id, tenant_id, hd_wallet_id, wallet_account_id, public_key, network,
            label, status, signing_enabled, max_single_lamports, freeze_reason,
            created_by, frozen_at, created_at, updated_at
     FROM hot_wallets
     WHERE ($1::bigint IS NULL OR tenant_id = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return result.rows.map((row) => ({
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
  }));
}

export async function listAddresses(db, { limit = 50, offset = 0, tenantId = null } = {}) {
  const result = await db.query(
    `SELECT id, tenant_id, public_key, wallet_type, network, status, hd_wallet_id,
            account_index, derivation_path, created_at
     FROM (
       SELECT a.id, a.tenant_id, a.public_key, 'hd_child'::text AS wallet_type,
              a.network, a.status, a.hd_wallet_id, a.account_index,
              a.derivation_path, a.created_at
       FROM wallet_accounts a
       UNION ALL
       SELECT w.id, w.tenant_id, w.public_key, 'standalone'::text AS wallet_type,
              NULL::text AS network, 'active'::text AS status, NULL::bigint AS hd_wallet_id,
              NULL::bigint AS account_index, NULL::text AS derivation_path, w.created_at
       FROM wallets w
     ) addresses
     WHERE ($1::bigint IS NULL OR tenant_id = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [tenantId, limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    publicKey: row.public_key,
    walletType: row.wallet_type,
    network: row.network,
    status: row.status,
    hdWalletId: row.hd_wallet_id === null ? null : String(row.hd_wallet_id),
    accountIndex: row.account_index === null ? null : Number(row.account_index),
    derivationPath: row.derivation_path,
    createdAt: row.created_at
  }));
}

const TX_COLUMNS = `
  id, tenant_id, signature, direction, wallet_public_key, hd_wallet_id,
  counterparty, amount_lamports, fee_lamports, network, commitment, status,
  slot, block_time, failure_reason, created_at, updated_at
`;

function mapTransaction(row) {
  return {
    id: String(row.id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    signature: row.signature,
    direction: row.direction,
    walletPublicKey: row.wallet_public_key,
    hdWalletId: row.hd_wallet_id === null ? null : String(row.hd_wallet_id),
    counterparty: row.counterparty,
    amountLamports: String(row.amount_lamports),
    feeLamports: row.fee_lamports === null ? null : String(row.fee_lamports),
    network: row.network,
    commitment: row.commitment,
    status: row.status,
    slot: row.slot === null ? null : Number(row.slot),
    blockTime: row.block_time,
    failureReason: row.failure_reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export async function listTransactions(db, {
  limit = 50, offset = 0, direction = null, status = null, tenantId = null
} = {}) {
  const result = await db.query(
    `SELECT ${TX_COLUMNS}
     FROM blockchain_transactions
     WHERE ($1::text IS NULL OR direction = $1)
       AND ($2::text IS NULL OR status = $2)
       AND ($3::bigint IS NULL OR tenant_id = $3)
     ORDER BY created_at DESC, id DESC
     LIMIT $4 OFFSET $5`,
    [direction, status, tenantId, limit, offset]
  );
  return result.rows.map(mapTransaction);
}

export async function listWithdrawals(db, {
  limit = 50, offset = 0, status = null, tenantId = null
} = {}) {
  const result = await db.query(
    `SELECT idempotency_key, tenant_id, status, network, wallet_public_key,
            to_public_key, amount_lamports, transaction_signature,
            approval_reference, created_at, updated_at
     FROM api_idempotency_keys
     WHERE operation = 'withdrawal'
       AND ($1::text IS NULL OR status = $1)
       AND ($2::bigint IS NULL OR tenant_id = $2)
     ORDER BY created_at DESC, id DESC
     LIMIT $3 OFFSET $4`,
    [status, tenantId, limit, offset]
  );

  return result.rows.map((row) => ({
    idempotencyKey: row.idempotency_key,
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    status: row.status,
    network: row.network,
    fromPublicKey: row.wallet_public_key,
    toPublicKey: row.to_public_key,
    amountLamports: row.amount_lamports === null ? null : String(row.amount_lamports),
    signature: row.transaction_signature,
    approvalReference: row.approval_reference,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listWebhookEvents(db, {
  limit = 50, offset = 0, status = null
} = {}) {
  const result = await db.query(
    `SELECT id, event_id, event_type, tenant_id, wallet_public_key, hd_wallet_id,
            network, status, attempts, max_attempts, next_attempt_at,
            last_http_status, last_error, delivered_at, created_at, updated_at
     FROM webhook_outbox
     WHERE ($1::text IS NULL OR status = $1)
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [status, limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    eventId: row.event_id,
    eventType: row.event_type,
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    walletPublicKey: row.wallet_public_key,
    hdWalletId: row.hd_wallet_id === null ? null : String(row.hd_wallet_id),
    network: row.network,
    status: row.status,
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    nextAttemptAt: row.next_attempt_at,
    lastHttpStatus: row.last_http_status,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }));
}

export async function listTenantCredentials(db, { limit = 100, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT c.id, c.tenant_id, c.key_prefix, c.scopes, c.status, c.expires_at,
            c.last_used_at, c.revoked_at, c.created_at,
            t.tenant_code, t.display_name
     FROM tenant_api_credentials c
     INNER JOIN tenants t ON t.id = c.tenant_id
     ORDER BY c.created_at DESC, c.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    tenantId: String(row.tenant_id),
    tenantCode: row.tenant_code,
    tenantName: row.display_name,
    keyPrefix: row.key_prefix,
    scopes: row.scopes ?? [],
    status: row.status,
    expiresAt: row.expires_at,
    lastUsedAt: row.last_used_at,
    revokedAt: row.revoked_at,
    createdAt: row.created_at
  }));
}

export async function listTenants(db, { limit = 100, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT t.id, t.tenant_code, t.display_name, t.status, t.created_at,
            (SELECT COUNT(*)::text FROM hd_wallets h WHERE h.tenant_id = t.id) AS hd_wallets,
            (SELECT COUNT(*)::text FROM wallet_accounts a WHERE a.tenant_id = t.id) AS child_wallets
     FROM tenants t
     ORDER BY t.created_at DESC, t.id DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map((row) => ({
    id: String(row.id),
    tenantCode: row.tenant_code,
    displayName: row.display_name,
    status: row.status,
    hdWallets: Number(row.hd_wallets),
    childWallets: Number(row.child_wallets),
    createdAt: row.created_at
  }));
}

export async function listTenantPolicies(db, { limit = 100, offset = 0 } = {}) {
  const result = await db.query(
    `SELECT p.tenant_id, t.tenant_code, t.display_name, p.enabled,
            p.emergency_frozen, p.freeze_reason, p.max_single_lamports,
            p.max_daily_lamports, p.max_weekly_lamports, p.max_daily_count,
            p.max_weekly_count, p.policy_version, p.updated_at
     FROM tenant_withdrawal_policies p
     INNER JOIN tenants t ON t.id = p.tenant_id
     ORDER BY p.updated_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset]
  );

  return result.rows.map((row) => ({
    tenantId: String(row.tenant_id),
    tenantCode: row.tenant_code,
    tenantName: row.display_name,
    enabled: row.enabled,
    emergencyFrozen: row.emergency_frozen,
    freezeReason: row.freeze_reason,
    maxSingleLamports: String(row.max_single_lamports),
    maxDailyLamports: String(row.max_daily_lamports),
    maxWeeklyLamports: String(row.max_weekly_lamports),
    maxDailyCount: Number(row.max_daily_count),
    maxWeeklyCount: Number(row.max_weekly_count),
    policyVersion: Number(row.policy_version),
    updatedAt: row.updated_at
  }));
}

/**
 * Bucketed time series for the overview charts. `bucket` is validated by the
 * service (`hour` or `day`).
 */
export async function getActivitySeries(db, { since, bucket = 'day' } = {}) {
  const unit = bucket === 'hour' ? 'hour' : 'day';

  const [wallets, addresses, deposits, withdrawals] = await Promise.all([
    db.query(
      `SELECT date_trunc('${unit}', created_at) AS bucket, COUNT(*)::text AS count
       FROM hd_wallets WHERE created_at >= $1
       GROUP BY 1 ORDER BY 1`,
      [since]
    ),
    db.query(
      `SELECT date_trunc('${unit}', created_at) AS bucket, COUNT(*)::text AS count
       FROM wallet_accounts WHERE created_at >= $1
       GROUP BY 1 ORDER BY 1`,
      [since]
    ),
    db.query(
      `SELECT date_trunc('${unit}', created_at) AS bucket, COUNT(*)::text AS count
       FROM blockchain_transactions
       WHERE direction = 'deposit' AND created_at >= $1
       GROUP BY 1 ORDER BY 1`,
      [since]
    ),
    db.query(
      `SELECT date_trunc('${unit}', created_at) AS bucket, COUNT(*)::text AS count
       FROM api_idempotency_keys
       WHERE operation = 'withdrawal' AND created_at >= $1
       GROUP BY 1 ORDER BY 1`,
      [since]
    )
  ]);

  const mapRows = (result) => result.rows.map((row) => ({
    bucket: row.bucket,
    count: Number(row.count)
  }));

  return {
    bucket: unit,
    wallets: mapRows(wallets),
    addresses: mapRows(addresses),
    deposits: mapRows(deposits),
    withdrawals: mapRows(withdrawals)
  };
}