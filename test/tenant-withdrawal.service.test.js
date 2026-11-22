import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantWithdrawalService } from '../src/core/withdrawals/tenant-withdrawal.service.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';

function walletDb({ account = true, parent = true } = {}) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      const query = String(sql);
      calls.push({ query, params });
      if (query.includes('FROM wallet_accounts')) {
        return account ? { rows: [{
          id: '10', tenant_id: '42', hd_wallet_id: '7', public_key: SENDER,
          account_index: 0, derivation_path: "m/44'/501'/0'/0'",
          wallet_type: 'hd_child', network: 'devnet', status: 'active',
          created_at: new Date(), updated_at: new Date()
        }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (query.includes('FROM hd_wallets')) {
        return parent ? { rows: [{
          id: '7', owner_id: null, label: 'tenant-root', network: 'devnet',
          derivation_scheme: 'solana-bip44', derivation_path_template: "m/44'/501'/{account}'/0'",
          mnemonic_encrypted: 'cipher', mnemonic_iv: 'iv', mnemonic_auth_tag: 'tag',
          encryption_key_version: 1, next_account_index: 1, status: 'active',
          phrase_provisioned_at: new Date(), recovery_token_hash: null,
          recovery_token_expires_at: null, created_at: new Date(), updated_at: new Date()
        }], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      throw new Error('Unexpected SQL: ' + query);
    }
  };
}

test('tenant withdrawal estimate resolves both child and parent within the authenticated tenant', async () => {
  const db = walletDb();
  let rpcCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    rpc: { async estimateTransfer() { rpcCalls += 1; return { sufficientBalance: true }; } }
  });
  const result = await service.estimate({
    tenantId: '42', fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1'
  });
  assert.equal(result.sufficientBalance, true);
  assert.equal(rpcCalls, 1);
  assert.ok(db.calls.every(({ params }) => params[0] === '42'));
  assert.equal(db.calls.length, 2);
});

test('tenant withdrawal estimate does not fall back to a wallet owned by another tenant', async () => {
  const db = walletDb({ account: false });
  let rpcCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    rpc: { async estimateTransfer() { rpcCalls += 1; return {}; } }
  });
  await assert.rejects(
    () => service.estimate({ tenantId: '42', fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1' }),
    (error) => error.code === 'WALLET_ACCOUNT_NOT_FOUND'
  );
  assert.equal(rpcCalls, 0);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].query, /tenant_id = \\$1/);
});

test('tenant withdrawal refuses inactive parent wallets before any RPC request', async () => {
  const db = walletDb();
  const original = db.query;
  db.query = async (sql, params) => {
    const result = await original(sql, params);
    if (String(sql).includes('FROM hd_wallets') && result.rows[0]) result.rows[0].status = 'disabled';
    return result;
  };
  let rpcCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    rpc: { async estimateTransfer() { rpcCalls += 1; return {}; } }
  });
  await assert.rejects(
    () => service.estimate({ tenantId: '42', fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1' }),
    (error) => error.code === 'WALLET_NOT_ACTIVE'
  );
  assert.equal(rpcCalls, 0);
});
