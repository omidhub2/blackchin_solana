import test from 'node:test';
import assert from 'node:assert/strict';
import { createTenantWithdrawalService } from '../src/core/withdrawals/tenant-withdrawal.service.js';

const SENDER = '11111111111111111111111111111111';
const RECIPIENT = 'Stake11111111111111111111111111111111111111';

function walletDb({ account = true, parent = true } = {}) {
  const calls = [];
  return {
    calls,
    async connect() { throw new Error('connect should not be reached in policy preflight tests'); },
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
      if (query.includes('INSERT INTO api_idempotency_keys')) {
        return { rows: [{ id: '900' }], rowCount: 1 };
      }
      if (query.includes('UPDATE api_idempotency_keys')) {
        return { rows: [], rowCount: 1 };
      }
      throw new Error('Unexpected SQL: ' + query);
    }
  };
}

test('tenant withdrawal history and detail queries always constrain tenant ownership', async () => {
  const calls = [];
  const db = {
    async connect() { throw new Error('connection should not be needed'); },
    async query(sql, params) {
      calls.push({ query: String(sql), params });
      return { rows: [{
        idempotency_key: 'tenant-withdrawal-key-001', status: 'processing', network: 'devnet',
        wallet_public_key: SENDER, to_public_key: RECIPIENT, amount_lamports: '1000',
        transaction_signature: null, approval_reference: 'partner-approval-001',
        response_json: null, created_at: new Date(), updated_at: new Date()
      }], rowCount: 1 };
    }
  };
  const service = createTenantWithdrawalService({
    db, network: 'devnet', cipher: {},
    rpc: { async estimateTransfer() { return {}; }, async sendSolWithSigner() { throw new Error('unused'); } }
  });
  const history = await service.list({ tenantId: '42', limit: 10, offset: 5 });
  const detail = await service.get({ tenantId: '42', idempotencyKey: 'tenant-withdrawal-key-001' });
  assert.equal(history.items[0].status, 'processing');
  assert.equal(detail.idempotencyKey, 'tenant-withdrawal-key-001');
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.query.includes('WHERE tenant_id = $1')));
  assert.ok(calls.every((call) => call.params[0] === '42'));
});
test('tenant withdrawal policy denial fails its idempotency reservation and never signs', async () => {
  const db = walletDb();
  let policyCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    tenantWithdrawalPolicy: { async authorize(input) { policyCalls += 1; assert.equal(input.tenantId, '42'); return false; } },
    rpc: { async estimateTransfer() { return {}; }, async sendSolWithSigner() { throw new Error('must not sign'); } }
  });
  await assert.rejects(() => service.submit({
    tenantId: '42', credentialId: '1', idempotencyKey: 'tenant-withdrawal-key-001',
    fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1',
    approvalReference: 'partner-approval-001'
  }), (error) => error.code === 'WITHDRAWAL_NOT_AUTHORIZED');
  assert.equal(policyCalls, 1);
  assert.equal(db.calls.some(({ query }) => query.includes('INSERT INTO api_idempotency_keys')), true);
  assert.equal(db.calls.some(({ query }) => query.includes("SET status = 'failed'")), true);
});

test('tenant withdrawal fails closed when no trusted policy provider is configured', async () => {
  const db = walletDb();
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    rpc: { async estimateTransfer() { return {}; }, async sendSolWithSigner() { throw new Error('must not sign'); } }
  });
  await assert.rejects(() => service.submit({
    tenantId: '42', credentialId: '1', idempotencyKey: 'tenant-withdrawal-key-001',
    fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1',
    approvalReference: 'partner-approval-001'
  }), (error) => error.code === 'WITHDRAWAL_POLICY_UNAVAILABLE' && error.statusCode === 503);
  assert.equal(db.calls.some(({ query }) => query.includes('INSERT INTO api_idempotency_keys')), false);
});
test('tenant withdrawal estimate resolves both child and parent within the authenticated tenant', async () => {
  const db = walletDb();
  let rpcCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    rpc: { async estimateTransfer() { rpcCalls += 1; return { sufficientBalance: true }; }, async sendSolWithSigner() { throw new Error('must not send'); } }
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
    rpc: { async estimateTransfer() { rpcCalls += 1; return {}; }, async sendSolWithSigner() { throw new Error('must not send'); } }
  });
  await assert.rejects(
    () => service.estimate({ tenantId: '42', fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1' }),
    (error) => error.code === 'WALLET_ACCOUNT_NOT_FOUND'
  );
  assert.equal(rpcCalls, 0);
  assert.equal(db.calls.length, 1);
  assert.match(db.calls[0].query, /tenant_id = \$1/);
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
    rpc: { async estimateTransfer() { rpcCalls += 1; return {}; }, async sendSolWithSigner() { throw new Error('must not send'); } }
  });
  await assert.rejects(
    () => service.estimate({ tenantId: '42', fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1' }),
    (error) => error.code === 'WALLET_NOT_ACTIVE'
  );
  assert.equal(rpcCalls, 0);
});

test('tenant withdrawal maps wallet-level in-flight uniqueness to a conflict without signing', async () => {
  const db = walletDb();
  const originalQuery = db.query.bind(db);
  db.query = async (sql, params) => {
    if (String(sql).includes('INSERT INTO api_idempotency_keys')) {
      const error = new Error('duplicate key violates uq_withdrawal_one_processing_per_tenant_wallet');
      error.code = '23505';
      error.constraint = 'uq_withdrawal_one_processing_per_tenant_wallet';
      throw error;
    }
    return originalQuery(sql, params);
  };
  let signCalls = 0;
  const service = createTenantWithdrawalService({
    db, network: 'devnet', commitment: 'confirmed', cipher: {},
    tenantWithdrawalPolicy: { async authorize() { return true; } },
    rpc: {
      async estimateTransfer() { return {}; },
      async sendSolWithSigner() { signCalls += 1; throw new Error('must not sign'); }
    }
  });

  await assert.rejects(() => service.submit({
    tenantId: '42', credentialId: '1', idempotencyKey: 'tenant-withdrawal-key-002',
    fromPublicKey: SENDER, toPublicKey: RECIPIENT, amountSol: '0.1',
    approvalReference: 'partner-approval-002'
  }), (error) => error.code === 'WALLET_WITHDRAWAL_IN_PROGRESS' && error.statusCode === 409);
  assert.equal(signCalls, 0);
});
