import test from 'node:test';
import assert from 'node:assert/strict';

import { createWithdrawalReconciliationService } from '../src/core/withdrawals/withdrawal-reconciliation.service.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';
const SIGNATURE = '5'.repeat(88);

function candidate(overrides = {}) {
  return {
    id: '12',
    idempotency_key: 'withdrawal-key-000001',
    wallet_public_key: SENDER,
    transaction_signature: SIGNATURE,
    to_public_key: RECIPIENT,
    amount_lamports: '2500',
    status: 'processing',
    operation: 'withdrawal',
    response_json: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides
  };
}

function harness({ row = candidate(), signatureStatus, parsed, rpcError, failCommit = false, failReconciliationEvent = false } = {}) {
  const calls = [];
  const clientCalls = [];
  const db = {
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (query.includes('INSERT INTO withdrawal_reconciliation_cursors')) {
        return { rows: [{ network: 'devnet', last_id: '0', status: 'idle' }], rowCount: 1 };
      }
      if (query.includes('FROM api_idempotency_keys')) {
        return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
      }
      if (query.includes('INSERT INTO withdrawal_reconciliation_events')) {
        return { rows: [{ id: '900', checked_at: new Date() }], rowCount: 1 };
      }
      if (query.includes('UPDATE withdrawal_reconciliation_cursors')) {
        return { rows: [], rowCount: 1 };
      }
      if (query.includes('FROM wallet_accounts')) return { rows: [], rowCount: 0 };
      if (query.includes('FROM wallets')) {
        return { rows: [{ id: '1', public_key: SENDER }], rowCount: 1 };
      }
      throw new Error('Unexpected pool SQL: ' + query);
    },
    async connect() {
      return {
        async query(sql, params) {
          const query = String(sql);
          clientCalls.push({ query, params });
          if (query === 'COMMIT' && failCommit) throw new Error('simulated PostgreSQL commit acknowledgement loss');
          if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(query)) return { rows: [], rowCount: 0 };
          if (query.includes('FROM blockchain_transactions')) return { rows: [], rowCount: 0 };
          if (query.includes('INSERT INTO blockchain_transactions')) return { rows: [], rowCount: 0 };
          if (query.includes('INSERT INTO withdrawal_reconciliation_events')) {
            if (failReconciliationEvent) throw new Error('simulated reconciliation event write failure');
            return { rows: [{ id: '901', checked_at: new Date() }], rowCount: 1 };
          }
          if (query.includes('UPDATE withdrawal_reconciliation_cursors')) return { rows: [], rowCount: 1 };
          if (query.includes('UPDATE api_idempotency_keys')) return { rows: [], rowCount: 1 };
          throw new Error('Unexpected client SQL: ' + query);
        },
        release() { clientCalls.push({ query: 'RELEASE' }); }
      };
    }
  };
  const rpc = {
    async getSignatureStatuses() {
      if (rpcError) throw rpcError;
      return { value: [signatureStatus ?? null] };
    },
    async getParsedTransaction() { return parsed ?? null; },
    formatLamports(value) {
      const n = BigInt(value);
      const whole = n / 1_000_000_000n;
      const fraction = (n % 1_000_000_000n).toString().padStart(9, '0').replace(/0+$/, '');
      return fraction ? `${whole}.${fraction}` : String(whole);
    }
  };
  return { db, rpc, calls, clientCalls };
}

function parsedTransfer({ source = SENDER, destination = RECIPIENT, lamports = 2500 } = {}) {
  return {
    slot: 123,
    blockTime: 1_700_000_000,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        accountKeys: [{ pubkey: SENDER }],
        instructions: [{
          program: 'system',
          parsed: { type: 'transfer', info: { source, destination, lamports } }
        }]
      }
    },
    meta: { err: null, fee: 5000 }
  };
}

test('finalized successful withdrawal is recorded once and idempotency key is completed atomically', async () => {
  const h = harness({
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer()
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  const result = await service.scan();

  assert.equal(result.checked, 1);
  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO blockchain_transactions')), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), true);
  assert.equal(h.clientCalls.some((x) => x.query === 'COMMIT'), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO withdrawal_reconciliation_events')), true);
});

test('confirmed but not finalized withdrawal stays processing and is not completed', async () => {
  const h = harness({ signatureStatus: { confirmationStatus: 'confirmed', err: null, slot: 123 } });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO withdrawal_reconciliation_events') && x.params?.[4] === 'pending'), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), false);
});

test('missing signature status remains unknown and never releases the idempotency guard', async () => {
  const h = harness({ signatureStatus: null });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO withdrawal_reconciliation_events') && x.params?.[4] === 'unknown'), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'failed'")), false);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), false);
});

test('finalized on-chain execution failure marks the idempotency record failed', async () => {
  const h = harness({ signatureStatus: { confirmationStatus: 'finalized', err: { InstructionError: [0, 'InsufficientFunds'] } } });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'failed'")), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), false);
});

test('finalized but mismatched parsed transfer is put under review', async () => {
  const h = harness({
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer({ source: RECIPIENT })
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO withdrawal_reconciliation_events') && x.params?.[4] === 'under_review'), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), false);
});

test('old processing row without signature is failed only at the safe pre-broadcast boundary', async () => {
  const h = harness({ row: candidate({ transaction_signature: null }) });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'failed'") && x.query.includes('transaction_signature IS NULL')), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO withdrawal_reconciliation_events') && x.params?.[4] === 'safe_prebroadcast_failed'), true);
});

test('tenant withdrawal reconciliation never falls back to a global wallet lookup', async () => {
  const h = harness({
    row: candidate({ tenant_id: '42' }),
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer()
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });
  await service.scan();
  const evidence = h.clientCalls.find((call) => call.query.includes('INSERT INTO withdrawal_reconciliation_events'));
  assert.equal(evidence.params[0], '42');
  assert.equal(evidence.params[4], 'under_review');
  assert.equal(h.calls.some((call) => call.query.includes('FROM wallets')), false);
});
test('RPC errors do not advance the reconciliation cursor', async () => {
  const h = harness({ rpcError: new Error('RPC unavailable') });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await assert.rejects(() => service.scan(), /Unable to reconcile withdrawal/);
  assert.equal(h.calls.some((x) => x.query.includes('UPDATE withdrawal_reconciliation_cursors') && x.query.includes('last_id = $2')), false);
});

test('finalized transaction with the wrong persisted amount remains under review', async () => {
  const h = harness({
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer({ lamports: 9999 })
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await service.scan();

  assert.equal(h.clientCalls.some((x) =>
    x.query.includes('INSERT INTO withdrawal_reconciliation_events') &&
    x.params?.[4] === 'under_review'
  ), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), false);
});


test('finalized withdrawal commit acknowledgement loss rolls back and leaves cursor retryable', async () => {
  const h = harness({
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer(),
    failCommit: true
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await assert.rejects(() => service.scan(), /simulated PostgreSQL commit acknowledgement loss/);

  assert.equal(h.clientCalls.some((x) => x.query === 'ROLLBACK'), true);
  assert.equal(h.clientCalls.some((x) => x.query === 'COMMIT'), true);
  assert.equal(h.calls.some((x) => x.query.includes('UPDATE withdrawal_reconciliation_cursors') && x.query.includes('last_id = $2')), false);
  assert.equal(h.calls.some((x) => x.query.includes("status = 'error'")), true);
});

test('reconciliation event write failure rolls back ledger and idempotency completion', async () => {
  const h = harness({
    signatureStatus: { confirmationStatus: 'finalized', err: null, slot: 123 },
    parsed: parsedTransfer(),
    failReconciliationEvent: true
  });
  const service = createWithdrawalReconciliationService({ db: h.db, rpc: h.rpc, network: 'devnet' });

  await assert.rejects(() => service.scan(), /simulated reconciliation event write failure/);

  assert.equal(h.clientCalls.some((x) => x.query.includes('INSERT INTO blockchain_transactions')), true);
  assert.equal(h.clientCalls.some((x) => x.query.includes("SET status = 'completed'")), true);
  assert.equal(h.clientCalls.some((x) => x.query === 'ROLLBACK'), true);
  assert.equal(h.clientCalls.some((x) => x.query === 'COMMIT'), false);
  assert.equal(h.calls.some((x) => x.query.includes('UPDATE withdrawal_reconciliation_cursors') && x.query.includes('last_id = $2')), false);
});
