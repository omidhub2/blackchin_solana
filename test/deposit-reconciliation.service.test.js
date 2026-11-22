import test from 'node:test';
import assert from 'node:assert/strict';

import { createDepositReconciliationService } from '../src/core/deposits/deposit-reconciliation.service.js';

function transactionRow(id = '41', status = 'credited') {
  return {
    id, signature: '5'.repeat(88), direction: 'deposit',
    wallet_public_key: '11111111111111111111111111111111',
    hd_wallet_id: null, counterparty: null, amount_lamports: '1000',
    fee_lamports: null, network: 'devnet', commitment: 'finalized',
    status, slot: 100, block_time: null, failure_reason: null,
    idempotency_key: null, metadata: {}, created_at: new Date(), updated_at: new Date()
  };
}

function harness({ candidates = [transactionRow()], refresh } = {}) {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO deposit_reconciliation_cursors')) {
        return { rows: [{ network: 'devnet', last_transaction_id: '0', status: 'idle' }], rowCount: 1 };
      }
      if (sql.includes('FROM blockchain_transactions')) {
        return { rows: candidates, rowCount: candidates.length };
      }
      if (sql.includes('INSERT INTO deposit_reconciliation_events')) {
        return { rows: [{ id: '900', checked_at: new Date() }], rowCount: 1 };
      }
      if (sql.includes('UPDATE deposit_reconciliation_cursors')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + sql);
    }
  };
  const deposits = {
    async refreshDeposit(signature, publicKey) {
      if (refresh) return refresh(signature, publicKey);
      return { status: 'under_review', signature, walletPublicKey: publicKey, slot: 100, commitment: 'finalized' };
    }
  };
  return { db, deposits, calls };
}

test('reconciliation records discrepancies and advances only after durable event insert', async () => {
  const h = harness();
  const service = createDepositReconciliationService({
    db: h.db, deposits: h.deposits, network: 'devnet', batchSize: 10
  });

  const result = await service.scan({ network: 'devnet' });

  assert.equal(result.checked, 1);
  assert.equal(result.failed, 0);
  assert.equal(h.calls.filter((call) => call.sql.includes('INSERT INTO deposit_reconciliation_events')).length, 1);
  assert.equal(h.calls.filter((call) => call.sql.includes('UPDATE deposit_reconciliation_cursors')).length, 1);
  const event = h.calls.find((call) => call.sql.includes('INSERT INTO deposit_reconciliation_events'));
  assert.equal(event.params[2], 'under_review');
  assert.equal(event.params[3], 'credited');
  assert.equal(event.params[4], 'under_review');
});

test('reconciliation records RPC failures and does not advance beyond an unverifiable row', async () => {
  const h = harness({
    refresh: async () => {
      const error = new Error('RPC unavailable');
      error.code = 'RPC_ERROR';
      throw error;
    }
  });
  const service = createDepositReconciliationService({
    db: h.db, deposits: h.deposits, network: 'devnet', batchSize: 10
  });

  const result = await service.scan({ network: 'devnet' });

  assert.equal(result.checked, 0);
  assert.equal(result.failed, 1);
  assert.equal(h.calls.filter((call) => call.sql.includes('INSERT INTO deposit_reconciliation_events')).length, 1);
  assert.equal(h.calls.filter((call) => call.sql.includes('UPDATE deposit_reconciliation_cursors')).length, 1);
  const event = h.calls.find((call) => call.sql.includes('INSERT INTO deposit_reconciliation_events'));
  assert.equal(event.params[2], 'rpc_error');
  assert.equal(h.calls.some((call) => call.sql.includes('SET last_transaction_id = $2')), false);
});

test('reconciliation resets its keyset cursor after reaching the end of a cycle', async () => {
  const h = harness({ candidates: [] });
  const service = createDepositReconciliationService({
    db: h.db, deposits: h.deposits, network: 'devnet'
  });

  const result = await service.scan();

  assert.equal(result.cycleCompleted, true);
  assert.equal(h.calls.some((call) => call.sql.includes('SET last_transaction_id = 0')), true);
});
