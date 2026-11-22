/**
 * blockchain_transactions repository: immutable deposit/withdrawal records.
 *
 * The identity of a record is (signature, wallet_public_key, direction); the
 * unique constraint makes deposit and withdrawal recording idempotent.
 */

const TX_COLUMNS = `
  id,
  tenant_id,
  signature,
  direction,
  wallet_public_key,
  hd_wallet_id,
  counterparty,
  amount_lamports,
  fee_lamports,
  network,
  commitment,
  status,
  slot,
  block_time,
  failure_reason,
  idempotency_key,
  metadata,
  created_at,
  updated_at
`;

export const TRANSACTION_STATUSES = Object.freeze([
  'detected',
  'confirming',
  'confirmed',
  'credited',
  'failed',
  'rejected',
  'under_review'
]);

export function mapBlockchainTransaction(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    tenantId: row.tenant_id === null || row.tenant_id === undefined ? null : String(row.tenant_id),
    signature: row.signature,
    direction: row.direction,
    walletPublicKey: row.wallet_public_key,
    hdWalletId: row.hd_wallet_id === null || row.hd_wallet_id === undefined
      ? null
      : String(row.hd_wallet_id),
    counterparty: row.counterparty,
    amountLamports: String(row.amount_lamports),
    feeLamports: row.fee_lamports === null ? null : String(row.fee_lamports),
    network: row.network,
    commitment: row.commitment,
    status: row.status,
    slot: row.slot === null ? null : Number(row.slot),
    blockTime: row.block_time,
    failureReason: row.failure_reason,
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Insert a transaction record, ignoring an existing identical identity.
 * @returns {{ transaction: object|null, created: boolean }}
 */
export async function insertBlockchainTransaction(
  db,
  {
    signature,
    direction,
    walletPublicKey,
    hdWalletId = null,
    counterparty = null,
    amountLamports,
    feeLamports = null,
    network,
    commitment = null,
    status = 'detected',
    slot = null,
    blockTime = null,
    idempotencyKey = null,
    metadata = {},
    tenantId = null
  }
) {
  const result = await db.query(
    `
      INSERT INTO blockchain_transactions (
        signature,
        direction,
        wallet_public_key,
        hd_wallet_id,
        counterparty,
        amount_lamports,
        fee_lamports,
        network,
        commitment,
        status,
        slot,
        block_time,
        idempotency_key,
        metadata,
        tenant_id
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15)
      ON CONFLICT (signature, wallet_public_key, direction) DO NOTHING
      RETURNING ${TX_COLUMNS}
    `,
    [
      signature,
      direction,
      walletPublicKey,
      hdWalletId,
      counterparty,
      amountLamports,
      feeLamports,
      network,
      commitment,
      status,
      slot,
      blockTime,
      idempotencyKey,
      JSON.stringify(metadata),
      tenantId === null ? null : String(tenantId)
    ]
  );

  if (result.rowCount === 0) {
    return { transaction: null, created: false };
  }

  return { transaction: mapBlockchainTransaction(result.rows[0]), created: true };
}

export async function findTransactionBySignature(db, signature, walletPublicKey, direction) {
  const result = await db.query(
    `
      SELECT ${TX_COLUMNS}
      FROM blockchain_transactions
      WHERE signature = $1 AND wallet_public_key = $2 AND direction = $3
      LIMIT 1
    `,
    [signature, walletPublicKey, direction]
  );

  return mapBlockchainTransaction(result.rows[0]);
}

/**
 * Advance a transaction's lifecycle state. Amounts and identity columns are
 * intentionally not updatable.
 */
export async function updateTransactionStatus(
  db,
  id,
  { status, commitment, slot, blockTime, failureReason, metadata, clearFailureReason = false }
) {
  if (!TRANSACTION_STATUSES.includes(status)) {
    throw new TypeError('Invalid transaction status');
  }

  const result = await db.query(
    `
      UPDATE blockchain_transactions
      SET
        status = $2,
        commitment = COALESCE($3, commitment),
        slot = COALESCE($4, slot),
        block_time = COALESCE($5, block_time),
        failure_reason = CASE WHEN $8 THEN NULL ELSE COALESCE($6, failure_reason) END,
        metadata = CASE WHEN $7::jsonb IS NULL THEN metadata ELSE metadata || $7::jsonb END,
        updated_at = NOW()
      WHERE id = $1
      RETURNING ${TX_COLUMNS}
    `,
    [
      id,
      status,
      commitment ?? null,
      slot ?? null,
      blockTime ?? null,
      failureReason ?? null,
      metadata ? JSON.stringify(metadata) : null,
      clearFailureReason === true
    ]
  );

  return mapBlockchainTransaction(result.rows[0]);
}

export async function listTransactionsByWallet(
  db,
  walletPublicKey,
  { direction = null, limit = 20, offset = 0 } = {}
) {
  const result = await db.query(
    `
      SELECT ${TX_COLUMNS}
      FROM blockchain_transactions
      WHERE wallet_public_key = $1
        AND ($2::text IS NULL OR direction = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4
    `,
    [walletPublicKey, direction, limit, offset]
  );

  return result.rows.map(mapBlockchainTransaction);
}

export async function listTransactionsByHdWallet(
  db,
  hdWalletId,
  { direction = null, limit = 20, offset = 0 } = {}
) {
  const result = await db.query(
    `
      SELECT ${TX_COLUMNS}
      FROM blockchain_transactions
      WHERE hd_wallet_id = $1
        AND ($2::text IS NULL OR direction = $2)
      ORDER BY created_at DESC, id DESC
      LIMIT $3 OFFSET $4
    `,
    [hdWalletId, direction, limit, offset]
  );

  return result.rows.map(mapBlockchainTransaction);
}


function assertTenantId(tenantId) {
  if ((typeof tenantId !== 'string' && typeof tenantId !== 'number' && typeof tenantId !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(tenantId))) {
    throw new TypeError('tenantId must be a positive integer');
  }
  return String(tenantId);
}

/** Tenant-only transaction lookup. NULL legacy rows are never visible. */
export async function findTransactionBySignatureForTenant(db, tenantId, signature, walletPublicKey, direction = 'deposit') {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT ${TX_COLUMNS}
     FROM blockchain_transactions
     WHERE tenant_id = $1 AND signature = $2
       AND wallet_public_key = $3 AND direction = $4
     LIMIT 1`,
    [tenant, signature, walletPublicKey, direction]
  );
  return mapBlockchainTransaction(result.rows[0]);
}

/** Tenant-only status transition; the UPDATE itself enforces ownership. */
export async function updateTransactionStatusForTenant(db, tenantId, id, input) {
  const tenant = assertTenantId(tenantId);
  const { status, commitment, slot, blockTime, failureReason, metadata, clearFailureReason = false } = input ?? {};
  if (!TRANSACTION_STATUSES.includes(status)) throw new TypeError('Invalid transaction status');
  const result = await db.query(
    `UPDATE blockchain_transactions
     SET status = $3,
         commitment = COALESCE($4, commitment),
         slot = COALESCE($5, slot),
         block_time = COALESCE($6, block_time),
         failure_reason = CASE WHEN $9 THEN NULL ELSE COALESCE($7, failure_reason) END,
         metadata = CASE WHEN $8::jsonb IS NULL THEN metadata ELSE metadata || $8::jsonb END,
         updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${TX_COLUMNS}`,
    [tenant, id, status, commitment ?? null, slot ?? null, blockTime ?? null,
      failureReason ?? null, metadata ? JSON.stringify(metadata) : null, clearFailureReason === true]
  );
  return mapBlockchainTransaction(result.rows[0]);
}

/** Tenant-only deposit history; never returns unassigned legacy rows. */
export async function listDepositsForTenant(db, tenantId, { limit = 20, offset = 0 } = {}) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT ${TX_COLUMNS}
     FROM blockchain_transactions
     WHERE tenant_id = $1 AND direction = 'deposit'
     ORDER BY created_at DESC, id DESC
     LIMIT $2 OFFSET $3`,
    [tenant, limit, offset]
  );
  return result.rows.map(mapBlockchainTransaction);
}
