import { conflict, notFound } from '../errors.js';
import { deriveSolanaAccount, validateAccountIndex } from '../../blockchain/solana/hd/derivation.js';
import {
  allocateAccountIndexes,
  findHdWalletById,
  rewindAccountIndex
} from '../../infrastructure/database/hd-wallet.repository.js';
import {
  ACCOUNT_STATUSES,
  countAccountsByHdWallet,
  findAccountAtIndex,
  findAccountById,
  findAccountByPath,
  findAccountByPublicKey,
  insertWalletAccounts,
  listAccountsByHdWallet,
  updateAccountStatus
} from '../../infrastructure/database/wallet-account.repository.js';

export const MAX_BATCH_SIZE = 50;
export const DEFAULT_LIST_LIMIT = 100;
export const MAX_LIST_LIMIT = 500;

function mapUniqueViolation(error) {
  if (error?.code === '23505') {
    if (String(error.constraint).includes('public_key')) {
      return conflict('A wallet with this public key already exists', 'DUPLICATE_PUBLIC_KEY');
    }

    return conflict(
      'Derivation index or path is already allocated for this HD wallet',
      'DUPLICATE_ACCOUNT_INDEX'
    );
  }

  return error;
}

/**
 * Allocate `count` indexes for one HD root and persist the derived accounts.
 *
 * @param {object} deps
 * @param {object} deps.db
 * @param {string|number} hdWalletId
 * @param {{ count: number, mnemonicResolver: () => Promise<string> }} options
 *   `mnemonicResolver` decrypts the root mnemonic; it is called only after the
 *   index has been reserved inside the transaction.
 */
export async function createAccountsInTransaction(
  { db },
  hdWalletId,
  { count, mnemonicResolver }
) {
  if (!Number.isSafeInteger(count) || count < 1 || count > MAX_BATCH_SIZE) {
    throw conflict(`count must be an integer between 1 and ${MAX_BATCH_SIZE}`, 'INVALID_BATCH_SIZE');
  }

  if (typeof mnemonicResolver !== 'function') {
    throw new TypeError('A mnemonic resolver is required');
  }

  const client = await db.connect();
  let baseline;
  let reserved = false;

  try {
    await client.query('BEGIN');

    const allocation = await allocateAccountIndexes(client, hdWalletId, count);

    if (!allocation) {
      throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
    }

    if (allocation.hdWallet.status !== 'active') {
      throw conflict(
        `HD wallet is ${allocation.hdWallet.status} and cannot create new accounts`,
        'HD_WALLET_NOT_ACTIVE'
      );
    }

    const { hdWallet, indexes } = allocation;
    baseline = hdWallet.nextAccountIndex - count;
    reserved = true;

    const mnemonic = await mnemonicResolver(hdWalletId);

    const derived = indexes.map((accountIndex) => {
      const account = deriveSolanaAccount(mnemonic, accountIndex);
      account.secretKey.fill(0);
      account.keypair.secretKey.fill(0);
      return account;
    });

    const inserted = await insertWalletAccounts(
      client,
      derived.map((account) => ({
        hdWalletId,
        publicKey: account.publicKey,
        accountIndex: account.accountIndex,
        derivationPath: account.derivationPath,
        network: hdWallet.network,
        scheme: hdWallet.derivationScheme
      }))
    );

    await client.query('COMMIT');

    return {
      hdWalletId: String(hdWalletId),
      accounts: inserted,
      nextAccountIndex: hdWallet.nextAccountIndex
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});

    if (reserved && baseline !== undefined) {
      // Nothing committed: give the indexes back instead of burning them.
      await rewindAccountIndex(db, hdWalletId, baseline).catch(() => {});
    }

    throw mapUniqueViolation(error);
  } finally {
    client.release();
  }
}

export function createChildWalletService({ db }) {
  async function requireHdWallet(hdWalletId) {
    const hdWallet = await findHdWalletById(db, hdWalletId);

    if (!hdWallet) {
      throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
    }

    return hdWallet;
  }

  return Object.freeze({
    async createAccounts(hdWalletId, { count = 1, resolveMnemonic }) {
      return createAccountsInTransaction({ db }, hdWalletId, {
        count,
        mnemonicResolver: resolveMnemonic
      });
    },

    async createAccount(hdWalletId, { resolveMnemonic } = {}) {
      const result = await createAccountsInTransaction({ db }, hdWalletId, {
        count: 1,
        mnemonicResolver: resolveMnemonic
      });

      return { account: result.accounts[0], nextAccountIndex: result.nextAccountIndex };
    },

    async getAccountById(accountId) {
      const account = await findAccountById(db, accountId);

      if (!account) {
        throw notFound('Wallet account was not found', 'WALLET_ACCOUNT_NOT_FOUND');
      }

      return account;
    },

    async getAccountByPublicKey(publicKey) {
      return findAccountByPublicKey(db, publicKey);
    },

    async getAccountAtIndex(hdWalletId, accountIndex) {
      validateAccountIndex(accountIndex);

      const account = await findAccountAtIndex(db, hdWalletId, accountIndex);

      if (!account) {
        throw notFound(
          'Wallet account was not found for this derivation index',
          'WALLET_ACCOUNT_NOT_FOUND'
        );
      }

      return account;
    },

    async getAccountByPath(hdWalletId, derivationPath) {
      const account = await findAccountByPath(db, hdWalletId, derivationPath);

      if (!account) {
        throw notFound(
          'Wallet account was not found for this derivation path',
          'WALLET_ACCOUNT_NOT_FOUND'
        );
      }

      return account;
    },

    async listAccounts(hdWalletId, { limit = DEFAULT_LIST_LIMIT, offset = 0 } = {}) {
      await requireHdWallet(hdWalletId);

      const normalizedLimit = Math.min(
        Math.max(Number.isSafeInteger(limit) ? limit : DEFAULT_LIST_LIMIT, 1),
        MAX_LIST_LIMIT
      );
      const normalizedOffset = Number.isSafeInteger(offset) && offset > 0 ? offset : 0;

      const [accounts, total] = await Promise.all([
        listAccountsByHdWallet(db, hdWalletId, {
          limit: normalizedLimit,
          offset: normalizedOffset
        }),
        countAccountsByHdWallet(db, hdWalletId)
      ]);

      return {
        hdWalletId: String(hdWalletId),
        total,
        limit: normalizedLimit,
        offset: normalizedOffset,
        items: accounts
      };
    },

    async setAccountStatus(publicKey, status) {
      if (!ACCOUNT_STATUSES.includes(status)) {
        throw conflict('Invalid wallet account status', 'INVALID_ACCOUNT_STATUS');
      }

      const updated = await updateAccountStatus(db, publicKey, status);

      if (!updated) {
        throw notFound('Wallet account was not found', 'WALLET_ACCOUNT_NOT_FOUND');
      }

      return updated;
    },

    async isIndexAllocated(hdWalletId, accountIndex) {
      validateAccountIndex(accountIndex);

      const account = await findAccountAtIndex(db, hdWalletId, accountIndex);

      return {
        hdWalletId: String(hdWalletId),
        accountIndex,
        allocated: account !== null,
        publicKey: account?.publicKey ?? null
      };
    },

    async nextIndexPreview(hdWalletId) {
      const hdWallet = await requireHdWallet(hdWalletId);

      return { hdWalletId: String(hdWalletId), nextAccountIndex: hdWallet.nextAccountIndex };
    }
  });
}
