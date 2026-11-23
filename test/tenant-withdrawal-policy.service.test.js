import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createTenantWithdrawalPolicyService,
  hashTenantWithdrawalRequest
} from '../src/core/withdrawals/tenant-withdrawal-policy.service.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';
const REQUEST = {
  fromPublicKey: SENDER,
  toPublicKey: RECIPIENT,
  amountLamports: '100000000',
  network: 'devnet',
  approvalReference: 'approval-tenant-0001'
};

function makeHarness({
  policy = {
    enabled: true, emergency_frozen: false,
    max_single_lamports: '200000000',
    max_daily_lamports: '500000000',
    max_weekly_lamports: '1000000000',
    max_daily_count: 5, max_weekly_count: 10, policy_version: '3'
  },
  destination = true,
  approval = true,
  usage = {
    daily_lamports: '100000000', daily_count: '1',
    weekly_lamports: '200000000', weekly_count: '2'
  }
} = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      const query = String(sql);
      calls.push({ query, params });
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query.trim())) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes('FROM tenant_withdrawal_policies')) {
        return { rows: policy ? [policy] : [], rowCount: policy ? 1 : 0 };
      }
      if (query.includes('FROM tenant_withdrawal_destinations')) {
        return { rows: destination ? [{ id: '5' }] : [], rowCount: destination ? 1 : 0 };
      }
      if (query.includes('FROM tenant_withdrawal_approvals')) {
        return { rows: approval ? [{
          tenant_id: '42', credential_id: '7',
          approval_reference: REQUEST.approvalReference,
          request_hash: hashTenantWithdrawalRequest(REQUEST),
          wallet_public_key: SENDER, destination_public_key: RECIPIENT,
          network: 'devnet', asset: 'SOL', amount_lamports: '100000000',
          status: 'approved', expires_at: new Date(Date.now() + 60_000)
        }] : [], rowCount: approval ? 1 : 0 };
      }
      if (query.includes('FROM tenant_withdrawal_policy_events')) {
        return { rows: [usage], rowCount: 1 };
      }
      if (query.includes('UPDATE tenant_withdrawal_approvals')) {
        return { rows: [], rowCount: 1 };
      }
      if (query.includes('INSERT INTO tenant_withdrawal_policy_events')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + query);
    },
    release() { calls.push({ query: 'RELEASE', params: [] }); }
  };
  return {
    calls,
    db: { async connect() { return client; } }
  };
}

function input() {
  return {
    tenantId: '42',
    credentialId: '7',
    approvalReference: REQUEST.approvalReference,
    idempotencyKey: 'tenant-withdrawal-key-001',
    requestHash: hashTenantWithdrawalRequest(REQUEST),
    fromPublicKey: SENDER,
    toPublicKey: RECIPIENT,
    amountLamports: '100000000',
    network: 'devnet'
  };
}

test('tenant withdrawal policy atomically authorizes and consumes a bound approval', async () => {
  const h = makeHarness();
  const policy = createTenantWithdrawalPolicyService({ db: h.db });
  const result = await policy.authorize(input());

  assert.equal(result.allowed, true);
  assert.equal(result.decision, 'allowed');
  assert.equal(result.policyVersion, '3');
  assert.ok(h.calls.some((call) => /FROM tenant_withdrawal_policies[\s\S]*FOR UPDATE/i.test(call.query)));
  assert.ok(h.calls.some((call) => call.query.includes("SET status = 'consumed'")));
  assert.ok(h.calls.some((call) => call.query.includes('INSERT INTO tenant_withdrawal_policy_events') &&
    call.params[4] === 'allowed'));
  assert.ok(h.calls.some((call) => call.query.trim() === 'COMMIT'));
  assert.ok(h.calls.some((call) => call.query === 'RELEASE'));
});

test('tenant withdrawal policy fails closed when a tenant has no policy row', async () => {
  const h = makeHarness({ policy: null });
  const policy = createTenantWithdrawalPolicyService({ db: h.db });
  const result = await policy.authorize(input());

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'POLICY_NOT_CONFIGURED');
  assert.equal(h.calls.some((call) => call.query.includes('FROM tenant_withdrawal_destinations')), false);
  assert.ok(h.calls.some((call) => call.query.includes('INSERT INTO tenant_withdrawal_policy_events') &&
    call.params[4] === 'denied'));
});

test('emergency freeze prevents destination, approval and signing authorization', async () => {
  const h = makeHarness({ policy: {
    enabled: true, emergency_frozen: true,
    max_single_lamports: '200000000',
    max_daily_lamports: '500000000',
    max_weekly_lamports: '1000000000',
    max_daily_count: 5, max_weekly_count: 10, policy_version: '4'
  } });
  const policy = createTenantWithdrawalPolicyService({ db: h.db });
  const result = await policy.authorize(input());

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'frozen');
  assert.equal(result.reasonCode, 'EMERGENCY_FREEZE_ACTIVE');
  assert.equal(h.calls.some((call) => call.query.includes('FROM tenant_withdrawal_approvals')), false);
});

test('zero withdrawal limits fail closed instead of meaning unlimited spending', async () => {
  const h = makeHarness({ policy: {
    enabled: true, emergency_frozen: false,
    max_single_lamports: '0',
    max_daily_lamports: '500000000',
    max_weekly_lamports: '1000000000',
    max_daily_count: 5, max_weekly_count: 10, policy_version: '5'
  } });
  const policy = createTenantWithdrawalPolicyService({ db: h.db });
  const result = await policy.authorize(input());

  assert.equal(result.allowed, false);
  assert.equal(result.reasonCode, 'POLICY_LIMITS_NOT_CONFIGURED');
  assert.equal(h.calls.some((call) => call.query.includes('FROM tenant_withdrawal_approvals')), false);
});

test('tenant withdrawal policy enforces the daily amount limit under the tenant row lock', async () => {
  const h = makeHarness({ usage: {
    daily_lamports: '450000000', daily_count: '1',
    weekly_lamports: '450000000', weekly_count: '1'
  } });
  const policy = createTenantWithdrawalPolicyService({ db: h.db });
  const result = await policy.authorize(input());

  assert.equal(result.allowed, false);
  assert.equal(result.decision, 'limited');
  assert.equal(result.reasonCode, 'DAILY_WITHDRAWAL_AMOUNT_LIMIT_EXCEEDED');
  assert.equal(h.calls.some((call) => call.query.includes("SET status = 'consumed'")), false);
});


test('policy configuration always leaves withdrawals frozen until explicit unfreeze', async () => {
  const calls = [];
  const db = {
    async connect() { throw new Error('transaction not needed in this test'); },
    async query(sql, params) {
      calls.push({ query: String(sql), params });
      return {
        rowCount: 1,
        rows: [{
          tenant_id: '42', enabled: true, emergency_frozen: true,
          freeze_reason: 'Policy changed; explicit unfreeze required',
          max_single_lamports: params[2], max_daily_lamports: params[3],
          max_weekly_lamports: params[4], max_daily_count: params[5],
          max_weekly_count: params[6], policy_version: '1',
          updated_by: params[7], created_at: new Date(), updated_at: new Date()
        }]
      };
    }
  };
  const policy = createTenantWithdrawalPolicyService({ db });
  const result = await policy.configurePolicy({
    tenantId: '42', enabled: true,
    maxSingleLamports: '100000000',
    maxDailyLamports: '500000000',
    maxWeeklyLamports: '2000000000',
    maxDailyCount: 5, maxWeeklyCount: 20,
    updatedBy: 'admin@example.com'
  });

  assert.equal(result.enabled, true);
  assert.equal(result.emergencyFrozen, true);
  assert.match(calls[0].query, /emergency_frozen = TRUE/);
  assert.match(calls[0].query, /policy_version = tenant_withdrawal_policies\.policy_version \+ 1/);
});

test('destination activation requires a different second approver', async () => {
  let paramsSeen;
  const db = {
    async connect() { throw new Error('transaction not needed in this test'); },
    async query(sql, params) {
      paramsSeen = params;
      assert.match(String(sql), /created_by IS DISTINCT FROM \$3/);
      return {
        rowCount: 1,
        rows: [{
          id: '9', tenant_id: '42', network: 'devnet', asset: 'SOL',
          destination_public_key: RECIPIENT, status: 'active',
          label: 'treasury', created_by: 'maker@example.com',
          approved_by: 'checker@example.com', approved_at: new Date(),
          revoked_at: null, created_at: new Date()
        }]
      };
    }
  };
  const policy = createTenantWithdrawalPolicyService({ db });
  const result = await policy.activateDestination({
    tenantId: '42', destinationId: '9', approvedBy: 'checker@example.com'
  });

  assert.equal(result.status, 'active');
  assert.deepEqual(paramsSeen, ['42', '9', 'checker@example.com']);
});

test('approval issuance is bound to an active destination, active tenant wallet and submit credential', async () => {
  const calls = [];
  const db = {
    async connect() { throw new Error('transaction not needed in this test'); },
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (query.includes('FROM tenant_withdrawal_approvals')) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes('FROM tenant_withdrawal_policies')) {
        return { rows: [{ enabled: true, emergency_frozen: false }], rowCount: 1 };
      }
      if (query.includes('FROM tenant_withdrawal_destinations')) {
        return { rows: [{ id: '9' }], rowCount: 1 };
      }
      if (query.includes('FROM wallet_accounts')) {
        return { rows: [{ id: '10' }], rowCount: 1 };
      }
      if (query.includes('INSERT INTO tenant_withdrawal_approvals')) {
        return {
          rowCount: 1,
          rows: [{
            tenant_id: '42', credential_id: '7',
            approval_reference: REQUEST.approvalReference,
            request_hash: hashTenantWithdrawalRequest(REQUEST),
            wallet_public_key: SENDER, destination_public_key: RECIPIENT,
            network: 'devnet', asset: 'SOL', amount_lamports: '100000000',
            status: 'approved', issuer: 'dashboard:admin@example.com',
            issuer_event_id: 'e2e4aef8-67f7-43f2-a6f0-85bb03fbb4a1',
            expires_at: new Date(Date.now() + 60_000), approved_at: new Date()
          }]
        };
      }
      throw new Error('Unexpected SQL: ' + query);
    }
  };
  const policy = createTenantWithdrawalPolicyService({ db });
  const approval = await policy.issueApproval({
    tenantId: '42', credentialId: '7',
    approvalReference: REQUEST.approvalReference,
    requestHash: hashTenantWithdrawalRequest(REQUEST),
    walletPublicKey: SENDER, destinationPublicKey: RECIPIENT,
    amountLamports: '100000000', network: 'devnet',
    expiresAt: new Date(Date.now() + 60_000),
    issuer: 'dashboard:admin@example.com'
  });

  assert.equal(approval.tenantId, '42');
  assert.equal(approval.status, 'approved');
  assert.equal(calls.length, 5);
  assert.match(calls[3].query, /c\.scopes @> ARRAY\['withdrawals:submit'\]::text\[\]/);
});
