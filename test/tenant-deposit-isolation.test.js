import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';
import { createDepositService } from '../src/core/deposits/deposit.service.js';
import {
  findTransactionBySignatureForTenant,
  listDepositsForTenant,
  getDepositMonitoringForTenant
} from '../src/infrastructure/database/blockchain-transaction.repository.js';

const signature = '5'.repeat(88);
const source = Keypair.generate().publicKey.toBase58();
const destination = Keypair.generate().publicKey.toBase58();

function makeDb(ownerTenantId) {
  const inserts = [];
  const account = {
    id: '11', hd_wallet_id: '22', public_key: destination, account_index: 0,
    derivation_path: "m/44'/501'/0'/0'", wallet_type: 'hd_child',
    network: 'devnet', status: 'active', created_at: new Date(), updated_at: new Date()
  };
  const root = {
    id: '22', owner_id: null, label: null, network: 'devnet',
    derivation_scheme: 'solana-slip10-ed25519',
    derivation_path_template: "m/44'/501'/{account}'/0'",
    mnemonic_encrypted: 'ciphertext', mnemonic_iv: 'iv', mnemonic_auth_tag: 'tag',
    encryption_key_version: 1, next_account_index: 1, status: 'active',
    phrase_provisioned_at: new Date(), recovery_token_hash: null,
    recovery_token_expires_at: null, created_at: new Date(), updated_at: new Date()
  };
  const db = {
    async query(sql, params) {
      if (sql.includes('FROM wallet_accounts') && sql.includes('WHERE tenant_id = $1 AND public_key = $2')) {
        return params[0] === String(ownerTenantId) ? { rows: [account], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM hd_wallets') && sql.includes('WHERE tenant_id = $1 AND id = $2')) {
        return params[0] === String(ownerTenantId) ? { rows: [root], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM wallets') && sql.includes('WHERE tenant_id = $1 AND public_key = $2')) {
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('INSERT INTO blockchain_transactions')) {
        inserts.push({ sql, params });
        const row = {
          id: '101', tenant_id: params[14], signature: params[0], direction: params[1],
          wallet_public_key: params[2], hd_wallet_id: params[3], counterparty: params[4],
          amount_lamports: params[5], fee_lamports: params[6], network: params[7],
          commitment: params[8], status: params[9], slot: params[10], block_time: params[11],
          idempotency_key: params[12], metadata: JSON.parse(params[13]),
          created_at: new Date(), updated_at: new Date()
        };
        return { rows: [row], rowCount: 1 };
      }
      throw new Error('Unexpected query: ' + sql);
    }
  };
  return { db, inserts };
}

function verifiedInput(tenantId) {
  return {
    tenantId, signature, publicKey: destination, hdWalletId: '22',
    from: source, lamports: '7000',
    transfers: [{ from: source, to: destination, lamports: '7000' }],
    commitment: 'finalized', confirmations: null,
    confirmationStatus: 'finalized', status: 'credited', slot: 123
  };
}

test('verified tenant deposit is persisted with the authenticated tenant id', async () => {
  const h = makeDb('41');
  const service = createDepositService({ db: h.db, network: 'devnet', commitment: 'confirmed', rpc: {} });
  const result = await service.recordVerifiedDeposit(verifiedInput('41'));
  assert.equal(result.created, true);
  assert.equal(result.transaction.tenantId, '41');
  assert.equal(h.inserts.length, 1);
  assert.equal(h.inserts[0].params[14], '41');
});

test('tenant cannot record a deposit to another tenant address or a legacy unassigned address', async () => {
  const h = makeDb('41');
  const service = createDepositService({ db: h.db, network: 'devnet', commitment: 'confirmed', rpc: {} });
  await assert.rejects(
    () => service.recordVerifiedDeposit(verifiedInput('42')),
    (error) => error.code === 'WALLET_NOT_FOUND'
  );
  assert.equal(h.inserts.length, 0);
});

test('tenant transaction lookup and history SQL always constrain tenant_id', async () => {
  const calls = [];
  const db = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 0 };
    }
  };
  assert.equal(await findTransactionBySignatureForTenant(db, '41', signature, destination), null);
  assert.deepEqual(await listDepositsForTenant(db, '41', { limit: 10, offset: 20 }), []);
  assert.deepEqual(await getDepositMonitoringForTenant(db, '41'), []);
  assert.match(calls[0].sql, /tenant_id = \$1/);
  assert.match(calls[1].sql, /tenant_id = \$1 AND direction = 'deposit'/);
  assert.deepEqual(calls.map((call) => call.params[0]), ['41', '41', '41']);
});
