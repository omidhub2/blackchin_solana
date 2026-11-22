/**
 * wallet_accounts repository: HD child wallets.
 */
import { deriveAccountPath } from '../../blockchain/solana/hd/derivation.js';
import { findHdWalletById } from './hd-wallet.repository.js';

const ACCOUNT_COLUMNS = `
  id,
  hd_wallet_id,
  public_key,
  account_index,
  derivation_path,
  wallet_type,
  network,
  status,
  created_at,
  updated_at
`;

export const ACCOUNT_STATUSES = Object.freeze(['active', 'disabled', 'archived']);

export function mapWalletAccount(row) {
  if (!row) return null;

  return {
    id: String(row.id),
    hdWalletId: row.hd_wallet_id === null || row.hd_wallet_id === undefined
      ? null
      : String(row.hd_wallet_id),
    publicKey: row.public_key,
    accountIndex: Number(row.account_index),
    derivationPath: row.derivation_path,
    walletType: row.wallet_type,
    network: row.network,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

/**
 * Insert many child accounts in one statement (single round trip).
 * @param {object} db pool or client
 * @param {Array<{hdWalletId: string|number, publicKey: string, accountIndex: number,
 *   derivationPath: string, network: string}>} accounts
 */
export async function insertWalletAccounts(db, accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    return [];
  }

  // Detect conflicting derivation metadata before deriving anything.
  const touchedHdWallets = new Map(
    accounts.map((account) => [String(account.hdWalletId), account])
  );

  if (touchedHdWallets.size !== 1) {
    const error = new Error('All accounts in one batch must belong to the same HD wallet');
    error.statusCode = 400;
    error.code = 'MIXED_HD_WALLETS';
    throw error;
  }

  const [hdWalletId, representative] = touchedHdWallets.entries().next().value;
  const hdWallet = await findHdWalletById(db, hdWalletId);

  if (!hdWallet) {
    const error = new Error('HD wallet was not found');
    error.statusCode = 404;
    error.code = 'HD_WALLET_NOT_FOUND';
    throw error;
  }

  if (hdWallet.derivationScheme !== representative.scheme) {
    const error = new Error(
      'Account derivation scheme does not match the parent HD wallet'
    );
    error.statusCode = 409;
    error.code = 'DERIVATION_SCHEME_MISMATCH';
    throw error;
  }

  if (hdWallet.network !== representative.network) {
    const error = new Error('Account network does not match the parent HD wallet');
    error.statusCode = 409;
    error.code = 'NETWORK_MISMATCH';
    throw error;
  }

  const derivationPaths = [];

  for (const account of accounts) {
    if (String(account.hdWalletId) !== hdWalletId) {
      const error = new Error('All accounts in one batch must belong to the same HD wallet');
      error.statusCode = 400;
      error.code = 'MIXED_HD_WALLETS';
      throw error;
    }

    const expectedPath = deriveAccountPath(account.accountIndex);

    if (account.derivationPath !== expectedPath) {
      const error = new Error(
        `Derivation path ${account.derivationPath} does not match index ${account.accountIndex} (expected ${expectedPath})`
      );
      error.statusCode = 400;
      error.code = 'INVALID_DERIVATION_PATH';
      throw error;
    }

    derivationPaths.push(expectedPath);
  }

  const result = await db.query(
    `
      INSERT INTO wallet_accounts (
        hd_wallet_id,
        public_key,
        account_index,
        derivation_path,
        network
      )
      SELECT * FROM UNNEST($1::bigint[], $2::text[], $3::bigint[], $4::text[], $5::text[])
      RETURNING ${ACCOUNT_COLUMNS}
    `,
    [
      accounts.map((account) => account.hdWalletId),
      accounts.map((account) => account.publicKey),
      accounts.map((account) => account.accountIndex),
      derivationPaths,
      accounts.map((account) => account.network)
    ]
  );

  return result.rows.map(mapWalletAccount);
}

export async function findAccountById(db, id) {
  const result = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts WHERE id = $1 LIMIT 1`,
    [id]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function findAccountByPublicKey(db, publicKey) {
  const result = await db.query(
    `SELECT ${ACCOUNT_COLUMNS} FROM wallet_accounts WHERE public_key = $1 LIMIT 1`,
    [publicKey]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function findAccountAtIndex(db, hdWalletId, accountIndex) {
  const result = await db.query(
    `
      SELECT ${ACCOUNT_COLUMNS}
      FROM wallet_accounts
      WHERE hd_wallet_id = $1 AND account_index = $2
      LIMIT 1
    `,
    [hdWalletId, accountIndex]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function findAccountByPath(db, hdWalletId, derivationPath) {
  const result = await db.query(
    `
      SELECT ${ACCOUNT_COLUMNS}
      FROM wallet_accounts
      WHERE hd_wallet_id = $1 AND derivation_path = $2
      LIMIT 1
    `,
    [hdWalletId, derivationPath]
  );

  return mapWalletAccount(result.rows[0]);
}

export async function listAccountsByHdWallet(db, hdWalletId, { limit = 100, offset = 0 } = {}) {
  const result = await db.query(
    `
      SELECT ${ACCOUNT_COLUMNS}
      FROM wallet_accounts
      WHERE hd_wallet_id = $1
      ORDER BY account_index ASC
      LIMIT $2 OFFSET $3
    `,
    [hdWalletId, limit, offset]
  );

  return result.rows.map(mapWalletAccount);
}

export async function countAccountsByHdWallet(db, hdWalletId) {
  const result = await db.query(
    'SELECT COUNT(*)::text AS total FROM wallet_accounts WHERE hd_wallet_id = $1',
    [hdWalletId]
  );

  return Number(result.rows[0].total);
}

export async function updateAccountStatus(db, publicKey, status) {
  if (!ACCOUNT_STATUSES.includes(status)) {
    throw new TypeError('Invalid wallet account status');
  }

  const result = await db.query(
    `
      UPDATE wallet_accounts
      SET status = $2, updated_at = NOW()
      WHERE public_key = $1
      RETURNING ${ACCOUNT_COLUMNS}
    `,
    [publicKey, status]
  );

  return mapWalletAccount(result.rows[0]);
}
