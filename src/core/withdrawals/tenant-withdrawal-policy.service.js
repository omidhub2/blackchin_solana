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

export function solToLamports(amountSol) {
  if (typeof amountSol !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(amountSol)) {
    throw new TypeError('amountSol must be a decimal string with at most 9 decimal places');
  }
  const [whole, fraction = ''] = amountSol.split('.');
  const value = BigInt(whole) * 1_000_000_000n +
    BigInt((fraction + '000000000').slice(0, 9));
  if (value <= 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError('amountSol is outside the supported transfer range');
  }
  return value.toString();
}

export function hashTenantWithdrawalRequest({
  fromPublicKey, toPublicKey, amountLamports, network, approvalReference
}) {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ fromPublicKey, toPublicKey, amountLamports, network, approvalReference }))
    .digest('hex');
}

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
    async getPolicy(tenantId) {
      tenantId = assertId(tenantId, 'tenantId');
      const result = await db.query(
        `SELECT tenant_id, enabled, emergency_frozen, freeze_reason,
                max_single_lamports, max_daily_lamports, max_weekly_lamports,
                max_daily_count, max_weekly_count, policy_version,
                updated_by, created_at, updated_at
           FROM tenant_withdrawal_policies
          WHERE tenant_id = $1
          LIMIT 1`,
        [tenantId]
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        tenantId: String(row.tenant_id),
        enabled: row.enabled,
        emergencyFrozen: row.emergency_frozen,
        freezeReason: row.freeze_reason,
        maxSingleLamports: String(row.max_single_lamports),
        maxDailyLamports: String(row.max_daily_lamports),
        maxWeeklyLamports: String(row.max_weekly_lamports),
        maxDailyCount: Number(row.max_daily_count),
        maxWeeklyCount: Number(row.max_weekly_count),
        policyVersion: String(row.policy_version),
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    async configurePolicy(input = {}) {
      const tenantId = assertId(input.tenantId, 'tenantId');
      const updatedBy = String(input.updatedBy ?? '').trim();
      if (!updatedBy || updatedBy.length > 128) throw new TypeError('updatedBy is required');
      const amountFields = ['maxSingleLamports', 'maxDailyLamports', 'maxWeeklyLamports'];
      for (const field of amountFields) {
        if (typeof input[field] !== 'string' || !/^[1-9]\d{0,29}$/.test(input[field])) {
          throw new TypeError(`${field} must be a positive integer lamport string`);
        }
      }
      for (const field of ['maxDailyCount', 'maxWeeklyCount']) {
        if (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 1_000_000) {
          throw new TypeError(`${field} must be a positive safe integer`);
        }
      }
      if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
      if (BigInt(input.maxSingleLamports) > BigInt(input.maxDailyLamports) ||
          BigInt(input.maxDailyLamports) > BigInt(input.maxWeeklyLamports) ||
          input.maxDailyCount > input.maxWeeklyCount) {
        throw new TypeError('Withdrawal limits must be ordered: single <= daily <= weekly');
      }

      let result;
      try {
        result = await db.query(
        `INSERT INTO tenant_withdrawal_policies (
           tenant_id, enabled, emergency_frozen, freeze_reason,
           max_single_lamports, max_daily_lamports, max_weekly_lamports,
           max_daily_count, max_weekly_count, policy_version, updated_by
         )
         SELECT id, $2, TRUE, 'Policy changed; explicit unfreeze required',
                $3::numeric, $4::numeric, $5::numeric, $6, $7, 1, $8
           FROM tenants WHERE id = $1
         RETURNING tenant_id, enabled, emergency_frozen, freeze_reason,
                   max_single_lamports, max_daily_lamports, max_weekly_lamports,
                   max_daily_count, max_weekly_count, policy_version,
                   updated_by, created_at, updated_at`,
        [tenantId, input.enabled, input.maxSingleLamports, input.maxDailyLamports,
          input.maxWeeklyLamports, input.maxDailyCount, input.maxWeeklyCount, updatedBy]
        );
      } catch (cause) {
        if (cause?.code === '23505') {
          const error = new Error('This tenant already has a withdrawal policy');
          error.statusCode = 409;
          error.code = 'WITHDRAWAL_POLICY_EXISTS';
          throw error;
        }
        throw cause;
      }
      if (result.rowCount !== 1) {
        const error = new Error('Tenant was not found');
        error.statusCode = 404;
        error.code = 'TENANT_NOT_FOUND';
        throw error;
      }
      // A policy change invalidates every unused approval. The policy is
      // already frozen by the upsert, so a failure here remains fail-closed.
      await db.query(
        `UPDATE tenant_withdrawal_approvals
            SET status = 'revoked'
          WHERE tenant_id = $1 AND status = 'approved'`,
        [tenantId]
      );
      return {
        tenantId: String(result.rows[0].tenant_id),
        enabled: result.rows[0].enabled,
        emergencyFrozen: result.rows[0].emergency_frozen,
        freezeReason: result.rows[0].freeze_reason,
        maxSingleLamports: String(result.rows[0].max_single_lamports),
        maxDailyLamports: String(result.rows[0].max_daily_lamports),
        maxWeeklyLamports: String(result.rows[0].max_weekly_lamports),
        maxDailyCount: Number(result.rows[0].max_daily_count),
        maxWeeklyCount: Number(result.rows[0].max_weekly_count),
        policyVersion: String(result.rows[0].policy_version),
        updatedBy: result.rows[0].updated_by,
        createdAt: result.rows[0].created_at,
        updatedAt: result.rows[0].updated_at
      };
    },

    async updatePolicy(input = {}) {
      const tenantId = assertId(input.tenantId, 'tenantId');
      const updatedBy = String(input.updatedBy ?? '').trim();
      if (!updatedBy || updatedBy.length > 128) throw new TypeError('updatedBy is required');
      for (const field of ['maxSingleLamports', 'maxDailyLamports', 'maxWeeklyLamports']) {
        if (typeof input[field] !== 'string' || !/^[1-9]\d{0,29}$/.test(input[field])) {
          throw new TypeError(`${field} must be a positive integer lamport string`);
        }
      }
      for (const field of ['maxDailyCount', 'maxWeeklyCount']) {
        if (!Number.isSafeInteger(input[field]) || input[field] < 1 || input[field] > 1_000_000) {
          throw new TypeError(`${field} must be a positive safe integer`);
        }
      }
      if (typeof input.enabled !== 'boolean') throw new TypeError('enabled must be boolean');
      if (BigInt(input.maxSingleLamports) > BigInt(input.maxDailyLamports) ||
          BigInt(input.maxDailyLamports) > BigInt(input.maxWeeklyLamports) ||
          input.maxDailyCount > input.maxWeeklyCount) {
        throw new TypeError('Withdrawal limits must be ordered: single <= daily <= weekly');
      }

      const result = await db.query(
        `UPDATE tenant_withdrawal_policies
            SET enabled = $2,
                emergency_frozen = TRUE,
                freeze_reason = 'Policy changed; explicit unfreeze required',
                max_single_lamports = $3::numeric,
                max_daily_lamports = $4::numeric,
                max_weekly_lamports = $5::numeric,
                max_daily_count = $6,
                max_weekly_count = $7,
                policy_version = policy_version + 1,
                updated_by = $8,
                updated_at = NOW()
          WHERE tenant_id = $1
          RETURNING tenant_id, enabled, emergency_frozen, freeze_reason,
                    max_single_lamports, max_daily_lamports, max_weekly_lamports,
                    max_daily_count, max_weekly_count, policy_version,
                    updated_by, created_at, updated_at`,
        [tenantId, input.enabled, input.maxSingleLamports, input.maxDailyLamports,
          input.maxWeeklyLamports, input.maxDailyCount, input.maxWeeklyCount, updatedBy]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Tenant withdrawal policy was not found');
        error.statusCode = 404;
        error.code = 'WITHDRAWAL_POLICY_NOT_FOUND';
        throw error;
      }
      await db.query(
        `UPDATE tenant_withdrawal_approvals
            SET status = 'revoked'
          WHERE tenant_id = $1 AND status = 'approved'`,
        [tenantId]
      );
      const row = result.rows[0];
      return {
        tenantId: String(row.tenant_id),
        enabled: row.enabled,
        emergencyFrozen: row.emergency_frozen,
        freezeReason: row.freeze_reason,
        maxSingleLamports: String(row.max_single_lamports),
        maxDailyLamports: String(row.max_daily_lamports),
        maxWeeklyLamports: String(row.max_weekly_lamports),
        maxDailyCount: Number(row.max_daily_count),
        maxWeeklyCount: Number(row.max_weekly_count),
        policyVersion: String(row.policy_version),
        updatedBy: row.updated_by,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      };
    },

    async deletePolicy({ tenantId, deletedBy } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      if (typeof deletedBy !== 'string' || !deletedBy.trim() || deletedBy.length > 128) {
        throw new TypeError('deletedBy is required');
      }
      const client = await db.connect();
      try {
        await client.query('BEGIN');
        const locked = await client.query(
          `SELECT tenant_id FROM tenant_withdrawal_policies
            WHERE tenant_id = $1
            FOR UPDATE`,
          [tenantId]
        );
        if (locked.rowCount !== 1) {
          const error = new Error('Tenant withdrawal policy was not found');
          error.statusCode = 404;
          error.code = 'WITHDRAWAL_POLICY_NOT_FOUND';
          throw error;
        }
        await client.query(
          `UPDATE tenant_withdrawal_approvals
              SET status = 'revoked'
            WHERE tenant_id = $1 AND status = 'approved'`,
          [tenantId]
        );
        await client.query(
          'DELETE FROM tenant_withdrawal_policies WHERE tenant_id = $1',
          [tenantId]
        );
        await client.query(
          `INSERT INTO operational_events (event_id, tenant_id, event_type, payload)
           VALUES ($1, $2, 'tenant_withdrawal.policy_deleted', $3::jsonb)`,
          [crypto.randomUUID(), tenantId, JSON.stringify({ deletedBy })]
        );
        await client.query('COMMIT');
        return { tenantId, deleted: true };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async freeze({ tenantId, reason, updatedBy } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      if (typeof reason !== 'string' || !reason.trim() || reason.trim().length > 500) {
        throw new TypeError('A freeze reason of 1 to 500 characters is required');
      }
      if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.length > 128) {
        throw new TypeError('updatedBy is required');
      }
      const result = await db.query(
        `UPDATE tenant_withdrawal_policies
            SET emergency_frozen = TRUE, freeze_reason = $2,
                policy_version = policy_version + 1, updated_by = $3, updated_at = NOW()
          WHERE tenant_id = $1
          RETURNING tenant_id, enabled, emergency_frozen, freeze_reason, policy_version`,
        [tenantId, reason.trim(), updatedBy]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Tenant withdrawal policy was not found');
        error.statusCode = 404;
        error.code = 'WITHDRAWAL_POLICY_NOT_FOUND';
        throw error;
      }
      await db.query(
        `UPDATE tenant_withdrawal_approvals
            SET status = 'revoked'
          WHERE tenant_id = $1 AND status = 'approved'`,
        [tenantId]
      );
      return {
        tenantId: String(result.rows[0].tenant_id),
        enabled: result.rows[0].enabled,
        emergencyFrozen: result.rows[0].emergency_frozen,
        freezeReason: result.rows[0].freeze_reason,
        policyVersion: String(result.rows[0].policy_version)
      };
    },

    async unfreeze({ tenantId, updatedBy } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      if (typeof updatedBy !== 'string' || !updatedBy.trim() || updatedBy.length > 128) {
        throw new TypeError('updatedBy is required');
      }
      // Revoke stale approvals before opening the policy. If this fails,
      // the policy remains frozen and no old approval can become usable.
      await db.query(
        `UPDATE tenant_withdrawal_approvals
            SET status = 'revoked'
          WHERE tenant_id = $1 AND status = 'approved'`,
        [tenantId]
      );
      const result = await db.query(
        `UPDATE tenant_withdrawal_policies
            SET emergency_frozen = FALSE, freeze_reason = NULL,
                policy_version = policy_version + 1, updated_by = $2, updated_at = NOW()
          WHERE tenant_id = $1 AND enabled = TRUE
            AND max_single_lamports > 0 AND max_daily_lamports > 0
            AND max_weekly_lamports > 0 AND max_daily_count > 0
            AND max_weekly_count > 0
          RETURNING tenant_id, enabled, emergency_frozen, freeze_reason, policy_version`,
        [tenantId, updatedBy]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Policy must be configured and enabled before it can be unfrozen');
        error.statusCode = 409;
        error.code = 'WITHDRAWAL_POLICY_NOT_READY';
        throw error;
      }
      return {
        tenantId: String(result.rows[0].tenant_id),
        enabled: result.rows[0].enabled,
        emergencyFrozen: result.rows[0].emergency_frozen,
        freezeReason: result.rows[0].freeze_reason,
        policyVersion: String(result.rows[0].policy_version)
      };
    },

    async listDestinations(tenantId) {
      tenantId = assertId(tenantId, 'tenantId');
      const result = await db.query(
        `SELECT id, tenant_id, network, asset, destination_public_key, status,
                label, created_by, approved_by, approved_at, revoked_at, created_at
           FROM tenant_withdrawal_destinations
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC`,
        [tenantId]
      );
      return result.rows.map((row) => ({
        id: String(row.id), tenantId: String(row.tenant_id), network: row.network,
        asset: row.asset, destinationPublicKey: row.destination_public_key,
        status: row.status, label: row.label, createdBy: row.created_by,
        approvedBy: row.approved_by, approvedAt: row.approved_at,
        revokedAt: row.revoked_at, createdAt: row.created_at
      }));
    },

    async addDestination({ tenantId, network, destinationPublicKey, label = null, createdBy } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      if (!['devnet', 'testnet', 'mainnet-beta'].includes(network)) throw new TypeError('Unsupported Solana network');
      if (typeof destinationPublicKey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(destinationPublicKey)) {
        throw new TypeError('destinationPublicKey is invalid');
      }
      if (label !== null && (typeof label !== 'string' || label.length > 100)) throw new TypeError('label is invalid');
      if (typeof createdBy !== 'string' || !createdBy.trim() || createdBy.length > 128) throw new TypeError('createdBy is required');
      const result = await db.query(
        `INSERT INTO tenant_withdrawal_destinations
           (tenant_id, network, asset, destination_public_key, status, label, created_by)
         SELECT id, $2, 'SOL', $3, 'pending', $4, $5
           FROM tenants WHERE id = $1 AND status = 'active'
         RETURNING id, tenant_id, network, asset, destination_public_key, status,
                   label, created_by, approved_by, approved_at, revoked_at, created_at`,
        [tenantId, network, destinationPublicKey, label, createdBy]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Active tenant was not found');
        error.statusCode = 404;
        error.code = 'TENANT_NOT_FOUND_OR_INACTIVE';
        throw error;
      }
      const row = result.rows[0];
      return {
        id: String(row.id), tenantId: String(row.tenant_id), network: row.network,
        asset: row.asset, destinationPublicKey: row.destination_public_key,
        status: row.status, label: row.label, createdBy: row.created_by,
        approvedBy: row.approved_by, approvedAt: row.approved_at,
        revokedAt: row.revoked_at, createdAt: row.created_at
      };
    },

    async activateDestination({ tenantId, destinationId, approvedBy } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      const id = assertId(destinationId, 'destinationId');
      if (typeof approvedBy !== 'string' || !approvedBy.trim() || approvedBy.length > 128) {
        throw new TypeError('approvedBy is required');
      }
      const result = await db.query(
        `UPDATE tenant_withdrawal_destinations
            SET status = 'active', approved_by = $3, approved_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
            AND created_by IS DISTINCT FROM $3
          RETURNING id, tenant_id, network, asset, destination_public_key, status,
                    label, created_by, approved_by, approved_at, revoked_at, created_at`,
        [tenantId, id, approvedBy]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Destination was not pending, was not found, or requires a second approver');
        error.statusCode = 409;
        error.code = 'DESTINATION_APPROVAL_REQUIRED';
        throw error;
      }
      const row = result.rows[0];
      return {
        id: String(row.id), tenantId: String(row.tenant_id), network: row.network,
        asset: row.asset, destinationPublicKey: row.destination_public_key,
        status: row.status, label: row.label, createdBy: row.created_by,
        approvedBy: row.approved_by, approvedAt: row.approved_at,
        revokedAt: row.revoked_at, createdAt: row.created_at
      };
    },

    async revokeDestination({ tenantId, destinationId } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      const id = assertId(destinationId, 'destinationId');
      const result = await db.query(
        `UPDATE tenant_withdrawal_destinations
            SET status = 'revoked', revoked_at = NOW()
          WHERE tenant_id = $1 AND id = $2 AND status IN ('pending', 'active')
          RETURNING id, tenant_id, network, asset, destination_public_key, status,
                    label, created_by, approved_by, approved_at, revoked_at, created_at`,
        [tenantId, id]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Destination was not found or already revoked');
        error.statusCode = 404;
        error.code = 'DESTINATION_NOT_FOUND';
        throw error;
      }
      const row = result.rows[0];
      return {
        id: String(row.id), tenantId: String(row.tenant_id), network: row.network,
        asset: row.asset, destinationPublicKey: row.destination_public_key,
        status: row.status, label: row.label, createdBy: row.created_by,
        approvedBy: row.approved_by, approvedAt: row.approved_at,
        revokedAt: row.revoked_at, createdAt: row.created_at
      };
    },

    async listApprovals(tenantId) {
      tenantId = assertId(tenantId, 'tenantId');
      const result = await db.query(
        `SELECT tenant_id, credential_id, approval_reference, wallet_public_key,
                destination_public_key, network, asset, amount_lamports, status,
                issuer, issuer_event_id, expires_at, approved_at, consumed_at
           FROM tenant_withdrawal_approvals
          WHERE tenant_id = $1
          ORDER BY created_at DESC, id DESC
          LIMIT 100`,
        [tenantId]
      );
      return result.rows.map((row) => ({
        tenantId: String(row.tenant_id),
        credentialId: String(row.credential_id),
        approvalReference: row.approval_reference,
        walletPublicKey: row.wallet_public_key,
        destinationPublicKey: row.destination_public_key,
        network: row.network,
        asset: row.asset,
        amountLamports: String(row.amount_lamports),
        status: row.status,
        issuer: row.issuer,
        issuerEventId: row.issuer_event_id,
        expiresAt: row.expires_at,
        approvedAt: row.approved_at,
        consumedAt: row.consumed_at
      }));
    },

    async revokeApproval({ tenantId, approvalReference } = {}) {
      tenantId = assertId(tenantId, 'tenantId');
      if (typeof approvalReference !== 'string' ||
          !/^[A-Za-z0-9._:-]{8,128}$/.test(approvalReference)) {
        throw new TypeError('approvalReference is invalid');
      }
      const result = await db.query(
        `UPDATE tenant_withdrawal_approvals
            SET status = 'revoked'
          WHERE tenant_id = $1 AND approval_reference = $2 AND status = 'approved'
          RETURNING tenant_id, credential_id, approval_reference, status, expires_at`,
        [tenantId, approvalReference]
      );
      if (result.rowCount !== 1) {
        const error = new Error('Pending approval was not found or is no longer revocable');
        error.statusCode = 409;
        error.code = 'WITHDRAWAL_APPROVAL_NOT_REVOCABLE';
        throw error;
      }
      return {
        tenantId: String(result.rows[0].tenant_id),
        credentialId: String(result.rows[0].credential_id),
        approvalReference: result.rows[0].approval_reference,
        status: result.rows[0].status,
        expiresAt: result.rows[0].expires_at
      };
    },

    async issueApproval(input = {}) {
      const tenantId = assertId(input.tenantId, 'tenantId');
      const credentialId = assertId(input.credentialId, 'credentialId');
      const amountLamports = assertLamports(input.amountLamports);
      const requestHash = assertHash(input.requestHash);
      const issuer = String(input.issuer ?? '').trim();
      const issuerEventId = input.issuerEventId ?? crypto.randomUUID();
      if (requestHash !== hashTenantWithdrawalRequest({
        fromPublicKey: input.walletPublicKey,
        toPublicKey: input.destinationPublicKey,
        amountLamports,
        network: input.network,
        approvalReference: input.approvalReference
      })) {
        throw new TypeError('requestHash does not match the approval binding');
      }
      if (!issuer || issuer.length > 128) throw new TypeError('issuer is required');
      if (typeof issuerEventId !== 'string' || !/^[A-Za-z0-9._:-]{8,128}$/.test(issuerEventId)) {
        throw new TypeError('issuerEventId is invalid');
      }
      if (input.requireApprovalScope !== undefined && typeof input.requireApprovalScope !== 'boolean') {
        throw new TypeError('requireApprovalScope must be boolean');
      }
      if (typeof input.approvalReference !== 'string' ||
          !/^[A-Za-z0-9._:-]{8,128}$/.test(input.approvalReference)) {
        throw new TypeError('approvalReference is invalid');
      }
      if (!['devnet', 'testnet', 'mainnet-beta'].includes(input.network)) throw new TypeError('Unsupported Solana network');
      if (typeof input.walletPublicKey !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.walletPublicKey)) {
        throw new TypeError('walletPublicKey is invalid');
      }
      if (typeof input.destinationPublicKey !== 'string' ||
          !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.destinationPublicKey)) {
        throw new TypeError('destinationPublicKey is invalid');
      }
      const expiresAt = input.expiresAt;
      if (!(expiresAt instanceof Date) || Number.isNaN(expiresAt.getTime()) ||
          expiresAt.getTime() <= Date.now() || expiresAt.getTime() > Date.now() + 15 * 60_000) {
        throw new TypeError('Approval expiry must be within the next 15 minutes');
      }
      const mapApproval = (row, replayed = false) => ({
        tenantId: String(row.tenant_id), credentialId: String(row.credential_id),
        approvalReference: row.approval_reference, requestHash: String(row.request_hash).trim(),
        walletPublicKey: row.wallet_public_key, destinationPublicKey: row.destination_public_key,
        network: row.network, asset: row.asset, amountLamports: String(row.amount_lamports),
        status: row.status, issuer: row.issuer, issuerEventId: row.issuer_event_id,
        expiresAt: row.expires_at, approvedAt: row.approved_at, replayed
      });
      const matchesBinding = (row) =>
        String(row.tenant_id) === tenantId &&
        String(row.credential_id) === credentialId &&
        row.approval_reference === input.approvalReference &&
        String(row.request_hash ?? '').trim() === requestHash &&
        row.wallet_public_key === input.walletPublicKey &&
        row.destination_public_key === input.destinationPublicKey &&
        row.network === input.network &&
        row.asset === 'SOL' &&
        String(row.amount_lamports) === amountLamports;

      // A stable issuer event ID makes partner approval issuance idempotent.
      const prior = await db.query(
        `SELECT tenant_id, credential_id, approval_reference, request_hash,
                wallet_public_key, destination_public_key, network, asset,
                amount_lamports, status, issuer, issuer_event_id, expires_at, approved_at
           FROM tenant_withdrawal_approvals
          WHERE tenant_id = $1 AND issuer = $2 AND issuer_event_id = $3
          LIMIT 1`,
        [tenantId, issuer, issuerEventId]
      );
      if (prior.rowCount === 1) {
        if (!matchesBinding(prior.rows[0])) {
          const error = new Error('Approval idempotency key was already used for a different request');
          error.statusCode = 409;
          error.code = 'WITHDRAWAL_APPROVAL_KEY_REUSED';
          throw error;
        }
        return mapApproval(prior.rows[0], true);
      }

      const configuredPolicy = await db.query(
        `SELECT enabled, emergency_frozen
           FROM tenant_withdrawal_policies
          WHERE tenant_id = $1
          LIMIT 1`,
        [tenantId]
      );
      if (configuredPolicy.rowCount !== 1 ||
          configuredPolicy.rows[0].enabled !== true ||
          configuredPolicy.rows[0].emergency_frozen !== false) {
        const error = new Error('Tenant withdrawal policy must be enabled and unfrozen before issuing approvals');
        error.statusCode = 409;
        error.code = 'WITHDRAWAL_POLICY_NOT_READY';
        throw error;
      }

      const destination = await db.query(
        `SELECT id FROM tenant_withdrawal_destinations
          WHERE tenant_id = $1 AND network = $2 AND asset = 'SOL'
            AND destination_public_key = $3 AND status = 'active'
          LIMIT 1`,
        [tenantId, input.network, input.destinationPublicKey]
      );
      if (destination.rowCount !== 1) {
        const error = new Error('Withdrawal destination must be approved and active before an approval can be issued');
        error.statusCode = 409;
        error.code = 'WITHDRAWAL_DESTINATION_NOT_ACTIVE';
        throw error;
      }

      const wallet = await db.query(
        `SELECT a.id
           FROM wallet_accounts a
           INNER JOIN hd_wallets h
             ON h.tenant_id = a.tenant_id AND h.id = a.hd_wallet_id
          WHERE a.tenant_id = $1 AND a.public_key = $2
            AND a.network = $3 AND a.status = 'active'
            AND h.network = $3 AND h.status = 'active'
          LIMIT 1`,
        [tenantId, input.walletPublicKey, input.network]
      );
      if (wallet.rowCount !== 1) {
        const error = new Error('Active HD child wallet was not found for this tenant and network');
        error.statusCode = 404;
        error.code = 'WITHDRAWAL_WALLET_NOT_FOUND';
        throw error;
      }

      let result;
      try {
        result = await db.query(
        `INSERT INTO tenant_withdrawal_approvals (
           tenant_id, credential_id, approval_reference, request_hash,
           wallet_public_key, destination_public_key, network, asset,
           amount_lamports, status, issuer, issuer_event_id, expires_at
         )
         SELECT c.tenant_id, c.id, $3, $4, $5, $6, $7, 'SOL',
                $8::numeric, 'approved', $9, $10, $11
           FROM tenant_api_credentials c
           INNER JOIN tenants t ON t.id = c.tenant_id
          WHERE c.tenant_id = $1 AND c.id = $2
            AND c.status = 'active' AND t.status = 'active'
            AND c.scopes @> ARRAY['withdrawals:submit']::text[]
            AND ($12::boolean = FALSE OR c.scopes @> ARRAY['withdrawals:approve']::text[])
            AND $11 > clock_timestamp()
            AND $11 <= clock_timestamp() + INTERVAL '15 minutes'
         ON CONFLICT (issuer, issuer_event_id) DO NOTHING
         RETURNING tenant_id, credential_id, approval_reference, request_hash,
                   wallet_public_key, destination_public_key, network, asset,
                   amount_lamports, status, issuer, issuer_event_id, expires_at, approved_at`,
        [tenantId, credentialId, input.approvalReference, requestHash,
          input.walletPublicKey, input.destinationPublicKey, input.network,
          amountLamports, issuer, issuerEventId, expiresAt, input.requireApprovalScope === true]
        );
      } catch (cause) {
        if (cause?.code === '23505') {
          const error = new Error('Approval reference already exists for this tenant');
          error.statusCode = 409;
          error.code = 'WITHDRAWAL_APPROVAL_REFERENCE_EXISTS';
          throw error;
        }
        throw cause;
      }
      if (result.rowCount === 1) return mapApproval(result.rows[0], false);

      const replay = await db.query(
        `SELECT tenant_id, credential_id, approval_reference, request_hash,
                wallet_public_key, destination_public_key, network, asset,
                amount_lamports, status, issuer, issuer_event_id, expires_at, approved_at
           FROM tenant_withdrawal_approvals
          WHERE tenant_id = $1 AND issuer = $2 AND issuer_event_id = $3
          LIMIT 1`,
        [tenantId, issuer, issuerEventId]
      );
      if (replay.rowCount === 1 && matchesBinding(replay.rows[0])) {
        return mapApproval(replay.rows[0], true);
      }
      if (replay.rowCount === 1) {
        const error = new Error('Approval idempotency key was already used for a different request');
        error.statusCode = 409;
        error.code = 'WITHDRAWAL_APPROVAL_KEY_REUSED';
        throw error;
      }
      const error = new Error('Active tenant credential with required withdrawal scopes was not found, or approval reference already exists');
      error.statusCode = 409;
      error.code = 'WITHDRAWAL_APPROVAL_CONFLICT';
      throw error;
    },

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

      if (requestHash !== hashTenantWithdrawalRequest({
        fromPublicKey, toPublicKey, amountLamports, network, approvalReference
      })) {
        throw new TypeError('requestHash does not match the withdrawal request');
      }
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
             correlation_id, created_at
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $4, clock_timestamp())`,
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
              FOR SHARE`,
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
                String(approval.request_hash ?? '').trim() !== requestHash ||
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
                     WHERE created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                   ), 0)::text AS daily_lamports,
                   COUNT(*) FILTER (
                     WHERE created_at >= date_trunc('day', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
                   )::text AS daily_count,
                   COALESCE(SUM(amount_lamports), 0)::text AS weekly_lamports,
                   COUNT(*)::text AS weekly_count
                 FROM tenant_withdrawal_policy_events
                 WHERE tenant_id = $1 AND decision = 'allowed'
                   AND created_at >= date_trunc('week', clock_timestamp() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
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
