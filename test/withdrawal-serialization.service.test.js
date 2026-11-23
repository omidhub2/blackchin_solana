import test from 'node:test';
import assert from 'node:assert/strict';
import { createWithdrawalService } from '../src/core/withdrawals/withdrawal.service.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';

test('legacy withdrawal maps wallet-level in-flight uniqueness to a conflict before signing', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (query.includes('FROM wallet_accounts')) return { rows: [], rowCount: 0 };
      if (query.includes('FROM wallets')) {
        return {
          rows: [{ id: '7', public_key: SENDER, tenant_id: null, created_at: new Date() }],
          rowCount: 1
        };
      }
      if (query.includes('INSERT INTO api_idempotency_keys')) {
        const error = new Error('duplicate key violates uq_withdrawal_one_processing_per_legacy_wallet');
        error.code = '23505';
        error.constraint = 'uq_withdrawal_one_processing_per_legacy_wallet';
        throw error;
      }
      throw new Error('Unexpected SQL: ' + query);
    },
    async connect() {
      throw new Error('A competing withdrawal must be rejected before signing or ledger persistence');
    }
  };
  let signCalls = 0;
  const service = createWithdrawalService({
    db,
    network: 'devnet',
    commitment: 'confirmed',
    cipher: {},
    rpc: {
      async estimateTransfer() { return {}; },
      async sendSolWithSigner() { signCalls += 1; throw new Error('must not sign'); }
    }
  });

  await assert.rejects(() => service.submit({
    idempotencyKey: 'legacy-withdrawal-key-0001',
    fromPublicKey: SENDER,
    toPublicKey: RECIPIENT,
    amountSol: '0.1',
    approved: true
  }), (error) => error.code === 'WALLET_WITHDRAWAL_IN_PROGRESS' && error.statusCode === 409);

  assert.equal(signCalls, 0);
  assert.equal(calls.some((call) => call.query.includes('INSERT INTO api_idempotency_keys')), true);
});
