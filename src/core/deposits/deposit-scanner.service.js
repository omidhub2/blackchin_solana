/**
 * Native SOL deposit scanner orchestration.
 *
 * Responsibilities:
 *  - resolve the watched wallet addresses for a (network, scope) plan,
 *  - page through signatures from a persistent cursor,
 *  - fetch parsed transactions and verify success + destination,
 *  - persist each deposit exactly once with its confirmation lifecycle,
 *  - advance the cursor ONLY after the transaction is durably handled.
 *
 * Amounts are integer lamports. This worker never credits an internal balance:
 * the consuming application owns customer accounting.
 */
import { createHash } from 'node:crypto';

import { AppError } from '../errors.js';

export const SCANNER_PAGE_SIZE_DEFAULT = 25;
export const SCANNER_MAX_BATCH_DEFAULT = 200;

function transferFingerprint(signature, walletPublicKey, transfer) {
  return createHash('sha256')
    .update(
      `${signature}|${walletPublicKey}|${transfer.from}|${transfer.to}|${transfer.lamports}`,
      'utf8'
    )
    .digest('hex');
}

function rpcFailure(error, context) {
  if (/429|rate.?limit|too many requests/i.test(String(error?.message ?? ''))) {
    const limited = new AppError(
      `Solana RPC rate limit reached while ${context}`,
      503,
      'RPC_RATE_LIMITED'
    );
    limited.retryAfterMs = 5_000;
    return limited;
  }

  const mapped = new AppError(`Solana RPC request failed while ${context}`, 502, 'RPC_ERROR');
  mapped.cause = error;
  return mapped;
}

/**
 * @param {object} deps
 * @param {object} deps.db
 * @param {{ network: string, commitment: string, getRecentSignatures: Function,
 *           getParsedTransaction: Function, getSignatureStatuses: Function,
 *           extractIncomingTransfers: Function }} deps.rpc
 * @param {{ isRecorded: Function, recordVerifiedDeposit: Function, refreshDeposit: Function }} deps.deposits
 * @param {object} deps.cursors  deposit-scanner repository
 * @param {(scope: string, network: string) => Promise<Array<{publicKey: string, hdWalletId: string|null}>>}
 *        deps.resolveWallets
 * @param {number} [deps.confirmationsRequired]
 * @param {number} [deps.pageSize]
 * @param {number} [deps.maxBatch]
 * @param {(message: string, meta?: object) => void} [deps.log]
 */
export function createDepositScanner({
  db,
  rpc,
  deposits,
  cursors,
  resolveWallets,
  confirmationsRequired = 1,
  pageSize = SCANNER_PAGE_SIZE_DEFAULT,
  maxBatch = SCANNER_MAX_BATCH_DEFAULT,
  log = () => {}
}) {
  if (!Number.isSafeInteger(confirmationsRequired) || confirmationsRequired < 1) {
    throw new TypeError('confirmationsRequired must be a positive integer');
  }

  if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new TypeError('pageSize must be between 1 and 100');
  }

  if (!Number.isSafeInteger(maxBatch) || maxBatch < 1) {
    throw new TypeError('maxBatch must be a positive integer');
  }

  const metrics = {
    runs: 0,
    signaturesScanned: 0,
    transactionsFetched: 0,
    depositsRecorded: 0,
    duplicatesSkipped: 0,
    failedTransactions: 0,
    rpcErrors: 0,
    lastRunAt: null,
    lastError: null
  };

  async function fetchPage(address, { after, before, until, limit }) {
    try {
      const options = { limit };

      // `until` resumes strictly after the last fully processed signature.
      if (after) options.until = after;
      if (before) options.before = before;
      if (until) options.until = until;

      return await rpc.getRecentSignatures(address, options);
    } catch (error) {
      metrics.rpcErrors += 1;
      throw rpcFailure(error, `fetching signatures for ${address}`);
    }
  }

  async function fetchParsed(signature) {
    try {
      metrics.transactionsFetched += 1;
      return await rpc.getParsedTransaction(signature, rpc.commitment);
    } catch (error) {
      metrics.rpcErrors += 1;
      throw rpcFailure(error, 'fetching a parsed transaction');
    }
  }

  async function confirmationState(signature) {
    try {
      const statuses = await rpc.getSignatureStatuses([signature]);
      const status = statuses?.value?.[0] ?? null;

      if (status?.err) {
        return {
          status: 'rejected',
          commitment: status.confirmationStatus ?? 'processed',
          confirmations: Number.isSafeInteger(status.confirmations) ? status.confirmations : null,
          failureReason: 'Transaction failed according to signature status'
        };
      }

      const confirmations = Number.isSafeInteger(status?.confirmations)
        ? status.confirmations
        : null;

      if (status?.confirmationStatus === 'finalized') {
        return { status: 'credited', commitment: 'finalized', confirmations };
      }

      // A confirmed commitment is the cluster's supermajority vote. For
      // transactions still reported as processed, enforce the configured
      // number of observed confirmations before advancing to confirmed.
      if (status?.confirmationStatus === 'confirmed') {
        if (confirmations === null || confirmations >= confirmationsRequired) {
          return { status: 'confirmed', commitment: 'confirmed', confirmations };
        }

        return { status: 'confirming', commitment: 'confirmed', confirmations };
      }

      if (confirmations !== null && confirmations >= confirmationsRequired) {
        return {
          status: 'confirmed',
          commitment: status?.confirmationStatus ?? 'processed',
          confirmations
        };
      }

      return {
        status: 'confirming',
        commitment: status?.confirmationStatus ?? 'processed',
        confirmations
      };
    } catch (error) {
      // The status endpoint is advisory; the parsed transaction already proves
      // successful execution. Fall through to the conservative state.
      log('scanner.confirmation_status_failed', { signature, message: error.message });
    }

    return { status: 'confirming', commitment: 'processed', confirmations: null };
  }

  return Object.freeze({
    metrics,

    /**
     * Scan one scope. Never advances the cursor past a transaction that was not
     * durably handled.
     *
     * @param {{ network: string, scope: string }} plan
     */
    async scan({ network, scope, assertOwnership = async () => {} }) {
      if (network !== rpc.network) {
        throw new AppError(
          `Scanner is bound to ${rpc.network} but was asked to scan ${network}`,
          400,
          'NETWORK_MISMATCH'
        );
      }

      metrics.runs += 1;
      metrics.lastRunAt = new Date().toISOString();

      const wallets = await resolveWallets(scope, network);

      const summary = {
        network,
        scope,
        wallets: wallets.length,
        signatures: 0,
        recorded: 0,
        duplicates: 0,
        failed: 0,
        cursors: []
      };

      let stopReason = null;
      let activeCursorId = null;

      try {
        scan: for (const wallet of wallets) {
          activeCursorId = null;
          const walletScope = `address:${wallet.publicKey}`;
          await assertOwnership();
          const cursor = await cursors.ensureCursor(db, {
            network,
            scope: walletScope,
            runAt: new Date()
          });

          if (!cursor) {
            throw new AppError('Scanner cursor could not be created', 500, 'SCANNER_STATE_ERROR');
          }

          activeCursorId = cursor.id;
          await assertOwnership();
          await cursors.markCursorRunning(db, cursor.id, new Date());

          const resumingBackfill = Boolean(cursor.backfillBeforeSignature);
          const anchorSignature = resumingBackfill
            ? cursor.backfillAnchorSignature
            : cursor.lastSignature;
          let before = resumingBackfill ? cursor.backfillBeforeSignature : null;
          let highWaterSignature = resumingBackfill
            ? cursor.backfillHighWaterSignature
            : null;
          let highWaterEntry = resumingBackfill
            ? {
              signature: highWaterSignature,
              slot: cursor.backfillHighWaterSlot ?? null,
              blockTime: cursor.backfillHighWaterBlockTime
                ? new Date(cursor.backfillHighWaterBlockTime).getTime() / 1000
                : null
            }
            : null;
          let walletSignaturesScanned = 0;
          let drained = false;
          let pageFailure = false;

          while (walletSignaturesScanned < maxBatch) {
            const signatures = await fetchPage(wallet.publicKey, {
              after: resumingBackfill ? null : cursor.lastSignature,
              before,
              until: resumingBackfill ? anchorSignature : null,
              limit: Math.min(pageSize, maxBatch - walletSignaturesScanned)
            });

            if (signatures.length === 0) {
              drained = true;
              break;
            }

            if (!highWaterSignature) {
              highWaterEntry = signatures[0];
              highWaterSignature = signatures[0].signature;
            }

            let pageHandled = true;
            for (const entry of signatures) {
              summary.signatures += 1;
              metrics.signaturesScanned += 1;

              await assertOwnership();
              const known = await deposits.isRecorded(entry.signature, wallet.publicKey);

              if (known) {
                await assertOwnership();
                await deposits.refreshDeposit(entry.signature, wallet.publicKey);
                summary.duplicates += 1;
                metrics.duplicatesSkipped += 1;
                continue;
              }

              const parsed = await fetchParsed(entry.signature);

              if (!parsed) {
                log('scanner.transaction_not_available', { signature: entry.signature });
                stopReason = 'transaction_unavailable';
                pageHandled = false;
                pageFailure = true;
                break;
              }

              if (parsed.meta?.err) {
                summary.failed += 1;
                metrics.failedTransactions += 1;
                continue;
              }

              const transfers = rpc.extractIncomingTransfers(parsed, wallet.publicKey) ?? [];
              if (transfers.length === 0) {
                continue;
              }

              const total = transfers.reduce((sum, item) => sum + BigInt(item.lamports), 0n);
              if (total <= 0n) {
                  continue;
              }

              const state = await confirmationState(entry.signature);
              if (state.status === 'rejected') {
                summary.failed += 1;
                metrics.failedTransactions += 1;
                log('scanner.transaction_status_failed', {
                  signature: entry.signature,
                  failureReason: state.failureReason
                });
                continue;
              }

              await assertOwnership();
              const recorded = await deposits.recordVerifiedDeposit({
                signature: entry.signature,
                publicKey: wallet.publicKey,
                hdWalletId: wallet.hdWalletId,
                from: transfers[0].from,
                lamports: total.toString(),
                transfers,
                commitment: state.commitment,
                status: state.status,
                confirmations: state.confirmations,
                confirmationStatus: state.commitment,
                slot: parsed.slot ?? entry.slot ?? null,
                blockTime: parsed.blockTime ? new Date(parsed.blockTime * 1000) : null,
                fingerprint: transferFingerprint(entry.signature, wallet.publicKey, transfers[0])
              });

              if (recorded.created) {
                summary.recorded += 1;
                metrics.depositsRecorded += 1;
              } else {
                summary.duplicates += 1;
                metrics.duplicatesSkipped += 1;
                await deposits.refreshDeposit(entry.signature, wallet.publicKey);
              }
            }

            if (!pageHandled) break;

            walletSignaturesScanned += signatures.length;
            before = signatures.at(-1)?.signature ?? before;

            // Probe the next page before deciding whether this high-water
            // window is complete. The probe itself never advances progress.
            const remaining = await fetchPage(wallet.publicKey, {
              after: resumingBackfill ? null : cursor.lastSignature,
              before,
              until: resumingBackfill ? anchorSignature : null,
              limit: 1
            });

            if (remaining.length === 0) {
              drained = true;
              break;
            }

            if (walletSignaturesScanned >= maxBatch) {
              await assertOwnership();
              await cursors.saveBackfillProgress(db, cursor.id, {
                anchorSignature,
                beforeSignature: before,
                highWaterSignature,
                highWaterSlot: highWaterEntry?.slot ?? null,
                highWaterBlockTime: highWaterEntry?.blockTime
                  ? new Date(highWaterEntry.blockTime * 1000)
                  : null
              });
              stopReason = 'batch_limit';
              break;
            }
          }

          if (pageFailure) {
            // Keep any previously persisted continuation unchanged. If this
            // was the first page, a retry safely replays it idempotently.
            await assertOwnership();
            await cursors.markCursorError(db, cursor.id, 'parsed transaction unavailable');
            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: cursor.lastSignature,
              backfillBeforeSignature: cursor.backfillBeforeSignature ?? null
            });
            break;
          }

          if (stopReason === 'batch_limit') {
            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: cursor.lastSignature,
              backfillBeforeSignature: before
            });
            break;
          }

          if (drained && highWaterSignature) {
            const highWaterSlot = highWaterEntry?.slot ?? null;
            const highWaterBlockTime = highWaterEntry?.blockTime
              ? new Date(highWaterEntry.blockTime * 1000)
              : null;
            await assertOwnership();
            const advanced = resumingBackfill
              ? await cursors.completeBackfill(db, cursor.id, {
                lastSignature: highWaterSignature,
                lastSlot: highWaterSlot,
                lastBlockTime: highWaterBlockTime
              })
              : await cursors.advanceCursor(db, cursor.id, {
                lastSignature: highWaterSignature,
                lastSlot: highWaterSlot,
                lastBlockTime: highWaterBlockTime
              });

            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: advanced.lastSignature,
              lastSlot: advanced.lastSlot
            });
          } else if (!highWaterSignature) {
            // No new signatures and no pending continuation.
            await assertOwnership();
            await cursors.advanceCursor(db, cursor.id, {
              lastSignature: cursor.lastSignature,
              lastSlot: cursor.lastSlot,
              lastBlockTime: cursor.lastBlockTime
            });
            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: cursor.lastSignature,
              lastSlot: cursor.lastSlot
            });
          } else {
            // A safety fallback: do not publish a high-water mark unless the
            // entire interval was drained.
            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: cursor.lastSignature,
              backfillBeforeSignature: before
            });
          }
        }
        return stopReason ? { ...summary, stopped: stopReason } : summary;
      } catch (error) {
        metrics.lastError = error.message;
        if (activeCursorId !== null) {
          await assertOwnership().catch(() => {});
          await cursors.markCursorError(db, activeCursorId, error.message).catch(() => {});
        }
        throw error;
      }
    }
  });
}
