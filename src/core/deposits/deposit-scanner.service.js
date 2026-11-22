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

  async function fetchPage(address, { after, limit }) {
    try {
      const options = { limit };

      // `until` resumes strictly after the last fully processed signature.
      if (after) options.until = after;

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

      if (status?.confirmationStatus === 'finalized') {
        return { status: 'credited', commitment: 'finalized' };
      }

      if (status?.confirmationStatus === 'confirmed') {
        return { status: 'confirmed', commitment: 'confirmed' };
      }
    } catch (error) {
      // The status endpoint is advisory; the parsed transaction already proves
      // successful execution. Fall through to the conservative state.
      log('scanner.confirmation_status_failed', { signature, message: error.message });
    }

    return { status: 'confirming', commitment: 'processed' };
  }

  return Object.freeze({
    metrics,

    /**
     * Scan one scope. Never advances the cursor past a transaction that was not
     * durably handled.
     *
     * @param {{ network: string, scope: string }} plan
     */
    async scan({ network, scope }) {
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
          // Solana signature history is address-specific; never share a cursor
          // between different wallet addresses.
          const walletScope = `address:${wallet.publicKey}`;
          const cursor = await cursors.ensureCursor(db, {
            network,
            scope: walletScope,
            runAt: new Date()
          });

          if (!cursor) {
            throw new AppError('Scanner cursor could not be created', 500, 'SCANNER_STATE_ERROR');
          }

          activeCursorId = cursor.id;
          await cursors.markCursorRunning(db, cursor.id, new Date());
          let lastHandled = null;
          const pages = Math.max(1, Math.ceil(maxBatch / pageSize));

          for (let page = 0; page < pages; page += 1) {
            const signatures = await fetchPage(wallet.publicKey, {
              after: cursor.lastSignature,
              limit: pageSize
            });

            for (const entry of signatures) {
              summary.signatures += 1;
              metrics.signaturesScanned += 1;

              const known = await deposits.isRecorded(entry.signature, wallet.publicKey);

              if (known) {
                // Revisit known rows so their confirmation state can advance.
                await deposits.refreshDeposit(entry.signature, wallet.publicKey);
                summary.duplicates += 1;
                metrics.duplicatesSkipped += 1;
                lastHandled = entry;
                continue;
              }

              const parsed = await fetchParsed(entry.signature);

              if (!parsed) {
                log('scanner.transaction_not_available', { signature: entry.signature });
                stopReason = 'transaction_unavailable';
                break scan;
              }

              if (parsed.meta?.err) {
                summary.failed += 1;
                metrics.failedTransactions += 1;
                lastHandled = entry;
                continue;
              }

              const transfers = rpc.extractIncomingTransfers(parsed, wallet.publicKey) ?? [];

              if (transfers.length === 0) {
                lastHandled = entry;
                continue;
              }

              const total = transfers.reduce((sum, item) => sum + BigInt(item.lamports), 0n);

              if (total <= 0n) {
                lastHandled = entry;
                continue;
              }

              const state = await confirmationState(entry.signature);

              const recorded = await deposits.recordVerifiedDeposit({
                signature: entry.signature,
                publicKey: wallet.publicKey,
                hdWalletId: wallet.hdWalletId,
                from: transfers[0].from,
                lamports: total.toString(),
                transfers,
                commitment: state.commitment,
                status: state.status,
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

              lastHandled = entry;
            }

            if (signatures.length < pageSize) break;
          }

          if (lastHandled) {
            const advanced = await cursors.advanceCursor(db, cursor.id, {
              lastSignature: lastHandled.signature,
              lastSlot: lastHandled.slot ?? null,
              lastBlockTime: lastHandled.blockTime
                ? new Date(lastHandled.blockTime * 1000)
                : null
            });

            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: advanced.lastSignature,
              lastSlot: advanced.lastSlot
            });
          } else {
            summary.cursors.push({
              address: wallet.publicKey,
              lastSignature: cursor.lastSignature,
              lastSlot: cursor.lastSlot
            });
          }

          if (stopReason) {
            await cursors.markCursorError(db, cursor.id, 'parsed transaction unavailable');
          }
        }
        return stopReason ? { ...summary, stopped: stopReason } : summary;
      } catch (error) {
        metrics.lastError = error.message;
        if (activeCursorId !== null) {
          await cursors.markCursorError(db, activeCursorId, error.message).catch(() => {});
        }
        throw error;
      }
    }
  });
}
