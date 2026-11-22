/**
 * Transaction history queries (deposits and withdrawals).
 */
import { badRequest, notFound } from '../errors.js';
import { findHdWalletById } from '../../infrastructure/database/hd-wallet.repository.js';
import {
  listTransactionsByHdWallet,
  listTransactionsByWallet
} from '../../infrastructure/database/blockchain-transaction.repository.js';

const DIRECTIONS = ['deposit', 'withdrawal'];

function normalizePaging({ limit, offset }) {
  const parsedLimit = limit === undefined ? 20 : Number(limit);
  const parsedOffset = offset === undefined ? 0 : Number(offset);

  if (!Number.isSafeInteger(parsedLimit) || parsedLimit < 1 || parsedLimit > 100) {
    throw badRequest('limit must be an integer between 1 and 100', 'INVALID_LIMIT');
  }

  if (!Number.isSafeInteger(parsedOffset) || parsedOffset < 0) {
    throw badRequest('offset must be a non-negative integer', 'INVALID_LIMIT');
  }

  return { limit: parsedLimit, offset: parsedOffset };
}

function normalizeDirection(direction) {
  if (direction === undefined) return null;

  if (!DIRECTIONS.includes(direction)) {
    throw badRequest('direction must be deposit or withdrawal', 'INVALID_DIRECTION');
  }

  return direction;
}

export function createTransactionService({ db }) {
  return Object.freeze({
    async listWalletTransactions(publicKey, { limit, offset, direction } = {}) {
      const paging = normalizePaging({ limit, offset });

      return {
        walletPublicKey: publicKey,
        ...paging,
        items: await listTransactionsByWallet(db, publicKey, {
          ...paging,
          direction: normalizeDirection(direction)
        })
      };
    },

    async listHdWalletTransactions(hdWalletId, { limit, offset, direction } = {}) {
      const paging = normalizePaging({ limit, offset });
      const hdWallet = await findHdWalletById(db, hdWalletId);

      if (!hdWallet) {
        throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
      }

      return {
        hdWalletId: String(hdWalletId),
        ...paging,
        items: await listTransactionsByHdWallet(db, hdWalletId, {
          ...paging,
          direction: normalizeDirection(direction)
        })
      };
    }
  });
}
