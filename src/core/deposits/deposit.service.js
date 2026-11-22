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
  TRANSACTION_STATUSES,
  findTransactionBySignature,
  findTransactionBySignatureForTenant,
  listDepositsBySignatureForTenant,
  listDepositsForTenant,
  insertBlockchainTransaction,
  updateTransactionStatus,
  updateTransactionStatusForTenant
} from '../../infrastructure/database/blockchain-transaction.repository.js';
import { resolveWallet } from '../../infrastructure/security/wallet-signer.js';
import { resolveDepositWalletForTenant } from '../../infrastructure/database/tenant-wallet.repository.js';

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
  async function resolveDepositWallet(publicKey, tenantId = null) {
    return tenantId === null || tenantId === undefined
      ? resolveWallet(db, publicKey)
      : resolveDepositWalletForTenant(db, tenantId, publicKey);
  }

  async function findDeposit(signature, publicKey, tenantId = null) {
    return tenantId === null || tenantId === undefined
      ? findTransactionBySignature(db, signature, publicKey, 'deposit')
      : findTransactionBySignatureForTenant(db, tenantId, signature, publicKey, 'deposit');
  }
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
  async function inspect(signature, publicKey, tenantId = null) {
    const wallet = await resolveDepositWallet(publicKey, tenantId);

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

    if (status?.err) {
      return {
        wallet,
        found: true,
        confirmed: false,
        confirmationStatus: status.confirmationStatus ?? null,
        confirmations: Number.isSafeInteger(status.confirmations) ? status.confirmations : null,
        transfers: [],
        totalLamports: '0',
        slot: parsed.slot ?? null,
        blockTime: parsed.blockTime ?? null,
        failureReason: 'Transaction failed according to signature status',
        status: 'rejected'
      };
    }

    const confirmed = Boolean(
      status &&
      (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized')
    );

    return {
      wallet,
      found: true,
      confirmed,
      confirmationStatus: status?.confirmationStatus ?? null,
      confirmations: Number.isSafeInteger(status?.confirmations) ? status.confirmations : null,
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
     * Cheap existence check used by the scanner before any RPC call.
     */
    async isRecorded(signature, publicKey, tenantId = null) {
      const existing = await findDeposit(signature, publicKey, tenantId);
      return existing !== null;
    },

    /**
     * Persist an already-verified deposit (used by the scanner).
     *
     * Trust boundary: the scanner fetched and parsed the transaction and matched
     * the destination itself; this method only enforces idempotency and status
     * validation. It never fabricates a transfer.
     */
    async recordVerifiedDeposit({
      signature,
      publicKey,
      tenantId = null,
      hdWalletId = null,
      from = null,
      lamports,
      transfers = [],
      commitment: entryCommitment = null,
      confirmations = null,
      confirmationStatus = null,
      status,
      slot = null,
      blockTime = null,
      fingerprint = null
    }) {
      if (typeof signature !== 'string' || signature.length === 0) {
        throw conflict('A transaction signature is required', 'INVALID_REQUEST');
      }

      if (typeof publicKey !== 'string' || publicKey.length === 0) {
        throw conflict('A wallet public key is required', 'INVALID_REQUEST');
      }

      if (!/^\d+$/.test(String(lamports)) || BigInt(lamports) <= 0n) {
        throw conflict('A positive integer lamport amount is required', 'INVALID_AMOUNT');
      }

      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
        throw conflict('A valid Solana transaction signature is required', 'INVALID_SIGNATURE');
      }

      if (!['confirming', 'confirmed', 'credited'].includes(status)) {
        throw conflict('Only successful, non-failed deposits can be recorded', 'INVALID_STATUS');
      }

      if (confirmations !== null && (!Number.isSafeInteger(confirmations) || confirmations < 0)) {
        throw conflict('Confirmations must be a non-negative integer or null', 'INVALID_CONFIRMATIONS');
      }

      if (!Array.isArray(transfers) || transfers.length === 0) {
        throw conflict('At least one verified incoming transfer is required', 'NO_MATCHING_TRANSFER');
      }

      let verifiedTotal = 0n;
      for (const transfer of transfers) {
        if (
          !transfer ||
          transfer.to !== publicKey ||
          typeof transfer.from !== 'string' ||
          !/^\d+$/.test(String(transfer.lamports)) ||
          BigInt(transfer.lamports) <= 0n
        ) {
          throw conflict('Incoming transfer details do not match the destination wallet', 'INVALID_TRANSFER');
        }
        verifiedTotal += BigInt(transfer.lamports);
      }

      if (verifiedTotal !== BigInt(lamports)) {
        throw conflict('Deposit amount does not match the verified transfer total', 'AMOUNT_MISMATCH');
      }
      if (from !== null && from !== transfers[0].from) {
        throw conflict('Counterparty does not match the verified transfer details', 'COUNTERPARTY_MISMATCH');
      }

      const wallet = await resolveDepositWallet(publicKey, tenantId);
      if (!wallet) {
        throw notFound('Wallet address was not found in the local wallet database', 'WALLET_NOT_FOUND');
      }
      if (wallet.effectiveStatus && wallet.effectiveStatus !== 'active') {
        throw conflict('Inactive wallets cannot receive newly recorded deposits', 'WALLET_NOT_ACTIVE');
      }
      if (wallet.network && wallet.network !== network) {
        throw conflict('Wallet network does not match the deposit service network', 'NETWORK_MISMATCH');
      }
      if (String(wallet.hdWalletId ?? '') !== String(hdWalletId ?? '')) {
        throw conflict('HD wallet ownership does not match the destination wallet', 'WALLET_OWNERSHIP_MISMATCH');
      }

      if (tenantId !== null && tenantId !== undefined && String(wallet.tenantId) !== String(tenantId)) {
        throw notFound('Deposit address was not found for this tenant', 'WALLET_NOT_FOUND');
      }

      const inserted = await insertBlockchainTransaction(db, {
        signature,
        direction: 'deposit',
        walletPublicKey: publicKey,
        hdWalletId,
        counterparty: transfers[0].from,
        amountLamports: String(lamports),
        network,
        commitment: entryCommitment ?? commitment,
        status,
        slot,
        blockTime,
        tenantId: tenantId === null ? null : String(tenantId),
        metadata: {
          transfers,
          fingerprint,
          confirmations,
          confirmationStatus,
          source: 'deposit-scanner',
          walletType: hdWalletId ? 'hd_child' : 'standalone'
        }
      });

      if (inserted.created || tenantId === null || tenantId === undefined) return inserted;

      const tenantExisting = await findDeposit(signature, publicKey, tenantId);
      if (tenantExisting) return { transaction: tenantExisting, created: false };

      // A global uniqueness conflict may be a legacy NULL-tenant row or a
      // record owned by another tenant. Never adopt or expose that record.
      const conflicting = await findTransactionBySignature(db, signature, publicKey, 'deposit');
      if (conflicting) {
        return { transaction: null, created: false, ownershipConflict: true };
      }
      return inserted;
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

    async listForTenant(tenantId, { limit = 20, offset = 0 } = {}) {
      return listDepositsForTenant(db, tenantId, { limit, offset });
    },

    async getForTenant(tenantId, signature) {
      const deposits = await listDepositsBySignatureForTenant(db, tenantId, signature);
      if (deposits.length === 0) throw notFound('Deposit record was not found', 'DEPOSIT_NOT_FOUND');
      return deposits;
    },
    /**
     * Advance confirmation for an existing deposit record.
     */
    async refreshDeposit(signature, publicKey, tenantId = null) {
      const existing = await findDeposit(signature, publicKey, tenantId);

      if (!existing) {
        throw notFound('Deposit record was not found', 'DEPOSIT_NOT_FOUND');
      }

      const view = await inspect(signature, publicKey, tenantId);
      const previouslyConfirmed = ['confirmed', 'credited'].includes(existing.status);
      const finalityRegression = existing.status === 'credited' && view.status !== 'credited';
      const confirmationRegression = existing.status === 'confirmed' &&
        !['confirmed', 'credited'].includes(view.status);
      const chainContradiction = !view.found || view.status === 'rejected' ||
        finalityRegression || confirmationRegression;
      const nextStatus = chainContradiction && previouslyConfirmed
        ? 'under_review'
        : view.status === 'rejected'
          ? 'rejected'
          : view.status === 'credited'
            ? 'credited'
            : view.status === 'confirmed'
              ? 'confirmed'
              : existing.status;

      if (nextStatus === existing.status && !view.failureReason) {
        return existing;
      }

      const updateStatus = tenantId === null || tenantId === undefined
        ? updateTransactionStatus
        : (executor, id, input) => updateTransactionStatusForTenant(executor, tenantId, id, input);
      return updateStatus(db, existing.id, {
        status: nextStatus,
        commitment,
        slot: view.slot,
        blockTime: view.blockTime,
        failureReason: chainContradiction
          ? (view.failureReason ?? (
            view.found
              ? 'Transaction confirmation or finality regressed; manual review required'
              : 'Previously confirmed transaction is no longer verifiable; manual review required'
          ))
          : null,
        clearFailureReason: !chainContradiction,
        metadata: {
          chainVerification: view.found ? 'present' : 'not_found',
          confirmationStatus: view.confirmationStatus ?? null,
          confirmations: view.confirmations ?? null
        }
      });
    }
  });
}
