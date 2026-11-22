/**
 * HD root persistence and transaction-safe account index allocation.
 *
 * Every function accepts a query executor (pool or an already-checked-out
 * client) so callers can compose operations inside one transaction.
 */

const HD_WALLET_COLUMNS = `
  id,
  owner_id,
  label,
  network,
  derivation_scheme,
  derivation_path_template,
  mnemonic_encrypted,
  mnemonic_iv,
  mnemonic_auth_tag,
  encryption_key_version,
  next_account_index,
  status,
  phrase_provisioned_at,
  recovery_token_hash,
  recovery_token_expires_at,
  created_at,
  updated_at
`;

const INDEX_LOCK_CLASS = 'hd_index_alloc';

function mapHdWallet(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    ownerId: row.owner_id,
    label: row.label,
    network: row.network,
    derivationScheme: row.derivation_scheme,
    derivationPathTemplate: row.derivation_path_template,
    nextAccountIndex: Number(row.next_account_index),
    status: row.status,
    phraseProvisionedAt: row.phrase_provisioned_at,
    recoveryTokenHash: row.recovery_token_hash ?? null,
    recoveryTokenExpiresAt: row.recovery_token_expires_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    // Encrypted material is only returned to the repository layer's caller
    // (the signer / provisioning service); it is never serialized to an API.
    encryptionKeyVersion: row.encryption_key_version,
    mnemonicEncrypted: row.mnemonic_encrypted,
    mnemonicIv: row.mnemonic_iv,
    mnemonicAuthTag: row.mnemonic_auth_tag
  };
}

export async function insertHdWallet(
  db,
  {
    ownerId = null,
    label = null,
    network,
    derivationScheme,
    derivationPathTemplate,
    mnemonicEncrypted,
    mnemonicIv,
    mnemonicAuthTag,
    encryptionKeyVersion,
    status = 'active'
  }
) {
  const result = await db.query(
    `
      INSERT INTO hd_wallets (
        owner_id,
        label,
        network,
        derivation_scheme,
        derivation_path_template,
        mnemonic_encrypted,
        mnemonic_iv,
        mnemonic_auth_tag,
        encryption_key_version,
        status
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING ${HD_WALLET_COLUMNS}
    `,
    [
      ownerId,
      label,
      network,
      derivationScheme,
      derivationPathTemplate,
      mnemonicEncrypted,
      mnemonicIv,
      mnemonicAuthTag,
      encryptionKeyVersion,
      status
    ]
  );

  return mapHdWallet(result.rows[0]);
}

export async function findHdWalletById(db, id) {
  const result = await db.query(
    `SELECT ${HD_WALLET_COLUMNS} FROM hd_wallets WHERE id = $1 LIMIT 1`,
    [id]
  );

  return mapHdWallet(result.rows[0]);
}

/**
 * Lock the HD root row FOR UPDATE, allocate `count` consecutive account
 * indexes and advance `next_account_index`.
 *
 * Concurrency safety: the row lock serializes concurrent allocators of the
 * same root, and the (hd_wallet_id, account_index) unique constraint plus the
 * monotonic counter make reuse impossible even after rollbacks.
 *
 * Must be called with an open transaction; the caller commits or rolls back.
 *
 * @returns {Promise<{ hdWallet: object, indexes: number[] } | null>}
 */
export async function allocateAccountIndexes(client, hdWalletId, count) {
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('Allocation count must be a positive integer');
  }

  // The advisory lock serializes allocators for this root; the row lock below
  // additionally orders every writer of the row itself.
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    `${INDEX_LOCK_CLASS}:${hdWalletId}`
  ]);

  const locked = await client.query(
    `
      SELECT ${HD_WALLET_COLUMNS}
      FROM hd_wallets
      WHERE id = $1
      FOR UPDATE
    `,
    [hdWalletId]
  );

  const hdWallet = mapHdWallet(locked.rows[0]);

  if (!hdWallet) {
    return null;
  }

  const start = hdWallet.nextAccountIndex;
  const indexes = Array.from({ length: count }, (_, offset) => start + offset);

  const updated = await client.query(
    `
      UPDATE hd_wallets
      SET next_account_index = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${HD_WALLET_COLUMNS}
    `,
    [hdWalletId, start + count]
  );

  if (updated.rowCount !== 1) {
    throw new Error('HD wallet counter update affected an unexpected row count');
  }

  return {
    hdWallet: mapHdWallet(updated.rows[0]),
    indexes
  };
}

/**
 * Rewind the allocator after a fully failed batch so indexes are not burned.
 * Only allowed while no accounts exist above the given baseline.
 */
export async function rewindAccountIndex(client, hdWalletId, baselineIndex) {
  const result = await client.query(
    `
      UPDATE hd_wallets
      SET next_account_index = $2, updated_at = NOW()
      WHERE id = $1
        AND next_account_index > $2
        AND NOT EXISTS (
          SELECT 1 FROM wallet_accounts
          WHERE hd_wallet_id = $1 AND account_index >= $2
        )
      RETURNING next_account_index
    `,
    [hdWalletId, baselineIndex]
  );

  return result.rowCount === 1;
}

export async function updateHdWalletStatus(db, hdWalletId, status) {
  const result = await db.query(
    `
      UPDATE hd_wallets
      SET status = $2, updated_at = NOW()
      WHERE id = $1
      RETURNING ${HD_WALLET_COLUMNS}
    `,
    [hdWalletId, status]
  );

  return mapHdWallet(result.rows[0]);
}

/**
 * Mark that the one-time recovery phrase was shown to an operator.
 *
 * Single-winner semantics: only the caller whose UPDATE matches an
 * un-provisioned row gets `true`; every concurrent caller gets `false`.
 */
export async function markPhraseProvisioned(db, hdWalletId) {
  const result = await db.query(
    `
      UPDATE hd_wallets
      SET phrase_provisioned_at = NOW(),
          recovery_token_hash = NULL,
          recovery_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1 AND phrase_provisioned_at IS NULL
      RETURNING phrase_provisioned_at
    `,
    [hdWalletId]
  );

  return result.rowCount === 1;
}

/**
 * Atomically redeem a recovery token.
 *
 * The UPDATE is the authoritative one-time check: it only matches when the row
 * is still un-provisioned *and* the stored token hash equals the presented
 * token's hash. Concurrent redemptions therefore produce exactly one winner.
 *
 * @returns {Promise<{ redeemed: boolean, reason?: string }>}
 */
export async function redeemRecoveryToken(db, hdWalletId, tokenHash) {
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError('tokenHash must be a lowercase SHA-256 hex digest');
  }

  const result = await db.query(
    `
      UPDATE hd_wallets
      SET phrase_provisioned_at = NOW(),
          recovery_token_hash = NULL,
          recovery_token_expires_at = NULL,
          updated_at = NOW()
      WHERE id = $1
        AND phrase_provisioned_at IS NULL
        AND recovery_token_hash = $2
        AND recovery_token_expires_at IS NOT NULL
        AND recovery_token_expires_at > NOW()
      RETURNING id
    `,
    [hdWalletId, tokenHash]
  );

  if (result.rowCount === 1) {
    return { redeemed: true };
  }

  return { redeemed: false };
}

/**
 * Store the (hashed) recovery token for a freshly created root.
 *
 * Only the SHA-256 hash of the plaintext token and its server-side expiry are
 * persisted; the plaintext token itself is never written to the database.
 *
 * @returns {Promise<number>} number of affected rows (0 when the root does not
 *   exist or its phrase is already provisioned) so the caller can fail closed.
 */
export async function storeRecoveryToken(db, hdWalletId, { tokenHash, expiresAt }) {
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError('tokenHash must be a lowercase SHA-256 hex digest');
  }

  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('expiresAt must be a valid Date');
  }

  const result = await db.query(
    `
      UPDATE hd_wallets
      SET recovery_token_hash = $2,
          recovery_token_expires_at = $3,
          updated_at = NOW()
      WHERE id = $1 AND phrase_provisioned_at IS NULL
      RETURNING id
    `,
    [hdWalletId, tokenHash, expiresAt]
  );

  return result.rowCount;
}

export async function listHdWallets(db, { ownerId = null, limit = 50 } = {}) {
  const result = await db.query(
    `
      SELECT ${HD_WALLET_COLUMNS}
      FROM hd_wallets
      WHERE ($1::text IS NULL OR owner_id = $1)
      ORDER BY created_at ASC, id ASC
      LIMIT $2
    `,
    [ownerId, limit]
  );

  return result.rows.map(mapHdWallet);
}

/**
 * Public metadata only (no encrypted material).
 */
export function toHdWalletMetadata(hdWallet) {
  if (!hdWallet) return null;

  return {
    id: hdWallet.id,
    ownerId: hdWallet.ownerId,
    label: hdWallet.label,
    network: hdWallet.network,
    derivationScheme: hdWallet.derivationScheme,
    derivationPathTemplate: hdWallet.derivationPathTemplate,
    nextAccountIndex: hdWallet.nextAccountIndex,
    status: hdWallet.status,
    phraseProvisioned: hdWallet.phraseProvisionedAt !== null,
    recoveryTokenActive: Boolean(
      hdWallet.recoveryTokenHash &&
      hdWallet.recoveryTokenExpiresAt &&
      new Date(hdWallet.recoveryTokenExpiresAt).getTime() > Date.now()
    ),
    createdAt: hdWallet.createdAt,
    updatedAt: hdWallet.updatedAt
  };
}
