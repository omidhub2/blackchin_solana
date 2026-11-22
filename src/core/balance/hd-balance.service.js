/**
 * Balance service.
 *
 * - A standalone wallet has one on-chain account.
 * - A child wallet has its own on-chain account.
 * - An HD root has no on-chain account: its aggregate balance is the sum of
 *   its child accounts, computed in lamports with BigInt and deduplicated by
 *   public key so no wallet can be counted twice.
 */
import { AppError, notFound, serviceUnavailable } from '../errors.js';
import { findHdWalletById } from '../../infrastructure/database/hd-wallet.repository.js';
import { listAccountsByHdWallet } from '../../infrastructure/database/wallet-account.repository.js';
import { requireWallet } from '../../infrastructure/security/wallet-signer.js';

const MAX_AGGREGATE_ACCOUNTS = 500;
const RPC_CONCURRENCY = 5;

function isRateLimited(error) {
  const message = String(error?.message ?? '');

  return error?.code === 429 || /429|rate.?limit|too many requests/i.test(message);
}

/**
 * Map RPC failures to a stable API error without leaking provider details.
 */
function toRpcError(error, context) {
  if (isRateLimited(error)) {
    return serviceUnavailable(
      `Solana RPC rate limit reached while ${context}; retry shortly`,
      'RPC_RATE_LIMITED'
    );
  }

  const mapped = new AppError(`Unable to retrieve ${context} from Solana RPC`, 502, 'RPC_ERROR');
  mapped.cause = error;

  return mapped;
}

export function isRateLimitedError(error) {
  return isRateLimited(error);
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;

  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await worker(items[index], index);
    }
  });

  await Promise.all(runners);

  return results;
}

export function createBalanceService({ db, rpc, commitment }) {
  function format(lamports) {
    return rpc.formatLamports ? rpc.formatLamports(lamports) : String(lamports);
  }

  async function fetchBalance(publicKey, context) {
    try {
      return await rpc.getBalance(publicKey, commitment);
    } catch (error) {
      throw toRpcError(error, context);
    }
  }

  return Object.freeze({
    /**
     * Balance for a single wallet (standalone or HD child).
     */
    async getWalletBalance(publicKey) {
      const wallet = await requireWallet(db, publicKey);
      const balance = await fetchBalance(publicKey, 'wallet balance');

      return {
        publicKey,
        walletType: wallet.walletType,
        hdWalletId: wallet.hdWalletId,
        accountIndex: wallet.accountIndex,
        derivationPath: wallet.derivationPath,
        network: balance.network ?? rpc.network,
        commitment: balance.commitment ?? commitment,
        lamports: String(balance.lamports),
        sol: balance.sol ?? format(balance.lamports),
        syncedAt: new Date().toISOString()
      };
    },

    /**
     * Per-child balances plus the aggregate of one HD root.
     */
    async getHdWalletBalance(hdWalletId) {
      const hdWallet = await findHdWalletById(db, hdWalletId);

      if (!hdWallet) {
        throw notFound('HD wallet was not found', 'HD_WALLET_NOT_FOUND');
      }

      const accounts = await listAccountsByHdWallet(db, hdWalletId, {
        limit: MAX_AGGREGATE_ACCOUNTS,
        offset: 0
      });

      const uniqueAccounts = [];
      const seen = new Set();

      for (const account of accounts) {
        if (seen.has(account.publicKey)) continue;
        seen.add(account.publicKey);
        uniqueAccounts.push(account);
      }

      const breakdown = await mapWithConcurrency(
        uniqueAccounts,
        RPC_CONCURRENCY,
        async (account) => {
          try {
            const balance = await fetchBalance(account.publicKey, 'child wallet balance');

            return {
              publicKey: account.publicKey,
              accountIndex: account.accountIndex,
              derivationPath: account.derivationPath,
              status: account.status,
              lamports: String(balance.lamports),
              sol: balance.sol ?? format(balance.lamports),
              error: null
            };
          } catch (error) {
            return {
              publicKey: account.publicKey,
              accountIndex: account.accountIndex,
              derivationPath: account.derivationPath,
              status: account.status,
              lamports: null,
              sol: null,
              error: isRateLimited(error) ? 'RPC_RATE_LIMITED' : 'RPC_ERROR'
            };
          }
        }
      );

      let totalLamports = 0n;
      let complete = true;

      for (const item of breakdown) {
        if (item.lamports === null) {
          complete = false;
          continue;
        }

        totalLamports += BigInt(item.lamports);
      }

      if (breakdown.length > 0 && !complete && breakdown.every((item) => item.error !== null)) {
        const allRateLimited = breakdown.every((item) => item.error === 'RPC_RATE_LIMITED');

        throw serviceUnavailable(
          allRateLimited
            ? 'Solana RPC rate limit reached while retrieving child wallet balances; retry shortly'
            : 'Unable to retrieve child wallet balances from Solana RPC',
          allRateLimited ? 'RPC_RATE_LIMITED' : 'RPC_UNAVAILABLE'
        );
      }

      return {
        hdWalletId: String(hdWalletId),
        network: hdWallet.network,
        commitment,
        accountCount: uniqueAccounts.length,
        truncated: accounts.length === MAX_AGGREGATE_ACCOUNTS,
        complete,
        totalLamports: totalLamports.toString(),
        totalSol: format(totalLamports),
        accounts: breakdown,
        syncedAt: new Date().toISOString()
      };
    }
  });
}
