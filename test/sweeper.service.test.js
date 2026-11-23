import test from 'node:test';
import assert from 'node:assert/strict';
import { createSweeperService } from '../src/core/sweeper/sweeper.service.js';

const SOURCE = '11111111111111111111111111111111';
const DESTINATION = 'Stake11111111111111111111111111111111111111';
const SIGNATURE = '5'.repeat(88);

function harness({ balance = '100000', executionEnabled = true, failLedger = false } = {}) {
  const policy = {
    id: '3', tenant_id: null, network: 'devnet',
    destination_public_key: DESTINATION, enabled: true,
    execution_enabled: executionEnabled, funding_enabled: false,
    min_sol_sweep_lamports: '1000', retain_lamports: '10000',
    max_fee_lamports: '100000', max_sweeps_per_wallet_day: 20,
    policy_version: '1'
  };
  const source = {
    id: '9', tenant_id: null, hd_wallet_id: '2',
    public_key: SOURCE, network: 'devnet',
    account_status: 'active', parent_status: 'active'
  };
  const jobs = new Map();
  const events = [];
  const ledger = [];
  const calls = [];

  async function query(sql, params = []) {
    const text = String(sql);
    calls.push({ sql: text, params });
    if (text.includes('FROM sweep_policies')) return { rows: [policy], rowCount: 1 };
    if (text.includes('FROM wallet_accounts a')) return { rows: [source], rowCount: 1 };
    if (text.includes('INSERT INTO sweep_jobs')) {
      const row = {
        id: '41', tenant_id: params[0], policy_id: params[1],
        policy_version: params[2], network: params[3],
        source_public_key: params[4], hd_wallet_id: params[5],
        destination_public_key: params[6], asset_type: 'sol',
        source_balance_raw: params[7], amount_raw: params[8],
        estimated_fee_lamports: params[9], rent_exempt_lamports: params[10],
        observed_slot: params[11], idempotency_key: params[12],
        status: params[13], transaction_signature: null,
        error_code: null, error_message: null, created_at: new Date(), updated_at: new Date()
      };
      if (jobs.has(row.id)) return { rows: [], rowCount: 0 };
      jobs.set(row.id, row);
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('SELECT * FROM sweep_jobs WHERE idempotency_key')) {
      return { rows: [], rowCount: 0 };
    }
    if (text.includes('COUNT(*)::text AS total FROM sweep_jobs')) {
      return { rows: [{ total: '0' }], rowCount: 1 };
    }
    if (text.includes('pg_advisory_xact_lock')) return { rows: [], rowCount: 1 };
    if (text.includes('SELECT * FROM sweep_jobs')) {
      const row = jobs.get(String(params[0]));
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (text.includes('UPDATE sweep_jobs') && text.includes("status = 'submitted'")) {
      const row = jobs.get(String(params[0]));
      if (!row || row.status !== 'planned' || row.transaction_signature !== null) return { rows: [], rowCount: 0 };
      row.status = 'submitted';
      row.transaction_signature = params[1];
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('UPDATE sweep_jobs') && text.includes("status = 'completed'")) {
      const row = jobs.get(String(params[0]));
      if (!row || row.status !== 'submitted' || row.transaction_signature !== params[1]) return { rows: [], rowCount: 0 };
      row.status = 'completed';
      return { rows: [row], rowCount: 1 };
    }
    if (text.includes('INSERT INTO sweep_events')) {
      events.push({ params });
      return { rows: [], rowCount: 1 };
    }
    if (text.includes('FROM blockchain_transactions')) return { rows: [], rowCount: 0 };
    if (text.includes('INSERT INTO blockchain_transactions')) {
      if (failLedger) throw new Error('simulated ledger insert failure');
      const row = {
        id: '88', tenant_id: params[14], signature: params[0],
        direction: params[1], wallet_public_key: params[2],
        hd_wallet_id: params[3], counterparty: params[4],
        amount_lamports: params[5], fee_lamports: params[6],
        network: params[7], commitment: params[8], status: params[9],
        slot: params[10], idempotency_key: params[12], metadata: JSON.parse(params[13])
      };
      ledger.push(row);
      return { rows: [row], rowCount: 1 };
    }
    if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK') return { rows: [], rowCount: 0 };
    throw new Error(`Unhandled SQL in sweeper test: ${text}`);
  }

  const db = {
    query,
    async connect() {
      return { query, release() {} };
    }
  };
  const rpc = {
    async estimateSolSweep() {
      return { availableLamports: balance, estimatedFeeLamports: '5000' };
    },
    async getSlot() { return 123; },
    formatLamports(value) {
      const n = BigInt(value);
      return `${n / 1_000_000_000n}.${(n % 1_000_000_000n).toString().padStart(9, '0')}`;
    },
    async sendSolWithSigner(input) {
      calls.push({ action: 'broadcast-start' });
      await input.onSigned({ signature: SIGNATURE });
      calls.push({ action: 'broadcast' });
      return {
        sent: true, signature: SIGNATURE, network: 'devnet',
        amountLamports: '85000', feeLamports: '5000',
        confirmationStatus: 'confirmed', slot: 123
      };
    }
  };
  const signer = async (_db, _publicKey, callback) => callback({ keypair: { publicKey: SOURCE } });
  const service = createSweeperService({
    db, rpc, network: 'devnet', commitment: 'confirmed',
    signer, cipher: {}, executionEnabled: true, log() {}
  });
  return { service, rpc, policy, jobs, events, ledger, calls };
}

test('plans a native SOL sweep after exact fee and retained-balance deductions', async () => {
  const h = harness();
  const result = await h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE });

  assert.equal(result.created, true);
  assert.equal(result.job.status, 'planned');
  assert.equal(result.job.sourceBalanceRaw, '100000');
  assert.equal(result.job.estimatedFeeLamports, '5000');
  assert.equal(result.job.retainedLamports, '10000');
  assert.equal(result.job.amountRaw, '85000');
  assert.equal(h.events.length, 1);
});

test('marks balances below the configured sweep threshold as dust', async () => {
  const h = harness({ balance: '12000' });
  const result = await h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE });

  assert.equal(result.job.status, 'skipped_dust');
  assert.equal(result.job.amountRaw, '0');
  assert.equal(h.calls.some((call) => call.action === 'broadcast'), false);
});

test('does not plan when estimated network fee exceeds the policy ceiling', async () => {
  const h = harness();
  h.rpc.estimateSolSweep = async () => ({ availableLamports: '100000', estimatedFeeLamports: '100001' });

  await assert.rejects(
    () => h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE }),
    (error) => error.code === 'SWEEP_FEE_LIMIT_EXCEEDED'
  );
  assert.equal(h.jobs.size, 0);
});

test('persists the signed signature before broadcast and atomically records the sweep ledger', async () => {
  const h = harness();
  const plan = await h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE });
  const result = await h.service.executeSolSweep({ jobId: plan.job.id, tenantId: null });

  const signatureWrite = h.calls.findIndex((call) =>
    call.sql?.includes("status = 'submitted'") && call.sql.includes('transaction_signature = $2')
  );
  const broadcast = h.calls.findIndex((call) => call.action === 'broadcast');
  assert.ok(signatureWrite >= 0);
  assert.ok(broadcast > signatureWrite);
  assert.equal(result.job.status, 'completed');
  assert.equal(result.job.signature, SIGNATURE);
  assert.equal(h.ledger.length, 1);
  assert.equal(h.ledger[0].direction, 'sweep');
  assert.equal(h.ledger[0].amount_lamports, '85000');
  assert.equal(h.events.at(-1).params[3], 'completed');
});

test('refuses execution when the policy execution switch is off', async () => {
  const h = harness({ executionEnabled: false });
  const plan = await h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE });

  await assert.rejects(
    () => h.service.executeSolSweep({ jobId: plan.job.id, tenantId: null }),
    (error) => error.code === 'SWEEP_EXECUTION_DISABLED'
  );
  assert.equal(h.calls.some((call) => call.action === 'broadcast'), false);
});

test('does not mark a sweep completed if immutable ledger persistence fails after broadcast', async () => {
  const h = harness({ failLedger: true });
  const plan = await h.service.planSolSweep({ tenantId: null, sourcePublicKey: SOURCE });

  await assert.rejects(
    () => h.service.executeSolSweep({ jobId: plan.job.id, tenantId: null }),
    (error) => error.code === 'SWEEP_RECONCILIATION_REQUIRED' && error.signature === SIGNATURE
  );
  assert.equal(h.jobs.get('41').status, 'submitted');
  assert.equal(h.jobs.get('41').transaction_signature, SIGNATURE);
});
