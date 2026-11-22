/**
 * Native SOL deposit verification and recording.
 *
 * A signature alone proves nothing: the transaction is fetched from RPC and
 * parsed for a successful native SystemProgram transfer to the exact wallet
 * address. Confirmed deposits are recorded once thanks to the unique
 * (signature, wallet_public_key, direction) constraint.
 *
 * Native SOL only. SPL token deposits are intentionally out of scope.
 */
import { AppError, conflict, notFound, serviceUnavailable } from '../errors.js';
import {
  findTransactionBySignature,
  insertBlockchainTransaction,
  updateTransactionStatus
} from '../../infrastructure/database/blockchain-transaction.repository.js';
import { resolveWallet } from '../../infrastructure/security/wallet-signer.js';

const COMMITMENT_RANK = { detected: 1, confirming: 2, confirmed: 3, credited: 4 };

function normalizeStatus(confirmationStatus, confirmed) {
  if (confirmationStatus === 'finalized') return 'credited';
  if (confirmationStatus === 'confirmed' && confirmed) return 'confirmed';
  if (confirmed) return 'confirming';
  return 'detected';
}

function toRpcError(error) {
  if (/429|rate.?limit|too many requests/i.test(String(error?.message ?? ''))) {
    return serviceUnavailable('Solana RPC rate limit reached; retry shortly', 'RPC_RATE_LIMITED');
  }

  const mapped = new AppError('Unable to verify the transaction with Solana RPC', 502, 'RPC_ERROR');
  mapped.cause = error;

  return mapped;
}

export function createDepositService({ db, rpc, network, commitment }) {
  async function getParsed(signature) {
    try {
      return await rpc.getParsedTransaction(signature, commitment);
    } catch (error) {
      throw toRpcError(error);
    }
  }

  async function getStatus(signature) {
    try {
      const result = await rpc.getSignatureStatuses([signature]);
      return result?.value?.[0] ?? null;
    } catch (error) {
      throw toRpcError(error);
    }
  }

  /**
   * Build the verification view without writing anything.
   */
  async function inspect(signature, publicKey) {
    const wallet = await resolveWallet(db, publicKey);

    if (!wallet) {
      throw notFound(
        'Wallet address was not found in the local wallet database',
        'WALLET_NOT_FOUND'
      );
    }

    const parsed = await getParsed(signature);

    if (!parsed) {
      return {
        wallet,
        found: false,
        confirmed: false,
        confirmationStatus: null,
        transfers: [],
        totalLamports: '0',
        slot: null,
        blockTime: null,
        failureReason: null,
        status: null
      };
    }

    if (parsed.meta?.err) {
      return {
        wallet,
        found: true,
        confirmed: false,
        confirmationStatus: null,
        transfers: [],
        totalLamports: '0',
        slot: parsed.slot ?? null,
        blockTime: parsed.blockTime ?? null,
        failureReason: 'Transaction failed on-chain',
        status: 'rejected'
      };
    }

    const transfers = rpc.extractIncomingTransfers(parsed, publicKey);
    const totalLamports = transfers.reduce((sum, item) => sum + BigInt(item.lamports), 0n);
    const status = await getStatus(signature);

    const confirmed = Boolean(
      status &&
      !status.err &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    );

    return {
      wallet,
      found: true,
      confirmed,
      confirmationStatus: status?.confirmationStatus ?? null,
      transfers,
      totalLamports: totalLamports.toString(),
      slot: parsed.slot ?? null,
      blockTime: parsed.blockTime ?? null,
      failureReason: null,
      status: normalizeStatus(status?.confirmationStatus, confirmed)
    };
  }

  return Object.freeze({
    /**
     * Return deposit address metadata for a wallet.
     */
    async getDepositAddress(publicKey) {
      const wallet = await resolveWallet(db, publicKey);

      if (!wallet) {
        throw notFound(
          'Wallet address was not found in the local wallet database',
          'WALLET_NOT_FOUND'
        );
      }

      return {
        publicKey,
        walletType: wallet.walletType,
        hdWalletId: wallet.hdWalletId,
        accountIndex: wallet.accountIndex,
        network,
        depositAddress: publicKey,
        memo: 'Send native SOL only. SPL token transfers are not credited.'
      };
    },

    /**
     * Verify an incoming transfer without recording it.
     */
    async verifyIncoming(signature, publicKey) {
      const view = await inspect(signature, publicKey);

      return {
        found: view.found,
        confirmed: view.confirmed,
        confirmationStatus: view.confirmationStatus,
        signature,
        publicKey,
        walletType: view.wallet.walletType,
        hdWalletId: view.wallet.hdWalletId,
        network,
        slot: view.slot,
        blockTime: view.blockTime,
        transfers: view.transfers,
        totalLamports: view.totalLamports,
        status: view.status,
        failureReason: view.failureReason
      };
    },

    /**
     * Verify and persist a deposit. Idempotent by signature + wallet.
     * Only a confirmed, successful transfer with a positive amount is
     * recorded; anything else is rejected with 409 and nothing is written
     * unless the transfer is at least "confirming".
     */
    async recordDeposit(signature, publicKey) {
      const view = await inspect(signature, publicKey);

      const existing = await findTransactionBySignature(db, signature, publicKey, 'deposit');

      if (existing) {
        return { deposit: existing, created: false, status: existing.status };
      }

      if (!view.found) {
        throw conflict(
          'Transaction was not found on the configured Solana network',
          'TRANSACTION_NOT_FOUND'
        );
      }

      if (view.status === 'rejected') {
        throw conflict(
          'Transaction failed on-chain and cannot be credited',
          'TRANSACTION_FAILED'
        );
      }

      if (BigInt(view.totalLamports) <= 0n) {
        throw conflict(
          'Transaction does not contain a native SOL transfer to this wallet',
          'NO_MATCHING_TRANSFER'
        );
      }

      if (COMMITMENT_RANK[view.status] < COMMITMENT_RANK.confirmed) {
        throw conflict(
          'Transaction is not confirmed yet; retry once it is confirmed',
          'TRANSACTION_NOT_CONFIRMED'
        );
      }

      const recordedStatus = view.status === 'credited' ? 'credited' : 'confirmed';
      const primaryTransfer = view.transfers[0];

      const inserted = await insertBlockchainTransaction(db, {
        signature,
        direction: 'deposit',
        walletPublicKey: publicKey,
        hdWalletId: view.wallet.hdWalletId,
        counterparty: primaryTransfer?.from ?? null,
        amountLamports: view.totalLamports,
        network,
        commitment,
        status: recordedStatus,
        slot: view.slot,
        blockTime: view.blockTime,
        metadata: {
          transfers: view.transfers,
          confirmationStatus: view.confirmationStatus,
          walletType: view.wallet.walletType
        }
      });

      if (!inserted.created) {
        const raced = await findTransactionBySignature(db, signature, publicKey, 'deposit');
        return { deposit: raced, created: false, status: raced?.status ?? null };
      }

      return { deposit: inserted.transaction, created: true, status: recordedStatus };
    },

    /**
     * Advance confirmation for an existing deposit record.
     */
    async refreshDeposit(signature, publicKey) {
      const existing = await findTransactionBySignature(db, signature, publicKey, 'deposit');

      if (!existing) {
        throw notFound('Deposit record was not found', 'DEPOSIT_NOT_FOUND');
      }

      const view = await inspect(signature, publicKey);
      const nextStatus = view.status === 'rejected'
        ? 'rejected'
        : view.status === 'credited'
          ? 'credited'
          : view.status === 'confirmed'
            ? 'confirmed'
            : existing.status;

      if (nextStatus === existing.status) {
        return existing;
      }

      return updateTransactionStatus(db, existing.id, {
        status: nextStatus,
        commitment,
        slot: view.slot,
        blockTime: view.blockTime,
        failureReason: view.failureReason
      });
    }
  });
}
