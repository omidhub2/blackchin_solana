import test from 'node:test';
import assert from 'node:assert/strict';

import { createWithdrawalService } from '../src/core/withdrawals/withdrawal.service.js';
import { resolveWallet } from '../src/infrastructure/security/wallet-signer.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';

function tenantWalletDb() {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (query.includes('FROM wallet_accounts') && query.includes('public_key')) {
        return { rows: [], rowCount: 0 };
      }
      if (query.includes('FROM wallets') && query.includes('public_key')) {
        return {
          rows: [{
            id: '91',
            public_key: SENDER,
            tenant_id: '42',
            created_at: new Date()
          }],
          rowCount: 1
        };
      }
      throw new Error('Unexpected SQL: ' + query);
    }
  };
}

test('wallet resolution carries tenant ownership from standalone wallet rows', async () => {
  const db = tenantWalletDb();
  const wallet = await resolveWallet(db, SENDER);

  assert.equal(wallet.tenantId, '42');
  assert.equal(wallet.walletType, 'standalone');
});

test('legacy withdrawal estimate rejects tenant-owned wallets before RPC', async () => {
  const db = tenantWalletDb();
  let rpcCalled = false;
  const service = createWithdrawalService({
    db,
    network: 'devnet',
    commitment: 'confirmed',
    cipher: {},
    rpc: {
      async estimateTransfer() {
        rpcCalled = true;
        throw new Error('RPC must not be called for tenant-owned wallets');
      }
    }
  });

  await assert.rejects(
    () => service.estimate({
      fromPublicKey: SENDER,
      toPublicKey: RECIPIENT,
      amountSol: '0.1'
    }),
    (error) => error.code === 'TENANT_WALLET_REQUIRES_TENANT_API'
  );
  assert.equal(rpcCalled, false);
});

test('legacy withdrawal submit rejects tenant-owned wallets before idempotency reservation or signing', async () => {
  const db = tenantWalletDb();
  let rpcCalled = false;
  const service = createWithdrawalService({
    db,
    network: 'devnet',
    commitment: 'confirmed',
    cipher: {},
    rpc: {
      async sendSolWithSigner() {
        rpcCalled = true;
        throw new Error('Signing must not run for tenant-owned wallets');
      }
    }
  });

  await assert.rejects(
    () => service.submit({
      idempotencyKey: 'tenant-withdrawal-key-001',
      fromPublicKey: SENDER,
      toPublicKey: RECIPIENT,
      amountSol: '0.1',
      approved: true
    }),
    (error) => error.code === 'TENANT_WALLET_REQUIRES_TENANT_API'
  );
  assert.equal(rpcCalled, false);
  assert.equal(db.calls.some(({ query }) => query.includes('INSERT INTO api_idempotency_keys')), false);
});
