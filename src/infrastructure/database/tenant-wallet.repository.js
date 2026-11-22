/**
 * Tenant-scoped read/update operations for Solana HD wallets and child accounts.
 *
 * These functions deliberately require tenantId. They never fall back to
 * legacy rows whose tenant_id is NULL.
 */
import { mapWalletAccount, ACCOUNT_STATUSES } from './wallet-account.repository.js';
import { deriveAccountPath } from '../../blockchain/solana/hd/derivation.js';

function assertTenantId(tenantId) {
  if (
    (typeof tenantId !== 'string' && typeof tenantId !== 'number' && typeof tenantId !== 'bigint') ||
    !/^[1-9][0-9]*$/.test(String(tenantId))
  ) {
    throw new TypeError('tenantId must be a positive integer');
  }

  return String(tenantId);
}

function mapTenantHdWallet(row) {
  if (!row) return null;
  return {
    id: String(row.id), ownerId: row.owner_id, label: row.label, network: row.network,
    derivationScheme: row.derivation_scheme, derivationPathTemplate: row.derivation_path_template,
    nextAccountIndex: Number(row.next_account_index), status: row.status,
    phraseProvisionedAt: row.phrase_provisioned_at,
    recoveryTokenHash: row.recovery_token_hash ?? null,
    recoveryTokenExpiresAt: row.recovery_token_expires_at ?? null,
    createdAt: row.created_at, updatedAt: row.updated_at,
    encryptionKeyVersion: row.encryption_key_version,
    mnemonicEncrypted: row.mnemonic_encrypted, mnemonicIv: row.mnemonic_iv,
    mnemonicAuthTag: row.mnemonic_auth_tag
  };
}
export async function findHdWalletByIdForTenant(db, tenantId, hdWalletId) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, owner_id, label, network, derivation_scheme,
            derivation_path_template, mnemonic_encrypted, mnemonic_iv,
            mnemonic_auth_tag, encryption_key_version, next_account_index,
            status, phrase_provisioned_at, recovery_token_hash,
            recovery_token_expires_at, created_at, updated_at
     FROM hd_wallets
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenant, hdWalletId]
  );

  return mapTenantHdWallet(result.rows[0]);
}

export async function findAccountByIdForTenant(db, tenantId, accountId) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, hd_wallet_id, public_key, account_index, derivation_path,
            wallet_type, network, status, created_at, updated_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND id = $2
     LIMIT 1`,
    [tenant, accountId]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function findAccountByPublicKeyForTenant(db, tenantId, publicKey) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, hd_wallet_id, public_key, account_index, derivation_path,
            wallet_type, network, status, created_at, updated_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND public_key = $2
     LIMIT 1`,
    [tenant, publicKey]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function findAccountAtIndexForTenant(db, tenantId, hdWalletId, accountIndex) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, hd_wallet_id, public_key, account_index, derivation_path,
            wallet_type, network, status, created_at, updated_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND hd_wallet_id = $2 AND account_index = $3
     LIMIT 1`,
    [tenant, hdWalletId, accountIndex]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function listAccountsByHdWalletForTenant(
  db,
  tenantId,
  hdWalletId,
  { limit = 100, offset = 0 } = {}
) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, hd_wallet_id, public_key, account_index, derivation_path,
            wallet_type, network, status, created_at, updated_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND hd_wallet_id = $2
     ORDER BY account_index ASC
     LIMIT $3 OFFSET $4`,
    [tenant, hdWalletId, limit, offset]
  );

  return result.rows.map(mapWalletAccount);
}

export async function countAccountsByHdWalletForTenant(db, tenantId, hdWalletId) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    'SELECT COUNT(*)::text AS total FROM wallet_accounts WHERE tenant_id = $1 AND hd_wallet_id = $2',
    [tenant, hdWalletId]
  );

  return Number(result.rows[0]?.total ?? 0);
}

export async function updateAccountStatusForTenant(db, tenantId, publicKey, status) {
  const tenant = assertTenantId(tenantId);
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw new TypeError('Invalid wallet account status');
  }

  const result = await db.query(
    `UPDATE wallet_accounts
     SET status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND public_key = $2
     RETURNING id, hd_wallet_id, public_key, account_index, derivation_path,
               wallet_type, network, status, created_at, updated_at`,
    [tenant, publicKey, status]
  );

  return mapWalletAccount(result.rows[0]);
}


const HD_WALLET_COLUMNS = `
  id, owner_id, label, network, derivation_scheme, derivation_path_template,
  mnemonic_encrypted, mnemonic_iv, mnemonic_auth_tag, encryption_key_version,
  next_account_index, status, phrase_provisioned_at, recovery_token_hash,
  recovery_token_expires_at, created_at, updated_at
`;

export async function insertHdWalletForTenant(db, tenantId, input) {
  const tenant = assertTenantId(tenantId);
  const {
    ownerId = null, label = null, network, derivationScheme,
    derivationPathTemplate, mnemonicEncrypted, mnemonicIv, mnemonicAuthTag,
    encryptionKeyVersion, status = 'provisioning'
  } = input ?? {};
  const result = await db.query(
    `INSERT INTO hd_wallets (
       tenant_id, owner_id, label, network, derivation_scheme,
       derivation_path_template, mnemonic_encrypted, mnemonic_iv,
       mnemonic_auth_tag, encryption_key_version, status
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${HD_WALLET_COLUMNS}`,
    [tenant, ownerId, label, network, derivationScheme, derivationPathTemplate,
      mnemonicEncrypted, mnemonicIv, mnemonicAuthTag, encryptionKeyVersion, status]
  );
  return mapTenantHdWallet(result.rows[0]);
}

export async function updateHdWalletStatusForTenant(db, tenantId, hdWalletId, status) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `UPDATE hd_wallets SET status = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${HD_WALLET_COLUMNS}`,
    [tenant, hdWalletId, status]
  );
  return mapTenantHdWallet(result.rows[0]);
}

export async function storeRecoveryTokenForTenant(db, tenantId, hdWalletId, { tokenHash, expiresAt }) {
  const tenant = assertTenantId(tenantId);
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError('tokenHash must be a lowercase SHA-256 digest');
  }
  if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime())) {
    throw new TypeError('expiresAt must be a valid Date');
  }
  const result = await db.query(
    `UPDATE hd_wallets
     SET recovery_token_hash = $3, recovery_token_expires_at = $4, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND phrase_provisioned_at IS NULL
     RETURNING id`,
    [tenant, hdWalletId, tokenHash, expiresAt]
  );
  return result.rowCount;
}

export async function redeemRecoveryTokenForTenant(db, tenantId, hdWalletId, tokenHash) {
  const tenant = assertTenantId(tenantId);
  if (typeof tokenHash !== 'string' || !/^[a-f0-9]{64}$/.test(tokenHash)) {
    throw new TypeError('tokenHash must be a lowercase SHA-256 digest');
  }
  const result = await db.query(
    `UPDATE hd_wallets
     SET phrase_provisioned_at = NOW(), recovery_token_hash = NULL,
         recovery_token_expires_at = NULL, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND phrase_provisioned_at IS NULL
       AND recovery_token_hash = $3 AND recovery_token_expires_at > NOW()
     RETURNING id`,
    [tenant, hdWalletId, tokenHash]
  );
  return { redeemed: result.rowCount === 1 };
}

export async function allocateAccountIndexesForTenant(client, tenantId, hdWalletId, count) {
  const tenant = assertTenantId(tenantId);
  if (!Number.isSafeInteger(count) || count < 1) {
    throw new RangeError('Allocation count must be a positive integer');
  }
  await client.query('SELECT pg_advisory_xact_lock(hashtext($1)::bigint)', [
    `hd_index_alloc:tenant:${tenant}:${hdWalletId}`
  ]);
  const locked = await client.query(
    `SELECT ${HD_WALLET_COLUMNS} FROM hd_wallets
     WHERE tenant_id = $1 AND id = $2 FOR UPDATE`,
    [tenant, hdWalletId]
  );
  const hdWallet = mapTenantHdWallet(locked.rows[0]);
  if (!hdWallet) return null;
  const start = hdWallet.nextAccountIndex;
  const indexes = Array.from({ length: count }, (_, offset) => start + offset);
  const updated = await client.query(
    `UPDATE hd_wallets SET next_account_index = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2
     RETURNING ${HD_WALLET_COLUMNS}`,
    [tenant, hdWalletId, start + count]
  );
  if (updated.rowCount !== 1) {
    throw new Error('Tenant HD wallet counter update affected an unexpected row count');
  }
  return { hdWallet: mapTenantHdWallet(updated.rows[0]), indexes };
}

export async function rewindAccountIndexForTenant(client, tenantId, hdWalletId, baselineIndex) {
  const tenant = assertTenantId(tenantId);
  const result = await client.query(
    `UPDATE hd_wallets SET next_account_index = $3, updated_at = NOW()
     WHERE tenant_id = $1 AND id = $2 AND next_account_index > $3
       AND NOT EXISTS (
         SELECT 1 FROM wallet_accounts
         WHERE tenant_id = $1 AND hd_wallet_id = $2 AND account_index >= $3
       )
     RETURNING next_account_index`,
    [tenant, hdWalletId, baselineIndex]
  );
  return result.rowCount === 1;
}

export async function insertWalletAccountsForTenant(db, tenantId, accounts) {
  const tenant = assertTenantId(tenantId);
  if (!Array.isArray(accounts) || accounts.length === 0) return [];
  const walletIds = new Set(accounts.map((account) => String(account.hdWalletId)));
  if (walletIds.size !== 1) {
    const error = new Error('All accounts in one batch must belong to the same HD wallet');
    error.statusCode = 400;
    error.code = 'MIXED_HD_WALLETS';
    throw error;
  }
  const hdWalletId = [...walletIds][0];
  const parentResult = await db.query(
    `SELECT network, derivation_scheme FROM hd_wallets
     WHERE tenant_id = $1 AND id = $2 LIMIT 1`,
    [tenant, hdWalletId]
  );
  const parent = parentResult.rows[0];
  if (!parent) {
    const error = new Error('HD wallet was not found');
    error.statusCode = 404;
    error.code = 'HD_WALLET_NOT_FOUND';
    throw error;
  }
  const derivationPaths = [];
  for (const account of accounts) {
    if (String(account.hdWalletId) !== hdWalletId) {
      const error = new Error('Mixed HD wallet batch');
      error.statusCode = 400;
      error.code = 'MIXED_HD_WALLETS';
      throw error;
    }
    const expectedPath = deriveAccountPath(account.accountIndex);
    if (account.derivationPath !== expectedPath) {
      const error = new Error('Account derivation path does not match its index');
      error.statusCode = 400;
      error.code = 'INVALID_DERIVATION_PATH';
      throw error;
    }
    if (account.scheme !== parent.derivation_scheme) {
      const error = new Error('Account derivation scheme does not match its parent');
      error.statusCode = 409;
      error.code = 'DERIVATION_SCHEME_MISMATCH';
      throw error;
    }
    if (account.network !== parent.network) {
      const error = new Error('Account network does not match its parent');
      error.statusCode = 409;
      error.code = 'NETWORK_MISMATCH';
      throw error;
    }
    derivationPaths.push(expectedPath);
  }
  const result = await db.query(
    `INSERT INTO wallet_accounts (
       tenant_id, hd_wallet_id, public_key, account_index, derivation_path, network
     )
     SELECT $1, rows.hd_wallet_id, rows.public_key, rows.account_index,
            rows.derivation_path, rows.network
     FROM UNNEST($2::bigint[], $3::text[], $4::bigint[], $5::text[], $6::text[])
       AS rows(hd_wallet_id, public_key, account_index, derivation_path, network)
     RETURNING id, hd_wallet_id, public_key, account_index, derivation_path,
               wallet_type, network, status, created_at, updated_at`,
    [tenant, accounts.map((account) => account.hdWalletId),
      accounts.map((account) => account.publicKey),
      accounts.map((account) => account.accountIndex), derivationPaths,
      accounts.map((account) => account.network)]
  );
  return result.rows.map(mapWalletAccount);
}

export async function findAccountByPathForTenant(db, tenantId, hdWalletId, derivationPath) {
  const tenant = assertTenantId(tenantId);
  const result = await db.query(
    `SELECT id, hd_wallet_id, public_key, account_index, derivation_path,
            wallet_type, network, status, created_at, updated_at
     FROM wallet_accounts
     WHERE tenant_id = $1 AND hd_wallet_id = $2 AND derivation_path = $3
     LIMIT 1`,
    [tenant, hdWalletId, derivationPath]
  );
  return mapWalletAccount(result.rows[0]);
}
