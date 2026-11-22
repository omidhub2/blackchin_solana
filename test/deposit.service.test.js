import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import { createDepositService } from '../src/core/deposits/deposit.service.js';

const signature = '5'.repeat(88);
const from = Keypair.generate().publicKey.toBase58();
const destination = Keypair.generate().publicKey.toBase58();

function buildDepositHarness() {
  const inserted = [];
  const account = {
    id: '21',
    hd_wallet_id: '9',
    public_key: destination,
    account_index: 0,
    derivation_path: "m/44'/501'/0'/0'",
    wallet_type: 'hd_child',
    network: 'devnet',
    status: 'active'
  };
  const root = {
    id: '9',
    network: 'devnet',
    derivation_scheme: 'solana-slip10-ed25519',
    status: 'active'
  };

  const db = {
    async query(sql, params) {
      if (sql.includes('FROM wallet_accounts WHERE public_key')) {
        return { rows: params[0] === destination ? [account] : [], rowCount: params[0] === destination ? 1 : 0 };
      }
      if (sql.includes('FROM hd_wallets WHERE id')) {
        return { rows: params[0] === '9' ? [root] : [], rowCount: params[0] === '9' ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO blockchain_transactions')) {
        const row = {
          id: String(inserted.length + 1),
          signature: params[0],
          direction: params[1],
          wallet_public_key: params[2],
          hd_wallet_id: params[3],
          counterparty: params[4],
          amount_lamports: params[5],
          fee_lamports: params[6],
          network: params[7],
          commitment: params[8],
          status: params[9],
          slot: params[10],
          block_time: params[11],
          idempotency_key: params[12],
          metadata: JSON.parse(params[13]),
          created_at: new Date(),
          updated_at: new Date()
        };
        inserted.push(row);
        return { rows: [row], rowCount: 1 };
      }
      throw new Error('Unexpected database query: ' + sql);
    }
  };

  return {
    inserted,
    service: createDepositService({
      db,
      network: 'devnet',
      commitment: 'confirmed',
      rpc: {}
    })
  };
}

const transfer = () => ({ from, to: destination, lamports: '1250000' });

test('recordVerifiedDeposit persists only internally consistent verified transfer evidence', async () => {
  const h = buildDepositHarness();
  const result = await h.service.recordVerifiedDeposit({
    signature,
    publicKey: destination,
    hdWalletId: '9',
    from,
    lamports: '1250000',
    transfers: [transfer()],
    commitment: 'confirmed',
    confirmations: 4,
    confirmationStatus: 'confirmed',
    status: 'confirmed',
    slot: 120
  });

  assert.equal(result.created, true);
  assert.equal(result.transaction.amountLamports, '1250000');
  assert.equal(result.transaction.counterparty, from);
  assert.equal(result.transaction.metadata.confirmations, 4);
  assert.equal(result.transaction.metadata.confirmationStatus, 'confirmed');
  assert.equal(h.inserted.length, 1);
});

test('recordVerifiedDeposit rejects a mismatched amount before writing', async () => {
  const h = buildDepositHarness();

  await assert.rejects(
    () => h.service.recordVerifiedDeposit({
      signature,
      publicKey: destination,
      hdWalletId: '9',
      from,
      lamports: '1250001',
      transfers: [transfer()],
      status: 'confirmed'
    }),
    (error) => error.code === 'AMOUNT_MISMATCH'
  );

  assert.equal(h.inserted.length, 0);
});

test('recordVerifiedDeposit rejects transfer evidence for another destination', async () => {
  const h = buildDepositHarness();

  await assert.rejects(
    () => h.service.recordVerifiedDeposit({
      signature,
      publicKey: destination,
      hdWalletId: '9',
      from,
      lamports: '1250000',
      transfers: [{ ...transfer(), to: from }],
      status: 'confirmed'
    }),
    (error) => error.code === 'INVALID_TRANSFER'
  );

  assert.equal(h.inserted.length, 0);
});

test('recordVerifiedDeposit refuses failed or rejected transaction states', async () => {
  const h = buildDepositHarness();

  await assert.rejects(
    () => h.service.recordVerifiedDeposit({
      signature,
      publicKey: destination,
      hdWalletId: '9',
      from,
      lamports: '1250000',
      transfers: [transfer()],
      status: 'rejected'
    }),
    (error) => error.code === 'INVALID_STATUS'
  );

  assert.equal(h.inserted.length, 0);
});


test('previously credited deposits enter review when missing from chain and recover on finality', async () => {
  const account = {
    id: '21',
    hd_wallet_id: '9',
    public_key: destination,
    account_index: 0,
    derivation_path: "m/44'/501'/0'/0'",
    wallet_type: 'hd_child',
    network: 'devnet',
    status: 'active'
  };
  const root = { id: '9', network: 'devnet', status: 'active' };
  const existing = {
    id: '77',
    signature,
    direction: 'deposit',
    wallet_public_key: destination,
    hd_wallet_id: '9',
    counterparty: from,
    amount_lamports: '1250000',
    fee_lamports: null,
    network: 'devnet',
    commitment: 'finalized',
    status: 'credited',
    slot: 120,
    block_time: null,
    failure_reason: null,
    idempotency_key: null,
    metadata: {},
    created_at: new Date(),
    updated_at: new Date()
  };
  let parsed = null;
  let chainStatus = 'finalized';
  const db = {
    async query(sql, params) {
      if (sql.includes('FROM blockchain_transactions') && sql.includes('WHERE signature = $1')) {
        return { rows: [existing], rowCount: 1 };
      }
      if (sql.includes('FROM wallet_accounts WHERE public_key')) {
        return { rows: [account], rowCount: 1 };
      }
      if (sql.includes('FROM hd_wallets WHERE id')) {
        return { rows: [root], rowCount: 1 };
      }
      if (sql.includes('UPDATE blockchain_transactions')) {
        existing.status = params[1];
        existing.commitment = params[2] ?? existing.commitment;
        existing.slot = params[3] ?? existing.slot;
        existing.block_time = params[4] ?? existing.block_time;
        existing.failure_reason = params[7] ? null : (params[5] ?? existing.failure_reason);
        if (params[6]) existing.metadata = { ...existing.metadata, ...JSON.parse(params[6]) };
        return { rows: [existing], rowCount: 1 };
      }
      throw new Error('Unexpected database query: ' + sql);
    }
  };
  const rpc = {
    async getParsedTransaction() { return parsed; },
    async getSignatureStatuses() {
      return { value: [{ confirmationStatus: chainStatus, confirmations: null, err: null }] };
    },
    extractIncomingTransfers() { return [transfer()]; }
  };
  const service = createDepositService({ db, rpc, network: 'devnet', commitment: 'confirmed' });

  const missing = await service.refreshDeposit(signature, destination);
  assert.equal(missing.status, 'under_review');
  assert.match(missing.failureReason, /no longer verifiable/i);

  parsed = { slot: 120, blockTime: null, meta: { err: null } };
  const recovered = await service.refreshDeposit(signature, destination);
  assert.equal(recovered.status, 'credited');
  assert.equal(recovered.failureReason, null);
  assert.equal(recovered.metadata.chainVerification, 'present');

  chainStatus = 'confirmed';
  const regressed = await service.refreshDeposit(signature, destination);
  assert.equal(regressed.status, 'under_review');
  assert.match(regressed.failureReason, /finality regressed/i);

  chainStatus = 'finalized';
  const finalizedAgain = await service.refreshDeposit(signature, destination);
  assert.equal(finalizedAgain.status, 'credited');
  assert.equal(finalizedAgain.failureReason, null);
});
