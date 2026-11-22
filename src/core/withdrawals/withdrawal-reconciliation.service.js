/**
 * Reconciles ambiguous native SOL withdrawals against finalized Solana evidence.
 *
 * Unknown, absent, or merely confirmed signatures remain processing. A
 * signature is never rebroadcast here. A processing row without a signature
 * can be failed only after the five-minute safety window: the withdrawal flow
 * persists the signed signature before its broadcast call, so no signature
 * means broadcast was not reached.
 */
import { resolveWallet } from '../../infrastructure/security/wallet-signer.js';
import { findAccountByPublicKeyForTenant, findHdWalletByIdForTenant } from '../../infrastructure/database/tenant-wallet.repository.js';
import {
  findTransactionBySignature,
  insertBlockchainTransaction,
  updateTransactionStatus,
  findTransactionBySignatureForTenant,
  updateTransactionStatusForTenant
} from '../../infrastructure/database/blockchain-transaction.repository.js';
import * as repository from '../../infrastructure/database/withdrawal-reconciliation.repository.js';

const DEFAULT_BATCH_SIZE = 100;

function extractSingleNativeTransfer(parsed, walletPublicKey) {
  const message = parsed?.transaction?.message;
  const instructions = message?.instructions;
  const accountKeys = message?.accountKeys ?? [];

  if (!Array.isArray(instructions) || instructions.length !== 1) return null;

  const feePayer = accountKeys[0]?.pubkey?.toBase58?.()
    ?? accountKeys[0]?.pubkey
    ?? accountKeys[0]?.toBase58?.()
    ?? accountKeys[0];

  if (feePayer !== walletPublicKey) return null;

  const instruction = instructions[0];
  const info = instruction?.parsed?.info;

  if (
    instruction?.program !== 'system' ||
    instruction?.parsed?.type !== 'transfer' ||
    !info ||
    info.source !== walletPublicKey ||
    typeof info.destination !== 'string' ||
    !Number.isSafeInteger(info.lamports) ||
    info.lamports <= 0
  ) return null;

  return {
    from: info.source,
    to: info.destination,
    amountLamports: String(info.lamports)
  };
}

function toRpcError(error) {
  const mapped = new Error('Unable to reconcile withdrawal with Solana RPC');
  mapped.code = error?.code ?? 'RPC_ERROR';
  mapped.cause = error;
  return mapped;
}

export function createWithdrawalReconciliationService({
  db,
  rpc,
  network,
  batchSize = DEFAULT_BATCH_SIZE,
  log = () => {}
}) {
  if (!db || !rpc || typeof rpc.getSignatureStatuses !== 'function' ||
      typeof rpc.getParsedTransaction !== 'function') {
    throw new TypeError('Database and Solana signature/transaction RPC methods are required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new TypeError('batchSize must be between 1 and 1000');
  }

  let assertCurrentOwnership = async () => {};

  const metrics = {
    runs: 0, checked: 0, finalizedSuccess: 0, finalizedFailure: 0,
    pending: 0, unknown: 0, underReview: 0, safePrebroadcastFailed: 0,
    rpcErrors: 0, lastRunAt: null, lastError: null
  };

  async function persistOutcome(candidate, outcome, details, apply) {
    await assertCurrentOwnership();
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      await assertCurrentOwnership();
      if (apply) await apply(client);
      await repository.recordWithdrawalReconciliationEvent(client, {
        tenantId: candidate.tenant_id ?? null,
        idempotencyKey: candidate.idempotency_key,
        network,
        signature: candidate.transaction_signature,
        outcome,
        details
      });
      await repository.advanceWithdrawalReconciliationCursor(client, network, candidate.id);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => {});
      throw error;
    } finally {
      client.release();
    }
  }

  async function reconcileCandidate(candidate) {
    const signature = candidate.transaction_signature;

    if (!signature) {
      await persistOutcome(candidate, 'safe_prebroadcast_failed', {
        reason: 'No signature was persisted before the signing/broadcast boundary',
        safetyWindowMinutes: 5
      }, async (client) => {
        const result = await client.query(
          `UPDATE api_idempotency_keys
              SET status = 'failed', updated_at = NOW()
            WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2
              AND status = 'processing' AND transaction_signature IS NULL`,
          [candidate.id, candidate.tenant_id ?? null]
        );
        if (result.rowCount !== 1) throw new Error('Idempotency row changed during safe pre-broadcast recovery');
      });
      metrics.safePrebroadcastFailed += 1;
      return 'safe_prebroadcast_failed';
    }

    let status;
    let parsed;
    try {
      const result = await rpc.getSignatureStatuses([signature]);
      status = result?.value?.[0] ?? null;
      if (status?.confirmationStatus === 'finalized') {
        parsed = await rpc.getParsedTransaction(signature, 'finalized');
      }
    } catch (error) {
      throw toRpcError(error);
    }

    if (!status) {
      await persistOutcome(candidate, 'unknown', {
        reason: 'Signature is not currently available from the configured RPC history'
      });
      metrics.unknown += 1;
      return 'unknown';
    }

    if (status.err) {
      if (status.confirmationStatus !== 'finalized') {
        await persistOutcome(candidate, 'pending', {
          confirmationStatus: status.confirmationStatus ?? null,
          transactionError: status.err,
          reason: 'Failure is not finalized; keep the idempotency record processing'
        });
        metrics.pending += 1;
        return 'pending';
      }

      await persistOutcome(candidate, 'finalized_failure', {
        confirmationStatus: 'finalized',
        transactionError: status.err
      }, async (client) => {
        const result = await client.query(
          `UPDATE api_idempotency_keys
              SET status = 'failed', updated_at = NOW()
            WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $3
              AND status = 'processing' AND transaction_signature = $2`,
          [candidate.id, signature, candidate.tenant_id ?? null]
        );
        if (result.rowCount !== 1) throw new Error('Withdrawal idempotency state changed during finalized failure');
      });
      metrics.finalizedFailure += 1;
      return 'finalized_failure';
    }

    if (status.confirmationStatus !== 'finalized') {
      await persistOutcome(candidate, 'pending', {
        confirmationStatus: status.confirmationStatus ?? null,
        reason: 'Successful execution is not finalized yet'
      });
      metrics.pending += 1;
      return 'pending';
    }

    if (
      !parsed ||
      parsed.meta?.err ||
      !Array.isArray(parsed.transaction?.signatures) ||
      !parsed.transaction.signatures.includes(signature) ||
      (status.slot !== null && status.slot !== undefined &&
        parsed.slot !== null && parsed.slot !== undefined &&
        Number(status.slot) !== Number(parsed.slot))
    ) {
      await persistOutcome(candidate, 'under_review', {
        reason: 'Finalized signature status has no matching successful parsed transaction evidence',
        parsedAvailable: Boolean(parsed),
        parsedError: parsed?.meta?.err ?? null
      });
      metrics.underReview += 1;
      return 'under_review';
    }

    const transfer = extractSingleNativeTransfer(parsed, candidate.wallet_public_key);
    if (
      !transfer ||
      transfer.to !== candidate.to_public_key ||
      transfer.amountLamports !== String(candidate.amount_lamports)
    ) {
      await persistOutcome(candidate, 'under_review', {
        reason: 'Parsed finalized transaction does not match the persisted sender, destination and exact lamport amount'
      });
      metrics.underReview += 1;
      return 'under_review';
    }

    const wallet = candidate.tenant_id == null
      ? await resolveWallet(db, candidate.wallet_public_key)
      : await (async () => {
          const account = await findAccountByPublicKeyForTenant(db, candidate.tenant_id, candidate.wallet_public_key);
          if (!account) return null;
          const parent = await findHdWalletByIdForTenant(db, candidate.tenant_id, account.hdWalletId);
          if (!parent) return null;
          return {
            publicKey: account.publicKey, tenantId: String(candidate.tenant_id),
            walletType: 'hd_child', status: account.status,
            effectiveStatus: account.status === 'active' && parent.status === 'active' ? 'active' : 'inactive',
            network: account.network, hdWalletId: account.hdWalletId, accountIndex: account.accountIndex
          };
        })();
    if (!wallet || (wallet.network && wallet.network !== network)) {
      await persistOutcome(candidate, 'under_review', {
        reason: 'Stored sender wallet could not be resolved on the configured network'
      });
      metrics.underReview += 1;
      return 'under_review';
    }

    const feeLamports = parsed.meta?.fee;
    if (!Number.isSafeInteger(feeLamports) || feeLamports < 0) {
      await persistOutcome(candidate, 'under_review', {
        reason: 'Parsed finalized transaction has an invalid fee'
      });
      metrics.underReview += 1;
      return 'under_review';
    }

    const amountSol = rpc.formatLamports
      ? rpc.formatLamports(transfer.amountLamports)
      : `${transfer.amountLamports}`;
    const feeSol = rpc.formatLamports ? rpc.formatLamports(String(feeLamports)) : String(feeLamports);
    const response = {
      sent: true,
      signature,
      network,
      from: transfer.from,
      to: transfer.to,
      amountLamports: transfer.amountLamports,
      amountSol,
      feeLamports: String(feeLamports),
      feeSol,
      slot: parsed.slot ?? status.slot ?? null,
      confirmationStatus: 'finalized',
      walletType: wallet.walletType,
      hdWalletId: wallet.hdWalletId
    };

    await persistOutcome(candidate, 'finalized_success', {
      confirmationStatus: 'finalized',
      slot: response.slot,
      amountLamports: transfer.amountLamports,
      feeLamports: String(feeLamports),
      destination: transfer.to
    }, async (client) => {
      const existing = candidate.tenant_id == null
        ? await findTransactionBySignature(client, signature, candidate.wallet_public_key, 'withdrawal')
        : await findTransactionBySignatureForTenant(client, candidate.tenant_id, signature, candidate.wallet_public_key, 'withdrawal');
      if (existing) {
        if (
          existing.amountLamports !== transfer.amountLamports ||
          existing.counterparty !== transfer.to ||
          existing.status === 'failed' ||
          existing.status === 'rejected'
        ) {
          throw new Error('Existing withdrawal ledger record conflicts with finalized chain evidence');
        }
        if (existing.status !== 'credited') {
          const updateInput = {
            status: 'credited', commitment: 'finalized',
            slot: parsed.slot ?? status.slot ?? null,
            blockTime: parsed.blockTime ? new Date(parsed.blockTime * 1000) : null,
            clearFailureReason: true, metadata: { reconciliation: 'finalized_success' }
          };
          if (candidate.tenant_id == null) await updateTransactionStatus(client, existing.id, updateInput);
          else await updateTransactionStatusForTenant(client, candidate.tenant_id, existing.id, updateInput);
        }
      } else {
        await insertBlockchainTransaction(client, {
          signature,
          direction: 'withdrawal',
          walletPublicKey: candidate.wallet_public_key,
          hdWalletId: wallet.hdWalletId,
          counterparty: transfer.to,
          amountLamports: transfer.amountLamports,
          feeLamports: String(feeLamports),
          network,
          commitment: 'finalized',
          status: 'credited',
          slot: parsed.slot ?? status.slot ?? null,
          blockTime: parsed.blockTime ? new Date(parsed.blockTime * 1000) : null,
          idempotencyKey: candidate.idempotency_key,
          tenantId: candidate.tenant_id ?? null,
          metadata: {
            walletType: wallet.walletType,
            accountIndex: wallet.accountIndex,
            reconciliation: 'finalized_success'
          }
        });
      }

      const completed = await client.query(
        `UPDATE api_idempotency_keys
            SET status = 'completed', response_json = $2::jsonb, updated_at = NOW()
          WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $4
            AND status = 'processing' AND transaction_signature = $3`,
        [candidate.id, JSON.stringify(response), signature, candidate.tenant_id ?? null]
      );
      if (completed.rowCount !== 1) {
        throw new Error('Withdrawal idempotency state changed during finalized success');
      }
    });

    metrics.finalizedSuccess += 1;
    return 'finalized_success';
  }

  return Object.freeze({
    metrics,

    async scan({ network: requestedNetwork = network, assertOwnership = async () => {} } = {}) {
      if (requestedNetwork !== network) {
        const error = new Error('Withdrawal reconciliation network does not match configuration');
        error.code = 'NETWORK_MISMATCH';
        throw error;
      }

      assertCurrentOwnership = assertOwnership;
      await assertCurrentOwnership();
      metrics.runs += 1;
      metrics.lastRunAt = new Date().toISOString();
      const cursor = await repository.ensureWithdrawalReconciliationCursor(db, network);
      const candidates = await repository.listWithdrawalReconciliationCandidates(
        db, network, cursor.lastId, batchSize
      );

      if (candidates.length === 0) {
        await assertCurrentOwnership();
        await repository.completeWithdrawalReconciliationCycle(db, network);
        return {
          network, signatures: 0, checked: 0, recorded: 0,
          duplicates: 0, failed: 0, cycleCompleted: true
        };
      }

      const summary = {
        network, signatures: candidates.length, checked: 0,
        recorded: 0, duplicates: 0, failed: 0, cycleCompleted: false
      };

      for (const candidate of candidates) {
        try {
          await reconcileCandidate(candidate);
          summary.checked += 1;
          metrics.checked += 1;
        } catch (error) {
          summary.failed += 1;
          metrics.rpcErrors += 1;
          metrics.lastError = error.message;
          await assertCurrentOwnership();
          await repository.recordWithdrawalReconciliationEvent(db, {
            tenantId: candidate.tenant_id ?? null,
            idempotencyKey: candidate.idempotency_key,
            network,
            signature: candidate.transaction_signature,
            outcome: 'rpc_error',
            details: { code: error.code ?? 'UNKNOWN' }
          }).catch(() => {});
          await assertCurrentOwnership();
          await repository.markWithdrawalReconciliationError(db, network, error.message);
          log('withdrawal_reconciliation.transaction_failed', {
            idempotencyId: String(candidate.id),
            code: error.code ?? 'UNKNOWN'
          });
          throw error;
        }
      }

      metrics.lastError = null;
      return summary;
    }
  });
}
