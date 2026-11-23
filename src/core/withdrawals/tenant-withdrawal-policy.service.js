/**
 * Fail-closed tenant withdrawal authorization for native SOL.
 *
 * A tenant policy row is locked for the complete authorization transaction.
 * This serializes spending-limit checks per tenant and prevents concurrent
 * requests from exceeding configured daily/weekly limits.
 *
 * Approval records are issued only by the trusted platform control plane.
 * Partner API credentials can consume an approval, but cannot create one.
 */
import crypto from 'node:crypto';

function assertId(value, name) {
  if ((typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'bigint') ||
      !/^[1-9][0-9]*$/.test(String(value))) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  return String(value);
}

function assertLamports(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) {
    throw new TypeError('amountLamports must be a positive integer string');
  }
  return value;
}

function assertHash(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new TypeError('requestHash must be a lowercase SHA-256 digest');
  }
  return value;
}

function toBigInt(value) {
  return BigInt(String(value ?? '0'));
}

export function createTenantWithdrawalPolicyService({ db, log = () => {} } = {}) {
  if (!db || typeof db.connect !== 'function') {
    throw new TypeError('A PostgreSQL database pool is required');
  }

  return Object.freeze({
    async authorize(input = {}) {
      const tenantId = assertId(input.tenantId, 'tenantId');
      const credentialId = assertId(input.credentialId, 'credentialId');
      const amountLamports = assertLamports(input.amountLamports);
      const requestHash = assertHash(input.requestHash);
      const idempotencyKey = input.idempotencyKey;
      const approvalReference = input.approvalReference;
      const fromPublicKey = input.fromPublicKey;
      const toPublicKey = input.toPublicKey;
      const network = input.network;

      if (typeof idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(idempotencyKey)) {
        throw new TypeError('idempotencyKey is invalid');
      }
      if (typeof approvalReference !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(approvalReference)) {
        throw new TypeError('approvalReference is invalid');
      }

      const client = await db.connect();
      let decision = null;
      let reasonCode = null;
      let policyVersion = null;

      const recordDecision = async (value, reason) => {
        decision = value;
        reasonCode = reason;
        await client.query(
          `INSERT INTO tenant_withdrawal_policy_events (
             tenant_id, credential_id, approval_reference, idempotency_key,
             decision, reason_code, request_hash, wallet_public_key,
             destination_public_key, network, amount_lamports, policy_version,
             correlation_id
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $4)`,
          [tenantId, credentialId, approvalReference, idempotencyKey, value,
            reason, requestHash, fromPublicKey, toPublicKey, network,
            amountLamports, policyVersion]
        );
      };

      try {
        await client.query('BEGIN');

        // The row lock is the serialization point for all withdrawals of a
        // tenant. A missing policy row is deliberately not auto-created.
        const policyResult = await client.query(
          `SELECT enabled, emergency_frozen, max_single_lamports,
                  max_daily_lamports, max_weekly_lamports,
                  max_daily_count, max_weekly_count, policy_version
             FROM tenant_withdrawal_policies
            WHERE tenant_id = $1
            FOR UPDATE`,
          [tenantId]
        );
        const policy = policyResult.rows[0] ?? null;
        policyVersion = policy ? String(policy.policy_version) : null;

        if (!policy) {
          await recordDecision('denied', 'POLICY_NOT_CONFIGURED');
        } else if (!policy.enabled) {
          await recordDecision('denied', 'POLICY_DISABLED');
        } else if (policy.emergency_frozen) {
          await recordDecision('frozen', 'EMERGENCY_FREEZE_ACTIVE');
        } else if (
          toBigInt(policy.max_single_lamports) <= 0n ||
          toBigInt(policy.max_daily_lamports) <= 0n ||
          toBigInt(policy.max_weekly_lamports) <= 0n ||
          Number(policy.max_daily_count) <= 0 ||
          Number(policy.max_weekly_count) <= 0
        ) {
          // Zero is never interpreted as unlimited for tenant withdrawals.
          await recordDecision('denied', 'POLICY_LIMITS_NOT_CONFIGURED');
        } else {
          const destinationResult = await client.query(
            `SELECT id
               FROM tenant_withdrawal_destinations
              WHERE tenant_id = $1 AND network = $2 AND asset = 'SOL'
                AND destination_public_key = $3 AND status = 'active'
              LIMIT 1
              FOR KEY SHARE`,
            [tenantId, network, toPublicKey]
          );

          if (destinationResult.rowCount !== 1) {
            await recordDecision('denied', 'DESTINATION_NOT_ALLOWLISTED');
          } else {
            const approvalResult = await client.query(
              `SELECT tenant_id, credential_id, approval_reference, request_hash,
                      wallet_public_key, destination_public_key, network, asset,
                      amount_lamports, status, expires_at
                 FROM tenant_withdrawal_approvals
                WHERE tenant_id = $1 AND approval_reference = $2
                LIMIT 1
                FOR UPDATE`,
              [tenantId, approvalReference]
            );
            const approval = approvalResult.rows[0] ?? null;

            if (!approval || approval.status !== 'approved' ||
                new Date(approval.expires_at).getTime() <= Date.now() ||
                String(approval.credential_id) !== credentialId ||
                approval.request_hash !== requestHash ||
                approval.wallet_public_key !== fromPublicKey ||
                approval.destination_public_key !== toPublicKey ||
                approval.network !== network ||
                approval.asset !== 'SOL' ||
                String(approval.amount_lamports) !== amountLamports) {
              await recordDecision('invalid_approval', 'APPROVAL_INVALID_OR_MISMATCHED');
            } else if (toBigInt(amountLamports) > toBigInt(policy.max_single_lamports)) {
              await recordDecision('limited', 'SINGLE_WITHDRAWAL_LIMIT_EXCEEDED');
            } else {
              const usageResult = await client.query(
                `SELECT
                   COALESCE(SUM(amount_lamports) FILTER (
                     WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                   ), 0)::text AS daily_lamports,
                   COUNT(*) FILTER (
                     WHERE created_at >= date_trunc('day', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                   )::text AS daily_count,
                   COALESCE(SUM(amount_lamports), 0)::text AS weekly_lamports,
                   COUNT(*)::text AS weekly_count
                 FROM tenant_withdrawal_policy_events
                 WHERE tenant_id = $1 AND decision = 'allowed'
                   AND created_at >= date_trunc('week', NOW() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
                [tenantId]
              );
              const usage = usageResult.rows[0] ?? {};
              const dailyAmount = toBigInt(usage.daily_lamports);
              const weeklyAmount = toBigInt(usage.weekly_lamports);
              const dailyCount = Number(usage.daily_count ?? 0);
              const weeklyCount = Number(usage.weekly_count ?? 0);
              const amount = toBigInt(amountLamports);

              if (dailyAmount + amount > toBigInt(policy.max_daily_lamports)) {
                await recordDecision('limited', 'DAILY_WITHDRAWAL_AMOUNT_LIMIT_EXCEEDED');
              } else if (weeklyAmount + amount > toBigInt(policy.max_weekly_lamports)) {
                await recordDecision('limited', 'WEEKLY_WITHDRAWAL_AMOUNT_LIMIT_EXCEEDED');
              } else if (dailyCount + 1 > Number(policy.max_daily_count)) {
                await recordDecision('limited', 'DAILY_WITHDRAWAL_COUNT_LIMIT_EXCEEDED');
              } else if (weeklyCount + 1 > Number(policy.max_weekly_count)) {
                await recordDecision('limited', 'WEEKLY_WITHDRAWAL_COUNT_LIMIT_EXCEEDED');
              } else {
                const consumed = await client.query(
                  `UPDATE tenant_withdrawal_approvals
                      SET status = 'consumed', consumed_at = NOW()
                    WHERE tenant_id = $1 AND approval_reference = $2
                      AND status = 'approved' AND expires_at > NOW()`,
                  [tenantId, approvalReference]
                );

                if (consumed.rowCount !== 1) {
                  await recordDecision('invalid_approval', 'APPROVAL_ALREADY_CONSUMED');
                } else {
                  await recordDecision('allowed', 'AUTHORIZED');
                }
              }
            }
          }
        }

        await client.query('COMMIT');
        log('tenant_withdrawal.policy_decision', {
          tenantId, credentialId, decision, reasonCode, policyVersion, idempotencyKey
        });
        return { allowed: decision === 'allowed', decision, reasonCode, policyVersion };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    }
  });
}
