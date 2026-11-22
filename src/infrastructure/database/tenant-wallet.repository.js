/**
 * Tenant-scoped read/update operations for Solana HD wallets and child accounts.
 *
 * These functions deliberately require tenantId. They never fall back to
 * legacy rows whose tenant_id is NULL.
 */
import { mapHdWallet } from './hd-wallet.repository.js';
import { mapWalletAccount, ACCOUNT_STATUSES } from './wallet-account.repository.js';

function assertTenantId(tenantId) {
  if (
    (typeof tenantId !== 'string' && typeof tenantId !== 'number' && typeof tenantId !== 'bigint') ||
    !/^[1-9][0-9]*$/.test(String(tenantId))
  ) {
    throw new TypeError('tenantId must be a positive integer');
  }

  return String(tenantId);
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

  return mapHdWallet(result.rows[0]);
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
