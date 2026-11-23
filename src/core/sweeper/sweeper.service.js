/**
 * Phase 6 native SOL sweeper.
 *
 * Planning is read-only with respect to Solana and persists a deterministic
 * job. Execution is opt-in, uses the existing HD signer, persists the signed
 * signature before broadcast, and never tops up a child wallet automatically.
 */
import crypto from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { conflict, notFound, serviceUnavailable } from '../errors.js';
import { withSigningKey } from '../../infrastructure/security/wallet-signer.js';
import {
  findSweepPolicy,
  findSweepSource,
  findSweepJob,
  findSweepJobByIdempotencyKey,
  insertSweepJob,
  listSweepJobs,
  listSweepCandidates,
  listSubmittedSweepJobs,
  countRecentSweepJobs,
  saveSweepPolicy,
  recordSweepEvent
} from '../../infrastructure/database/sweeper.repository.js';
import {
  insertBlockchainTransaction,
  findTransactionBySignature
} from '../../infrastructure/database/blockchain-transaction.repository.js';

const MAX_SAFE_LAMPORTS = BigInt(Number.MAX_SAFE_INTEGER);

function assertTenantId(value) {
  if (value === null) return null;
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(value))) {
    throw new TypeError('tenantId must be a positive integer or null');
  }
  return String(value);
}

function parseUnsigned(value, field) {
  const text = String(value);
  if (!/^\d+$/.test(text)) throw new TypeError(`${field} must be an unsigned integer string`);
  return BigInt(text);
}

function mapJob(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    tenantId: row.tenant_id === null ? null : String(row.tenant_id),
    policyId: String(row.policy_id),
    policyVersion: String(row.policy_version),
    network: row.network,
    sourcePublicKey: row.source_public_key,
    destinationPublicKey: row.destination_public_key,
    assetType: row.asset_type,
    sourceBalanceRaw: String(row.source_balance_raw),
    amountRaw: String(row.amount_raw),
    estimatedFeeLamports: String(row.estimated_fee_lamports),
    retainedLamports: String(row.rent_exempt_lamports),
    observedSlot: row.observed_slot === null ? null : Number(row.observed_slot),
    idempotencyKey: row.idempotency_key,
    status: row.status,
    signature: row.transaction_signature,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createSweeperService({
  db, rpc, cipher, network, commitment = 'confirmed',
  signer = withSigningKey, log = () => {},
  executionEnabled = false,
  allowMainnetExecution = false
}) {
  if (!db || typeof db.query !== 'function' || typeof db.connect !== 'function') {
    throw new TypeError('A PostgreSQL sweeper database is required');
  }
  if (!rpc || typeof rpc.estimateSolSweep !== 'function' ||
      typeof rpc.sendSolWithSigner !== 'function' || typeof rpc.getSlot !== 'function') {
    throw new TypeError('Native SOL sweep RPC methods are required');
  }
  if (!['devnet', 'testnet', 'mainnet-beta'].includes(network)) {
    throw new TypeError('A supported Solana network is required');
  }

  async function requirePolicy(tenantId) {
    const policy = await findSweepPolicy(db, tenantId, network);
    if (!policy || policy.enabled !== true) {
      throw serviceUnavailable('Sweeping is not enabled for this tenant and network', 'SWEEP_POLICY_DISABLED');
    }
    return policy;
  }

  return Object.freeze({
    async getPolicy({ tenantId = null } = {}) {
      tenantId = assertTenantId(tenantId);
      return findSweepPolicy(db, tenantId, network);
    },

    async configurePolicy(input = {}) {
      const tenantId = assertTenantId(input.tenantId ?? null);
      const destinationPublicKey = input.destinationPublicKey;
      if (typeof destinationPublicKey !== 'string' || !destinationPublicKey.trim()) {
        throw new TypeError('destinationPublicKey is required');
      }
      try {
        new PublicKey(destinationPublicKey);
      } catch (cause) {
        throw new TypeError('destinationPublicKey must be a valid Solana address', { cause });
      }
      const enabled = input.enabled === true;
      const executionEnabled = input.executionEnabled === true;
      if (executionEnabled && !enabled) {
        throw conflict('Sweep execution cannot be enabled while the policy is disabled', 'SWEEP_POLICY_INVALID');
      }
      // Automated funding is intentionally disabled in Phase 6A. A child
      // wallet is never topped up by this service.
      if (input.fundingEnabled === true) {
        throw conflict('Automatic SOL funding is not implemented in Phase 6A', 'SWEEP_FUNDING_UNAVAILABLE');
      }
      const minSolSweepLamports = parseUnsigned(input.minSolSweepLamports ?? '5000', 'minSolSweepLamports');
      const retainLamports = parseUnsigned(input.retainLamports ?? '10000', 'retainLamports');
      const maxFeeLamports = parseUnsigned(input.maxFeeLamports ?? '100000', 'maxFeeLamports');
      if (minSolSweepLamports > MAX_SAFE_LAMPORTS || retainLamports > MAX_SAFE_LAMPORTS || maxFeeLamports > MAX_SAFE_LAMPORTS) {
        throw new RangeError('Sweep policy lamport values exceed the supported range');
      }
      const maxSweepsPerWalletDay = input.maxSweepsPerWalletDay ?? 20;
      if (!Number.isSafeInteger(maxSweepsPerWalletDay) || maxSweepsPerWalletDay < 1 || maxSweepsPerWalletDay > 10_000) {
        throw new TypeError('maxSweepsPerWalletDay must be an integer between 1 and 10000');
      }
      return saveSweepPolicy(db, {
        tenantId, network, destinationPublicKey: new PublicKey(destinationPublicKey).toBase58(),
        enabled, executionEnabled,
        minSolSweepLamports: minSolSweepLamports.toString(),
        retainLamports: retainLamports.toString(),
        maxFeeLamports: maxFeeLamports.toString(),
        maxSweepsPerWalletDay
      });
    },

    async planSolSweep({ tenantId = null, sourcePublicKey } = {}) {
      tenantId = assertTenantId(tenantId);
      if (typeof sourcePublicKey !== 'string' || !sourcePublicKey.trim()) {
        throw new TypeError('sourcePublicKey is required');
      }
      const policy = await requirePolicy(tenantId);
      const source = await findSweepSource(db, tenantId, sourcePublicKey, network);
      if (!source) throw notFound('Active HD child wallet was not found in this scope', 'SWEEP_SOURCE_NOT_FOUND');
      if (source.account_status !== 'active' || source.parent_status !== 'active') {
        throw conflict('Both the source child wallet and its HD parent must be active', 'SWEEP_SOURCE_NOT_ACTIVE');
      }
      if (source.public_key === policy.destination_public_key) {
        throw conflict('Sweep source and destination must differ', 'SWEEP_DESTINATION_INVALID');
      }

      // Fee is independent of the integer amount for a single SystemProgram
      // transfer. Estimate with one lamport, then retain the policy floor.
      const estimate = await rpc.estimateSolSweep({
        fromPublicKey: source.public_key,
        toPublicKey: policy.destination_public_key,
        amountLamports: '1',
        requestedCommitment: commitment
      });
      const balance = parseUnsigned(estimate.availableLamports, 'availableLamports');
      const fee = parseUnsigned(estimate.estimatedFeeLamports, 'estimatedFeeLamports');
      const retained = parseUnsigned(policy.retain_lamports, 'retain_lamports');
      const minimum = parseUnsigned(policy.min_sol_sweep_lamports, 'min_sol_sweep_lamports');
      const maximumFee = parseUnsigned(policy.max_fee_lamports, 'max_fee_lamports');
      if (fee > maximumFee) {
        throw conflict('Estimated SOL network fee exceeds the configured sweep fee ceiling', 'SWEEP_FEE_LIMIT_EXCEEDED');
      }
      const available = balance > fee + retained ? balance - fee - retained : 0n;
      const amount = available >= minimum ? available : 0n;
      const slot = await rpc.getSlot(commitment);
      if (!Number.isSafeInteger(slot) || slot < 0) throw new Error('RPC returned an invalid slot');

      const seed = [
        'sol', network, tenantId ?? 'legacy', policy.id,
        policy.policy_version, source.public_key,
        policy.destination_public_key, balance.toString()
      ].join(':');
      const idempotencyKey = crypto.createHash('sha256').update(seed).digest('hex');
      const client = await db.connect();
      let result;
      try {
        await client.query('BEGIN');
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
          [`blackchin:sweep-plan:${network}:${tenantId ?? 'legacy'}:${source.public_key}`]
        );
        const existing = await findSweepJobByIdempotencyKey(client, idempotencyKey);
        if (existing) {
          await client.query('COMMIT');
          return { created: false, job: mapJob(existing) };
        }
        const recentCount = await countRecentSweepJobs(client, tenantId, source.public_key);
        if (recentCount >= Number(policy.max_sweeps_per_wallet_day)) {
          throw conflict('Wallet reached its configured daily sweep limit', 'SWEEP_DAILY_LIMIT_REACHED');
        }
        result = await insertSweepJob(client, {
          tenantId, policyId: policy.id, policyVersion: policy.policy_version,
          network, sourcePublicKey: source.public_key, hdWalletId: source.hd_wallet_id,
          destinationPublicKey: policy.destination_public_key,
          sourceBalanceLamports: balance.toString(), amountLamports: amount.toString(),
          feeLamports: fee.toString(), retainLamports: retained.toString(),
          observedSlot: slot, idempotencyKey,
          status: amount === 0n ? 'skipped_dust' : 'planned',
          metadata: {
            reason: amount === 0n ? 'balance_below_minimum_after_fee_and_retention' : null,
            asset: 'native_SOL',
            commitment
          }
        });
        if (result.created) {
          await recordSweepEvent(client, {
            jobId: result.job.id, tenantId, network,
            outcome: amount === 0n ? 'skipped_dust' : 'planned',
            details: {
              sourceBalanceLamports: balance.toString(),
              amountLamports: amount.toString(),
              feeLamports: fee.toString(),
              retainedLamports: retained.toString(),
              observedSlot: slot
            }
          });
        }
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
      return { created: result.created, job: mapJob(result.job) };
    },

    async executeSolSweep({ jobId, tenantId = null } = {}) {
      tenantId = assertTenantId(tenantId);
      if (!/^[1-9]\d*$/.test(String(jobId))) throw new TypeError('jobId must be a positive integer');
      const job = await findSweepJob(db, jobId, tenantId);
      if (!job || (tenantId !== null && String(job.tenant_id) !== tenantId)) {
        throw notFound('Sweep job was not found in this scope', 'SWEEP_JOB_NOT_FOUND');
      }
      if (job.status === 'completed') return { replayed: true, job: mapJob(job) };
      if (!['planned', 'ready'].includes(job.status)) {
        throw conflict('Sweep job is not executable in its current state', 'SWEEP_JOB_NOT_EXECUTABLE');
      }
      const policy = await requirePolicy(tenantId);
      if (policy.execution_enabled !== true) {
        throw serviceUnavailable('Sweep execution is disabled; planning remains available', 'SWEEP_EXECUTION_DISABLED');
      }
      if (executionEnabled !== true) {
        throw serviceUnavailable('The global sweeper execution kill switch is off', 'SWEEP_EXECUTION_GLOBALLY_DISABLED');
      }
      if (String(policy.id) !== String(job.policy_id) ||
          String(policy.policy_version) !== String(job.policy_version) ||
          policy.destination_public_key !== job.destination_public_key) {
        throw conflict('Sweep policy changed after this job was planned; create a fresh plan', 'SWEEP_POLICY_CHANGED');
      }
      if (job.asset_type !== 'sol') {
        throw conflict('This worker only executes native SOL sweeps', 'SWEEP_ASSET_UNSUPPORTED');
      }

      const amount = parseUnsigned(job.amount_raw, 'amount_raw');
      if (amount <= 0n || amount > MAX_SAFE_LAMPORTS) {
        throw conflict('Sweep amount is outside the supported SOL range', 'SWEEP_AMOUNT_INVALID');
      }
      if (network === 'mainnet-beta' && allowMainnetExecution !== true) {
        throw serviceUnavailable('Mainnet sweep execution requires its separate explicit safety switch', 'SWEEP_MAINNET_DISABLED');
      }

      // Re-read balance and fee immediately before signing. A stale plan must
      // never consume the policy-retained SOL reserve.
      const currentEstimate = await rpc.estimateSolSweep({
        fromPublicKey: job.source_public_key,
        toPublicKey: job.destination_public_key,
        amountLamports: amount.toString(),
        requestedCommitment: commitment
      });
      const currentBalance = parseUnsigned(currentEstimate.availableLamports, 'availableLamports');
      const currentFee = parseUnsigned(currentEstimate.estimatedFeeLamports, 'estimatedFeeLamports');
      const retained = parseUnsigned(job.rent_exempt_lamports, 'rent_exempt_lamports');
      if (currentFee > parseUnsigned(policy.max_fee_lamports, 'max_fee_lamports')) {
        throw conflict('Current SOL network fee exceeds the configured sweep fee ceiling', 'SWEEP_FEE_LIMIT_EXCEEDED');
      }
      if (currentBalance < amount + currentFee + retained) {
        throw conflict('Source balance changed; executing this plan would violate the retained SOL reserve', 'SWEEP_BALANCE_CHANGED');
      }

      let signaturePersisted = false;
      try {
        const sent = await signer(db, job.source_public_key, async ({ keypair }) =>
          rpc.sendSolWithSigner({
            fromPublicKey: job.source_public_key,
            toPublicKey: job.destination_public_key,
            amountSol: rpc.formatLamports ? rpc.formatLamports(amount) : formatLamportsLocal(amount),
            getKeypair: () => keypair,
            commitment,
            onSigned: async ({ signature }) => {
              const client = await db.connect();
              try {
                await client.query('BEGIN');
                const persisted = await client.query(
                  `UPDATE sweep_jobs
                      SET status = 'submitted', transaction_signature = $2,
                          attempts = attempts + 1, updated_at = NOW()
                    WHERE id = $1 AND status IN ('planned','ready')
                      AND transaction_signature IS NULL`,
                  [job.id, signature]
                );
                if (persisted.rowCount !== 1) {
                  throw new Error('Sweep signature could not be durably persisted before broadcast');
                }
                await recordSweepEvent(client, {
                  jobId: job.id, tenantId, network,
                  outcome: 'submitted', signature,
                  details: { amountLamports: amount.toString() }
                });
                await client.query('COMMIT');
                signaturePersisted = true;
              } catch (error) {
                await client.query('ROLLBACK').catch(() => {});
                throw error;
              } finally {
                client.release();
              }
            }
          }), { cipher, deploymentNetwork: network });

        if (!signaturePersisted || sent.signature === undefined) {
          throw new Error('Sweep broadcast returned without a durably persisted signature');
        }
        const client = await db.connect();
        let completedRow;
        try {
          await client.query('BEGIN');
          const existing = await findTransactionBySignature(
            client, sent.signature, job.source_public_key, 'sweep'
          );
          if (existing && (
            existing.amountLamports !== amount.toString() ||
            existing.counterparty !== job.destination_public_key ||
            existing.network !== network ||
            existing.idempotencyKey !== job.idempotency_key ||
            existing.tenantId !== tenantId
          )) {
            throw new Error('Existing sweep ledger record conflicts with the submitted transaction');
          }
          if (!existing) {
            const ledger = await insertBlockchainTransaction(client, {
              signature: sent.signature,
              direction: 'sweep',
              walletPublicKey: job.source_public_key,
              hdWalletId: job.hd_wallet_id,
              counterparty: job.destination_public_key,
              amountLamports: amount.toString(),
              feeLamports: sent.feeLamports ?? null,
              network,
              commitment: sent.confirmationStatus ?? commitment,
              status: 'confirmed',
              slot: sent.slot ?? null,
              idempotencyKey: job.idempotency_key,
              tenantId,
              metadata: { sweepJobId: String(job.id), assetType: 'sol' }
            });
            if (!ledger.created) throw new Error('Sweep ledger identity exists outside the expected scope');
          }
          // A confirmed response is not finality. Persist the immutable
          // ledger evidence but keep the job submitted until the reconciliation
          // loop independently verifies finalized chain history.
          await recordSweepEvent(client, {
            jobId: job.id, tenantId, network,
            outcome: 'confirmed_waiting_finality', signature: sent.signature,
            details: {
              amountLamports: amount.toString(),
              feeLamports: sent.feeLamports ?? null,
              confirmationStatus: sent.confirmationStatus ?? commitment
            }
          });
          await client.query('COMMIT');
          completedRow = {
            ...job,
            status: 'submitted',
            transaction_signature: sent.signature
          };
        } catch (cause) {
          await client.query('ROLLBACK').catch(() => {});
          const error = new Error('Sweep may have been broadcast but durable ledger completion failed', { cause });
          error.code = 'SWEEP_RECONCILIATION_REQUIRED';
          error.statusCode = 503;
          error.signature = sent.signature;
          throw error;
        } finally {
          client.release();
        }
        log('sweep.confirmed_waiting_finality', { jobId: String(job.id), signature: sent.signature, network });
        return { replayed: false, job: mapJob(completedRow), transfer: sent };
      } catch (cause) {
        if (signaturePersisted) {
          const error = new Error('Sweep signature was persisted; do not create a replacement job until reconciliation verifies the chain outcome', { cause });
          error.statusCode = 503;
          error.code = 'SWEEP_RECONCILIATION_REQUIRED';
          error.signature = cause.signature ?? null;
          error.jobId = String(job.id);
          throw error;
        }
        await db.query(
          `UPDATE sweep_jobs
              SET status = 'failed', error_code = $2, error_message = $3,
                  updated_at = NOW()
            WHERE id = $1 AND status IN ('planned','ready')
              AND transaction_signature IS NULL`,
          [job.id, cause.code ?? 'SWEEP_PRE_BROADCAST_FAILED', String(cause.message ?? 'unknown error').slice(0, 500)]
        );
        await recordSweepEvent(db, {
          jobId: job.id, tenantId, network,
          outcome: 'failed_pre_broadcast',
          details: { code: cause.code ?? null, message: String(cause.message ?? 'unknown error').slice(0, 300) }
        }).catch(() => {});
        throw cause;
      }
    },

    async reconcileSubmittedSweeps({ limit = 100 } = {}) {
      if (typeof rpc.getSignatureStatuses !== 'function' ||
          typeof rpc.getParsedTransaction !== 'function') {
        return { checked: 0, completed: 0, failed: 0, underReview: 0, pending: 0 };
      }
      const jobs = await listSubmittedSweepJobs(db, network, { limit });
      const metrics = { checked: 0, completed: 0, failed: 0, underReview: 0, pending: 0 };
      for (const job of jobs) {
        metrics.checked += 1;
        try {
          const statusResult = await rpc.getSignatureStatuses([job.transaction_signature]);
          const status = statusResult?.value?.[0] ?? null;
          if (!status || status.confirmationStatus !== 'finalized') {
            metrics.pending += 1;
            continue;
          }
          if (status.err) {
            const client = await db.connect();
            try {
              await client.query('BEGIN');
              const updated = await client.query(
                `UPDATE sweep_jobs
                    SET status = 'failed', error_code = 'SWEEP_CHAIN_FAILURE',
                        error_message = $3, updated_at = NOW()
                  WHERE id = $1 AND status = 'submitted' AND transaction_signature = $2
                  RETURNING id`,
                [job.id, job.transaction_signature, JSON.stringify(status.err).slice(0, 500)]
              );
              if (updated.rowCount === 1) {
                await recordSweepEvent(client, {
                  jobId: job.id, tenantId: job.tenant_id, network,
                  outcome: 'finalized_failure', signature: job.transaction_signature,
                  details: { transactionError: status.err }
                });
              }
              await client.query('COMMIT');
            } catch (error) {
              await client.query('ROLLBACK').catch(() => {});
              throw error;
            } finally {
              client.release();
            }
            metrics.failed += 1;
            continue;
          }

          const parsed = await rpc.getParsedTransaction(job.transaction_signature, 'finalized');
          const signatures = parsed?.transaction?.signatures;
          const slotMatches = status.slot === null || status.slot === undefined ||
            parsed?.slot === null || parsed?.slot === undefined ||
            Number(status.slot) === Number(parsed.slot);
          const instructions = [
            ...(parsed?.transaction?.message?.instructions ?? []),
            ...(parsed?.meta?.innerInstructions ?? []).flatMap((entry) => entry.instructions ?? [])
          ];
          const transfers = instructions
            .filter((instruction) =>
              instruction?.program === 'system' &&
              instruction?.parsed?.type === 'transfer' &&
              instruction?.parsed?.info &&
              typeof instruction.parsed.info === 'object'
            )
            .map((instruction) => instruction.parsed.info)
            .filter((info) =>
              info.source === job.source_public_key &&
              info.destination === job.destination_public_key &&
              String(info.lamports) === String(job.amount_raw)
            );

          if (
            !parsed || parsed.meta?.err ||
            !Array.isArray(signatures) || !signatures.includes(job.transaction_signature) ||
            !slotMatches || transfers.length !== 1
          ) {
            await db.query(
              `UPDATE sweep_jobs
                  SET status = 'under_review',
                      error_code = 'SWEEP_FINALIZED_EVIDENCE_MISMATCH',
                      error_message = 'Finalized transaction evidence does not match the persisted sweep intent',
                      updated_at = NOW()
                WHERE id = $1 AND status = 'submitted' AND transaction_signature = $2`,
              [job.id, job.transaction_signature]
            );
            await recordSweepEvent(db, {
              jobId: job.id, tenantId: job.tenant_id, network,
              outcome: 'under_review', signature: job.transaction_signature,
              details: { parsedAvailable: Boolean(parsed), matchingTransferCount: transfers.length }
            });
            metrics.underReview += 1;
            continue;
          }

          const client = await db.connect();
          try {
            await client.query('BEGIN');
            const existing = await findTransactionBySignature(
              client, job.transaction_signature, job.source_public_key, 'sweep'
            );
            if (existing && (
              existing.amountLamports !== String(job.amount_raw) ||
              existing.counterparty !== job.destination_public_key ||
              existing.network !== network ||
              existing.idempotencyKey !== job.idempotency_key ||
              existing.tenantId !== (job.tenant_id === null ? null : String(job.tenant_id))
            )) {
              throw new Error('Existing sweep ledger row conflicts with finalized chain evidence');
            }
            if (!existing) {
              const inserted = await insertBlockchainTransaction(client, {
                signature: job.transaction_signature,
                direction: 'sweep',
                walletPublicKey: job.source_public_key,
                hdWalletId: job.hd_wallet_id,
                counterparty: job.destination_public_key,
                amountLamports: String(job.amount_raw),
                feeLamports: parsed.meta?.fee === undefined ? null : String(parsed.meta.fee),
                network,
                commitment: 'finalized',
                status: 'confirmed',
                slot: parsed.slot ?? null,
                idempotencyKey: job.idempotency_key,
                tenantId: job.tenant_id === null ? null : String(job.tenant_id),
                metadata: { sweepJobId: String(job.id), assetType: 'sol', reconciled: true }
              });
              if (!inserted.created) throw new Error('Sweep ledger identity raced with another writer');
            }
            const completed = await client.query(
              `UPDATE sweep_jobs
                  SET status = 'completed', error_code = NULL, error_message = NULL,
                      updated_at = NOW()
                WHERE id = $1 AND status = 'submitted' AND transaction_signature = $2
                RETURNING id`,
              [job.id, job.transaction_signature]
            );
            if (completed.rowCount !== 1) throw new Error('Sweep job changed during reconciliation');
            await recordSweepEvent(client, {
              jobId: job.id, tenantId: job.tenant_id, network,
              outcome: 'reconciled_finalized', signature: job.transaction_signature,
              details: { amountLamports: String(job.amount_raw), slot: parsed.slot ?? null }
            });
            await client.query('COMMIT');
            metrics.completed += 1;
          } catch (error) {
            await client.query('ROLLBACK').catch(() => {});
            throw error;
          } finally {
            client.release();
          }
        } catch (error) {
          log('sweep.reconciliation_error', {
            jobId: String(job.id),
            signature: job.transaction_signature,
            code: error.code ?? 'UNKNOWN',
            message: String(error.message ?? 'unknown error').slice(0, 300)
          });
          metrics.pending += 1;
        }
      }
      return metrics;
    },

    async scan({ limit = 5000 } = {}) {
      const reconciliation = await this.reconcileSubmittedSweeps({ limit: 100 });
      const candidates = await listSweepCandidates(db, network, { limit });
      const metrics = {
        candidates: candidates.length, planned: 0, dust: 0, executed: 0, failed: 0,
        reconciled: reconciliation.completed, pending: reconciliation.pending,
        underReview: reconciliation.underReview
      };
      for (const candidate of candidates) {
        const tenantId = candidate.tenant_id === null ? null : String(candidate.tenant_id);
        try {
          const planned = await this.planSolSweep({
            tenantId,
            sourcePublicKey: candidate.public_key
          });
          if (planned.job.status === 'skipped_dust') {
            metrics.dust += 1;
            continue;
          }
          if (['submitted', 'under_review', 'completed', 'failed'].includes(planned.job.status)) {
            continue;
          }
          metrics.planned += Number(planned.created);
          if (candidate.execution_enabled === true && executionEnabled === true) {
            await this.executeSolSweep({ jobId: planned.job.id, tenantId });
            metrics.executed += 1;
          }
        } catch (error) {
          metrics.failed += 1;
          log('sweep.candidate_failed', {
            sourcePublicKey: candidate.public_key,
            tenantId,
            code: error.code ?? 'UNKNOWN',
            message: String(error.message ?? 'unknown error').slice(0, 300)
          });
        }
      }
      Object.assign(this.metrics, metrics);
      return metrics;
    },

    metrics: { candidates: 0, planned: 0, dust: 0, executed: 0, failed: 0 },

    async getJob(jobId, { tenantId } = {}) {
      tenantId = tenantId === undefined ? undefined : assertTenantId(tenantId);
      return mapJob(await findSweepJob(db, jobId, tenantId));
    },

    async listJobs(options = {}) {
      const tenantId = options.tenantId === undefined ? undefined : assertTenantId(options.tenantId);
      const rows = await listSweepJobs(db, { tenantId, limit: options.limit ?? 50, offset: options.offset ?? 0 });
      return rows.map(mapJob);
    }
  });
}

function formatLamportsLocal(value) {
  const whole = value / 1_000_000_000n;
  const fraction = (value % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
