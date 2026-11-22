/**
 * Periodic, bounded chain reconciliation for recorded native SOL deposits.
 * This service records discrepancies; it does not mutate balances or ledger amounts.
 */
import * as repository from '../../infrastructure/database/deposit-reconciliation.repository.js';

export const RECONCILIATION_BATCH_DEFAULT = 100;

export function createDepositReconciliationService({
  db, deposits, network, batchSize = RECONCILIATION_BATCH_DEFAULT, log = () => {}
}) {
  if (!db || !deposits || typeof deposits.refreshDeposit !== 'function') {
    throw new TypeError('Database and deposit verification service are required');
  }
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new TypeError('batchSize must be between 1 and 1000');
  }

  const metrics = {
    runs: 0, checked: 0, consistent: 0, underReview: 0,
    recovered: 0, rpcErrors: 0, lastRunAt: null, lastError: null
  };

  return Object.freeze({
    metrics,

    async scan({ network: requestedNetwork = network } = {}) {
      if (requestedNetwork !== network) {
        const error = new Error('Reconciliation network does not match configured network');
        error.code = 'NETWORK_MISMATCH';
        throw error;
      }

      metrics.runs += 1;
      metrics.lastRunAt = new Date().toISOString();
      const cursor = await repository.ensureReconciliationCursor(db, network);
      const candidates = await repository.listReconciliationCandidates(
        db, network, cursor.lastTransactionId, batchSize
      );

      if (candidates.length === 0) {
        await repository.completeReconciliationCycle(db, network);
        return { network, signatures: 0, checked: 0, recorded: 0, duplicates: 0, failed: 0, cycleCompleted: true };
      }

      const summary = {
        network, signatures: candidates.length, checked: 0,
        recorded: 0, duplicates: 0, failed: 0, cycleCompleted: false
      };

      for (const transaction of candidates) {
        try {
          const updated = await deposits.refreshDeposit(
            transaction.signature, transaction.walletPublicKey
          );
          const resultingStatus = updated?.status ?? transaction.status;
          const outcome = resultingStatus === 'under_review'
            ? 'under_review'
            : transaction.status === 'under_review' && resultingStatus !== 'under_review'
              ? 'recovered'
              : 'consistent';

          await repository.recordEventAndAdvanceCursor(db, {
            transactionId: transaction.id,
            network,
            outcome,
            previousStatus: transaction.status,
            resultingStatus,
            details: {
              signature: transaction.signature,
              slot: updated?.slot ?? transaction.slot ?? null,
              commitment: updated?.commitment ?? transaction.commitment ?? null
            }
          });

          summary.checked += 1;
          metrics.checked += 1;
          metrics[outcome === 'under_review' ? 'underReview' : outcome] += 1;
        } catch (error) {
          summary.failed += 1;
          metrics.rpcErrors += 1;
          metrics.lastError = error.message;
          await repository.recordReconciliationEvent(db, {
            transactionId: transaction.id,
            network,
            outcome: 'rpc_error',
            previousStatus: transaction.status,
            resultingStatus: null,
            details: { code: error.code ?? 'UNKNOWN' }
          }).catch(() => {});
          await repository.markReconciliationError(db, network, error.message);
          log('deposit_reconciliation.transaction_failed', {
            transactionId: transaction.id, code: error.code ?? 'UNKNOWN'
          });
          throw error; // Worker backoff applies; do not advance past an unverifiable item.
        }
      }

      metrics.lastError = null;
      return summary;
    }
  });
}
