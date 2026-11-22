import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import { createWithdrawalService } from '../src/core/withdrawals/withdrawal.service.js';
import { createBalanceService } from '../src/core/balance/hd-balance.service.js';
import { createDepositService } from '../src/core/deposits/deposit.service.js';
import {
  createCipher,
  createEnvKeyProvider
} from '../src/infrastructure/security/hd-envelope.js';
import { deriveSolanaAccount } from '../src/blockchain/solana/hd/derivation.js';
import { extractIncomingTransfers } from '../Solana/solTransfer.js';
import { createFakePool } from './helpers/fake-pool.js';
import { MemoryHdDatabase } from './helpers/memory-hd-db.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon diesel';

const cipher = createCipher(createEnvKeyProvider({ ENCRYPTION_KEY: 'e'.repeat(64) }));
const SENT_SIGNATURE = '5'.repeat(88);

function sealedMnemonic(hdWalletId) {
  return cipher.encrypt(MNEMONIC, { aad: `hd_wallets:${hdWalletId}:mnemonic:v1` });
}

function preparedRoot(memory) {
  const hdWallet = memory.addHdWallet();
  const sealed = sealedMnemonic(hdWallet.id);

  Object.assign(hdWallet, {
    mnemonic_encrypted: sealed.ciphertext,
    mnemonic_iv: sealed.iv,
    mnemonic_auth_tag: sealed.authTag
  });

  return hdWallet;
}

function basePool(memory) {
  const pool = createFakePool();

  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);
  pool.onQuery('lock_timeout', () => undefined);
  pool.onQuery('pg_advisory_xact_lock', () => undefined);

  // Signing-path row locks.
  pool.onQuery('FROM wallet_accounts\n      WHERE id = $1\n      FOR SHARE', (params) => {
    const row = memory.accounts.find((item) => String(item.id) === String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM hd_wallets\n      WHERE id = $1\n      FOR SHARE', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM wallet_accounts WHERE public_key', (params) => {
    const row = memory.accountByPublicKey(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM wallets WHERE public_key', (params) => {
    const row = memory.legacy?.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM hd_wallets', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  return pool;
}

// ---------------------------------------------------------------------------
// Withdrawals
// ---------------------------------------------------------------------------

function buildWithdrawalHarness() {
  const memory = new MemoryHdDatabase();
  const hdWallet = preparedRoot(memory);
  const account = memory.addAccount({
    hdWalletId: hdWallet.id,
    publicKey: deriveSolanaAccount(MNEMONIC, 0).publicKey,
    accountIndex: 0
  });

  const pool = basePool(memory);
  const idempotency = new Map();
  const transactions = [];
  let failIdempotencyWrites = false;

  pool.onQuery('INSERT INTO api_idempotency_keys', (params) => {
    const [key, hash, walletPublicKey] = params;

    if (idempotency.has(key)) return { rows: [], rowCount: 0 };

    idempotency.set(key, {
      request_hash: hash,
      status: 'processing',
      response_json: null,
      wallet_public_key: walletPublicKey,
      operation: 'withdrawal',
      transaction_signature: null
    });

    return { rows: [{ idempotency_key: key }], rowCount: 1 };
  });

  pool.onQuery('FROM api_idempotency_keys', (params) => {
    const row = idempotency.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('SET transaction_signature = $2', (params) => {
    const row = idempotency.get(params[0]);
    if (!row || row.status !== 'processing' || row.transaction_signature !== null) {
      return { rows: [], rowCount: 0 };
    }
    row.transaction_signature = params[1];
    return { rows: [], rowCount: 1 };
  });

  pool.onQuery("SET status = 'failed'", (params) => {
    const row = idempotency.get(params[0]);
    if (row && row.status === 'processing') row.status = 'failed';
    return { rows: [], rowCount: 1 };
  });

  pool.onQuery('SET status = \'completed\'', (params) => {
    if (failIdempotencyWrites) {
      throw new Error('database connection lost');
    }

    const row = idempotency.get(params[0]);
    if (!row) return { rows: [], rowCount: 0 };

    row.status = 'completed';
    row.response_json = JSON.parse(params[1]);
    return { rows: [], rowCount: 1 };
  });

  pool.onQuery('FROM blockchain_transactions', (params) => {
    const row = transactions.find(
      (item) => item.signature === params[0] && item.walletPublicKey === params[1] && item.direction === params[2]
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('INSERT INTO blockchain_transactions', (params) => {
    const record = {
      id: String(transactions.length + 1),
      signature: params[0],
      direction: params[1],
      walletPublicKey: params[2],
      hdWalletId: params[3],
      amountLamports: params[5],
      feeLamports: params[6],
      network: params[7],
      status: params[9],
      slot: params[10],
      idempotencyKey: params[12]
    };

    transactions.push(record);
    return { rows: [record], rowCount: 1 };
  });

  const rpcCalls = [];

  const rpc = {
    network: 'devnet',
    async estimateTransfer(input) {
      rpcCalls.push(['estimate', input]);

      return {
        network: 'devnet',
        amountLamports: '100000',
        estimatedFeeLamports: '5000',
        totalRequiredLamports: '100005000',
        sufficientBalance: true
      };
    },
    async sendSolWithSigner(input) {
      rpcCalls.push(['send', input]);
      await input.onSigned?.({ signature: SENT_SIGNATURE });

      return {
        sent: true,
        signature: SENT_SIGNATURE,
        network: 'devnet',
        from: input.fromPublicKey,
        to: input.toPublicKey,
        amountLamports: '100000',
        amountSol: '0.1',
        feeLamports: '5000',
        feeSol: '0.000005',
        slot: 123,
        confirmationStatus: 'confirmed'
      };
    }
  };

  const service = createWithdrawalService({ db: pool, rpc, network: 'devnet', commitment: 'confirmed', cipher });

  return {
    service,
    pool,
    memory,
    account,
    hdWallet,
    idempotency,
    transactions,
    rpcCalls,
    failIdempotency: () => {
      failIdempotencyWrites = true;
    }
  };
}

const KEY = 'withdrawal-key-000001';
const DESTINATION = Keypair.generate().publicKey.toBase58();

test('withdrawal signs with the HD child key and records the ledger row', async () => {
  const h = buildWithdrawalHarness();

  const result = await h.service.submit({
    idempotencyKey: KEY,
    fromPublicKey: h.account.public_key,
    toPublicKey: DESTINATION,
    amountSol: '0.1',
    approved: true
  });

  assert.equal(result.sent, true);
  assert.equal(result.signature, SENT_SIGNATURE);
  assert.equal(result.walletType, 'hd_child');
  assert.equal(result.hdWalletId, h.hdWallet.id);

  const sendCall = h.rpcCalls.find(([name]) => name === 'send')[1];
  const keypair = sendCall.getKeypair();

  assert.equal(keypair.publicKey.toBase58(), h.account.public_key);
  assert.equal(h.transactions.length, 1);
  assert.equal(h.transactions[0].direction, 'withdrawal');
  assert.equal(h.transactions[0].status, 'confirmed');
  assert.equal(h.transactions[0].amountLamports, '100000');
  assert.equal(h.transactions[0].idempotencyKey, KEY);
  assert.equal(h.idempotency.get(KEY).status, 'completed');
  assert.equal(h.idempotency.get(KEY).transaction_signature, SENT_SIGNATURE);
});

test('a repeated idempotency key replays the stored response without re-sending', async () => {
  const h = buildWithdrawalHarness();
  const request = {
    idempotencyKey: KEY,
    fromPublicKey: h.account.public_key,
    toPublicKey: DESTINATION,
    amountSol: '0.1',
    approved: true
  };

  const first = await h.service.submit(request);
  const second = await h.service.submit(request);

  assert.equal(first.replayed, undefined);
  assert.equal(second.replayed, true);
  assert.equal(second.signature, first.signature);
  assert.equal(h.rpcCalls.filter(([name]) => name === 'send').length, 1);
});

test('the same key with a different amount is rejected', async () => {
  const h = buildWithdrawalHarness();
  const base = {
    idempotencyKey: KEY,
    fromPublicKey: h.account.public_key,
    toPublicKey: DESTINATION,
    amountSol: '0.1',
    approved: true
  };

  await h.service.submit(base);

  await assert.rejects(
    () => h.service.submit({ ...base, amountSol: '0.2' }),
    (error) => error.code === 'IDEMPOTENCY_KEY_REUSED'
  );

  assert.equal(h.rpcCalls.filter(([name]) => name === 'send').length, 1);
});

test('unapproved or badly keyed withdrawals never reach the signer', async () => {
  const h = buildWithdrawalHarness();
  const base = {
    idempotencyKey: KEY,
    fromPublicKey: h.account.public_key,
    toPublicKey: DESTINATION,
    amountSol: '0.1',
    approved: true
  };

  await assert.rejects(
    () => h.service.submit({ ...base, approved: false }),
    (error) => error.code === 'APPROVAL_REQUIRED'
  );

  await assert.rejects(
    () => h.service.submit({ ...base, idempotencyKey: 'short' }),
    (error) => error.code === 'INVALID_IDEMPOTENCY_KEY'
  );

  assert.equal(h.rpcCalls.length, 0);
});

test('a broadcast or confirmation error after signing keeps the reservation locked with its signature', async () => {
  const h = buildWithdrawalHarness();
  h.service = createWithdrawalService({
    db: h.pool,
    cipher,
    rpc: {
      async estimateTransfer() { return {}; },
      async sendSolWithSigner(input) {
        await input.onSigned({ signature: SENT_SIGNATURE });
        const error = new Error('RPC confirmation timeout');
        error.signature = SENT_SIGNATURE;
        throw error;
      }
    },
    network: 'devnet',
    commitment: 'confirmed'
  });

  await assert.rejects(
    () => h.service.submit({
      idempotencyKey: KEY,
      fromPublicKey: h.account.public_key,
      toPublicKey: DESTINATION,
      amountSol: '0.1',
      approved: true
    }),
    (error) => error.code === 'WITHDRAWAL_RECONCILIATION_REQUIRED'
      && error.signature === SENT_SIGNATURE
  );

  assert.equal(h.idempotency.get(KEY).status, 'processing');
  assert.equal(h.idempotency.get(KEY).transaction_signature, SENT_SIGNATURE);
  assert.equal(h.transactions.length, 0);

  await assert.rejects(
    () => h.service.submit({
      idempotencyKey: KEY,
      fromPublicKey: h.account.public_key,
      toPublicKey: DESTINATION,
      amountSol: '0.1',
      approved: true
    }),
    (error) => error.code === 'IDEMPOTENCY_IN_PROGRESS'
  );
});

test('a signing failure marks the reservation failed and allows no replay', async () => {
  const h = buildWithdrawalHarness();
  h.service = createWithdrawalService({
    db: h.pool,
    cipher,
    rpc: {
      ...{
        estimateTransfer: async () => ({})
      },
      async sendSolWithSigner() {
        throw new Error('insufficient SOL');
      }
    },
    network: 'devnet',
    commitment: 'confirmed'
  });

  await assert.rejects(
    () =>
      h.service.submit({
        idempotencyKey: KEY,
        fromPublicKey: h.account.public_key,
        toPublicKey: DESTINATION,
        amountSol: '0.1',
        approved: true
      }),
    /insufficient SOL/
  );

  assert.equal(h.idempotency.get(KEY).status, 'failed');
  assert.equal(h.transactions.length, 0);

  await assert.rejects(
    () =>
      h.service.submit({
        idempotencyKey: KEY,
        fromPublicKey: h.account.public_key,
        toPublicKey: DESTINATION,
        amountSol: '0.1',
        approved: true
      }),
    (error) => error.code === 'IDEMPOTENCY_IN_PROGRESS'
  );
});

test('a completed broadcast with a lost DB write returns the signature and keeps the key locked', async () => {
  const h = buildWithdrawalHarness();
  h.failIdempotency();

  const originalError = console.error;
  console.error = () => { };

  let result;

  try {
    result = await h.service.submit({
      idempotencyKey: KEY,
      fromPublicKey: h.account.public_key,
      toPublicKey: DESTINATION,
      amountSol: '0.1',
      approved: true
    });
  } finally {
    console.error = originalError;
  }

  assert.equal(result.signature, SENT_SIGNATURE);
  assert.equal(h.idempotency.get(KEY).status, 'processing');
});

test('inactive or unknown source wallets are rejected', async () => {
  const h = buildWithdrawalHarness();
  h.memory.accountByPublicKey(h.account.public_key).status = 'disabled';

  await assert.rejects(
    () =>
      h.service.submit({
        idempotencyKey: KEY,
        fromPublicKey: h.account.public_key,
        toPublicKey: DESTINATION,
        amountSol: '0.1',
        approved: true
      }),
    (error) => error.code === 'WALLET_NOT_ACTIVE'
  );

  await assert.rejects(
    () =>
      h.service.submit({
        idempotencyKey: 'withdrawal-key-000002',
        fromPublicKey: Keypair.generate().publicKey.toBase58(),
        toPublicKey: DESTINATION,
        amountSol: '0.1',
        approved: true
      }),
    (error) => error.statusCode === 404
  );
});

test('network mismatch blocks withdrawals before the key is reserved', async () => {
  const h = buildWithdrawalHarness();
  h.memory.accountByPublicKey(h.account.public_key).network = 'mainnet-beta';

  await assert.rejects(
    () =>
      h.service.submit({
        idempotencyKey: KEY,
        fromPublicKey: h.account.public_key,
        toPublicKey: DESTINATION,
        amountSol: '0.1',
        approved: true
      }),
    (error) => error.code === 'NETWORK_MISMATCH'
  );

  assert.equal(h.idempotency.size, 0);
});

// ---------------------------------------------------------------------------
// Balance
// ---------------------------------------------------------------------------

test('HD aggregate balance deduplicates accounts and sums lamports with BigInt', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const balances = new Map([
    ['a', 1_000_000_001],
    ['b', 2_000_000_000]
  ]);

  for (const [publicKey, index] of [['a', 0], ['b', 1]]) {
    memory.addAccount({ hdWalletId: hdWallet.id, publicKey, accountIndex: index });
  }

  // Duplicate row simulating an accidental repeated join.
  memory.accounts.push({ ...memory.accounts[0], id: 'dup' });

  const pool = basePool(memory);

  pool.onQuery('FROM wallet_accounts\n      WHERE hd_wallet_id', (params) =>
    ({ rows: memory.accounts.filter((item) => String(item.hd_wallet_id) === String(params[0])), rowCount: 2 })
  );

  pool.onQuery('COUNT(*)::text AS total FROM wallet_accounts', () =>
    ({ rows: [{ total: String(memory.accounts.length) }], rowCount: 1 })
  );

  const rpc = {
    network: 'devnet',
    async getBalance(publicKey) {
      return { publicKey, lamports: balances.get(publicKey), sol: String(balances.get(publicKey) / 1e9) };
    },
    formatLamports: (lamports) => `${lamports}lamports`
  };

  const service = createBalanceService({ db: pool, rpc, commitment: 'confirmed' });
  const result = await service.getHdWalletBalance(hdWallet.id);

  assert.equal(result.accountCount, 2);
  assert.equal(result.totalLamports, '3000000001');
  assert.equal(result.complete, true);
  assert.equal(result.accounts.length, 2);
});

test('partial RPC failures are reported without corrupting the aggregate', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();

  memory.addAccount({ hdWalletId: hdWallet.id, publicKey: 'c', accountIndex: 0 });
  memory.addAccount({ hdWalletId: hdWallet.id, publicKey: 'd', accountIndex: 1 });

  const pool = basePool(memory);
  pool.onQuery('FROM wallet_accounts\n      WHERE hd_wallet_id', () =>
    ({ rows: memory.accounts, rowCount: 2 })
  );
  pool.onQuery('COUNT(*)::text AS total FROM wallet_accounts', () =>
    ({ rows: [{ total: String(memory.accounts.length) }], rowCount: 1 })
  );

  const service = createBalanceService({
    db: pool,
    commitment: 'confirmed',
    rpc: {
      network: 'devnet',
      async getBalance(publicKey) {
        if (publicKey === 'd') throw new Error('RPC unavailable');
        return { lamports: 42 };
      },
      formatLamports: (value) => String(value)
    }
  });

  const result = await service.getHdWalletBalance(hdWallet.id);

  assert.equal(result.complete, false);
  assert.equal(result.totalLamports, '42');
  assert.equal(result.accounts.find((item) => item.publicKey === 'd').error, 'RPC_ERROR');
});

test('rate limiting from the RPC surfaces as 503', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  memory.addAccount({ hdWalletId: hdWallet.id, publicKey: 'e', accountIndex: 0 });

  const pool = basePool(memory);
  pool.onQuery('FROM wallet_accounts\n      WHERE hd_wallet_id', () => ({ rows: memory.accounts, rowCount: 1 }));
  pool.onQuery('COUNT(*)::text AS total FROM wallet_accounts', () =>
    ({ rows: [{ total: String(memory.accounts.length) }], rowCount: 1 })
  );

  const service = createBalanceService({
    db: pool,
    commitment: 'confirmed',
    rpc: {
      network: 'devnet',
      async getBalance() {
        const error = new Error('HTTP 429 Too Many Requests');
        error.code = 429;
        throw error;
      },
      formatLamports: String
    }
  });

  await assert.rejects(
    () => service.getHdWalletBalance(hdWallet.id),
    (error) => error.statusCode === 503 && ['RPC_RATE_LIMITED', 'RPC_UNAVAILABLE'].includes(error.code)
  );
});

// ---------------------------------------------------------------------------
// Deposits
// ---------------------------------------------------------------------------

function depositHarness({ parsed, status }) {
  const memory = new MemoryHdDatabase();
  const account = memory.addAccount({
    hdWalletId: '1',
    publicKey: Keypair.generate().publicKey.toBase58(),
    accountIndex: 0
  });

  const pool = basePool(memory);
  const rows = [];

  pool.onQuery('FROM blockchain_transactions', (params) => {
    const row = rows.find(
      (item) => item.signature === params[0] && item.walletPublicKey === params[1] && item.direction === params[2]
    );
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('INSERT INTO blockchain_transactions', (params) => {
    const record = {
      id: String(rows.length + 1),
      signature: params[0],
      direction: params[1],
      walletPublicKey: params[2],
      hdWalletId: params[3],
      counterparty: params[4],
      amount_lamports: params[5],
      status: params[9],
      slot: params[10]
    };

    rows.push(record);
    return { rows: [record], rowCount: 1 };
  });

  const service = createDepositService({
    db: pool,
    network: 'devnet',
    commitment: 'confirmed',
    rpc: {
      network: 'devnet',
      // Real chain parsing (same implementation the production adapter uses).
      extractIncomingTransfers,
      async getParsedTransaction() {
        return typeof parsed === 'function' ? parsed(account) : parsed;
      },
      async getSignatureStatuses() {
        return { value: [status] };
      }
    }
  });

  return { service, account, rows };
}

function incomingParsed(account, lamports = 250_000_000) {
  return {
    slot: 99,
    blockTime: 1_700_000_000,
    meta: { err: null, innerInstructions: [] },
    transaction: {
      message: {
        instructions: [
          {
            program: 'system',
            parsed: {
              type: 'transfer',
              info: {
                source: Keypair.generate().publicKey.toBase58(),
                destination: account.public_key,
                lamports
              }
            }
          }
        ]
      }
    }
  };
}

const SIGNATURE = '2'.repeat(88);

test('a confirmed incoming SOL transfer is recorded exactly once', async () => {
  const h = depositHarness({
    parsed: (account) => incomingParsed(account),
    status: { err: null, confirmationStatus: 'confirmed' }
  });

  const first = await h.service.recordDeposit(SIGNATURE, h.account.public_key);

  assert.equal(first.created, true);
  assert.equal(first.deposit.status, 'confirmed');
  assert.equal(String(first.deposit.amount_lamports ?? first.deposit.amountLamports), '250000000');

  const second = await h.service.recordDeposit(SIGNATURE, h.account.public_key);

  assert.equal(second.created, false);
  assert.equal(h.rows.length, 1);
});

test('a failed transaction is never credited', async () => {
  const h = depositHarness({
    parsed: (account) => ({
      ...incomingParsed(account),
      meta: { err: { InstructionError: [0, 'Custom'] } }
    }),
    status: { err: null, confirmationStatus: 'confirmed' }
  });

  await assert.rejects(
    () => h.service.recordDeposit(SIGNATURE, h.account.public_key),
    (error) => error.code === 'TRANSACTION_FAILED'
  );

  assert.equal(h.rows.length, 0);
});

test('a transfer to a different destination is not credited', async () => {
  const h = depositHarness({
    parsed: () => incomingParsed({ public_key: Keypair.generate().publicKey.toBase58() }),
    status: { err: null, confirmationStatus: 'confirmed' }
  });

  await assert.rejects(
    () => h.service.recordDeposit(SIGNATURE, h.account.public_key),
    (error) => error.code === 'NO_MATCHING_TRANSFER'
  );

  assert.equal(h.rows.length, 0);
});

test('an unconfirmed transaction is rejected until it confirms', async () => {
  const h = depositHarness({
    parsed: (account) => incomingParsed(account),
    status: { err: null, confirmationStatus: 'processed' }
  });

  await assert.rejects(
    () => h.service.recordDeposit(SIGNATURE, h.account.public_key),
    (error) => error.code === 'TRANSACTION_NOT_CONFIRMED'
  );

  assert.equal(h.rows.length, 0);
});

test('a missing transaction or unknown wallet is rejected', async () => {
  const h = depositHarness({ parsed: null, status: null });

  await assert.rejects(
    () => h.service.recordDeposit(SIGNATURE, h.account.public_key),
    (error) => error.code === 'TRANSACTION_NOT_FOUND'
  );

  await assert.rejects(
    () => h.service.recordDeposit(SIGNATURE, Keypair.generate().publicKey.toBase58()),
    (error) => error.code === 'WALLET_NOT_FOUND'
  );
});

test('verification reports amounts and transfer details without writing', async () => {
  const h = depositHarness({
    parsed: (account) => incomingParsed(account, 1_500_000_000),
    status: { err: null, confirmationStatus: 'finalized' }
  });

  const view = await h.service.verifyIncoming(SIGNATURE, h.account.public_key);

  assert.equal(view.found, true);
  assert.equal(view.confirmed, true);
  assert.equal(view.status, 'credited');
  assert.equal(view.totalLamports, '1500000000');
  assert.equal(view.transfers.length, 1);
  assert.equal(h.rows.length, 0);
});
