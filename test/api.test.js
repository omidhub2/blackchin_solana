process.env.API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'k'.repeat(40);

import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import { buildServer } from '../src/api/server.js';
import { AppError } from '../src/core/errors.js';
import { createMetricsService } from '../src/core/metrics.service.js';

const API_KEY = process.env.API_ACCESS_KEY;
const DESTINATION = Keypair.generate().publicKey.toBase58();

/**
 * Minimal fake service container that records calls, so route contracts
 * (validation, status codes, auth, error mapping) are tested without a DB.
 */
function createFakeServices() {
  const calls = [];
  const record = (name) => (...args) => {
    calls.push([name, ...args]);
    return null;
  };

  const state = {
    hdWallet: {
      id: '1',
      ownerId: null,
      label: null,
      network: 'devnet',
      derivationScheme: 'bip39+slip10-ed25519/v1',
      derivationPathTemplate: "m/44'/501'/{accountIndex}'/0'",
      nextAccountIndex: 3,
      status: 'active',
      phraseProvisioned: false,
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    },
    account: {
      id: '10',
      hdWalletId: '1',
      publicKey: DESTINATION,
      accountIndex: 0,
      derivationPath: "m/44'/501'/0'/0'",
      walletType: 'hd_child',
      network: 'devnet',
      status: 'active',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z'
    }
  };

  return {
    calls,
    state,
    services: {
      hdWallets: {
        async createHdWallet(input) {
          calls.push(['createHdWallet', input]);
          return {
            wallet: state.hdWallet,
            recovery: { token: 't'.repeat(64), wordCount: 24, expiresAt: 'x', warning: 'w' }
          };
        },
        async getHdWallet(id) {
          calls.push(['getHdWallet', id]);
          if (String(id) !== state.hdWallet.id) throw new AppError('HD wallet was not found', 404, 'HD_WALLET_NOT_FOUND');
          return state.hdWallet;
        },
        async updateStatus(id, status) {
          calls.push(['updateStatus', id, status]);
          return { ...state.hdWallet, status };
        },
        async consumeRecoveryPhrase(input) {
          calls.push(['consumeRecoveryPhrase', input]);
          if (!input.confirm) throw new AppError('confirm required', 409, 'CONFIRMATION_REQUIRED');
          return { hdWalletId: String(input.hdWalletId), mnemonic: 'a b c', wordCount: 24, warning: 'w' };
        },
        async revealMnemonicForSigning(id) {
          calls.push(['revealMnemonicForSigning', id]);
          return 'abandon '.repeat(23) + 'diesel';
        },
        async deriveAccountPreview(id, index) {
          calls.push(['deriveAccountPreview', id, index]);
          return { hdWalletId: String(id), accountIndex: index, derivationPath: `m/44'/501'/${index}'/0'`, publicKey: 'abc' };
        }
      },
      childWallets: {
        async createAccounts(id, options) {
          calls.push(['createAccounts', id, options.count]);
          await options.resolveMnemonic();
          return { hdWalletId: String(id), accounts: [state.account], nextAccountIndex: 4 };
        },
        async listAccounts(id, paging) {
          calls.push(['listAccounts', id, paging.limit, paging.offset]);
          return { hdWalletId: String(id), total: 1, limit: 100, offset: 0, items: [state.account] };
        },
        async getAccountAtIndex(id, index) {
          calls.push(['getAccountAtIndex', id, index]);
          return { ...state.account, accountIndex: index };
        },
        async getAccountByPublicKey(publicKey) {
          calls.push(['getAccountByPublicKey', publicKey]);
          return publicKey === DESTINATION ? state.account : null;
        },
        async setAccountStatus(publicKey, status) {
          calls.push(['setAccountStatus', publicKey, status]);
          return { ...state.account, status };
        }
      },
      balances: {
        async getWalletBalance(publicKey) {
          calls.push(['getWalletBalance', publicKey]);
          return { publicKey, lamports: '1', sol: '0.000000001' };
        },
        async getHdWalletBalance(id) {
          calls.push(['getHdWalletBalance', id]);
          return { hdWalletId: String(id), totalLamports: '1', totalSol: '0.000000001', accounts: [] };
        }
      },
      deposits: {
        async getDepositAddress(publicKey) {
          calls.push(['getDepositAddress', publicKey]);
          return { publicKey, depositAddress: publicKey, network: 'devnet' };
        },
        async verifyIncoming(signature, publicKey) {
          calls.push(['verifyIncoming', signature, publicKey]);
          return { found: true, signature, publicKey, transfers: [] };
        },
        async recordDeposit(signature, publicKey) {
          calls.push(['recordDeposit', signature, publicKey]);
          return { created: true, deposit: { signature, walletPublicKey: publicKey, status: 'confirmed' } };
        },
        async refreshDeposit(signature, publicKey) {
          calls.push(['refreshDeposit', signature, publicKey]);
          return { signature, walletPublicKey: publicKey, status: 'confirmed' };
        }
      },
      withdrawals: {
        async estimate(input) {
          calls.push(['estimate', input]);
          return { amountLamports: '1', estimatedFeeLamports: '1' };
        },
        async submit(input) {
          calls.push(['submit', input]);
          return { sent: true, signature: '5'.repeat(88), replayed: input.idempotencyKey === 'replay-key-0000001' };
        }
      },
      transactions: {
        async listWalletTransactions(publicKey, query) {
          calls.push(['listWalletTransactions', publicKey, query]);
          return { walletPublicKey: publicKey, items: [] };
        },
        async listHdWalletTransactions(id, query) {
          calls.push(['listHdWalletTransactions', id, query]);
          return { hdWalletId: String(id), items: [] };
        }
      },
      standaloneWallets: {
        async createWallet() {
          calls.push(['createWallet']);
          return { id: '1', publicKey: DESTINATION };
        },
        async getWallet(publicKey) {
          calls.push(['getWallet', publicKey]);
          return null;
        }
      },
      record
    }
  };
}

function makeApp() {
  const fake = createFakeServices();
  const app = buildServer({ logger: false, services: fake.services });
  return { app, fake };
}

const HI = { 'x-api-key': API_KEY };

test('Prometheus metrics are API-key protected and use route templates', async () => {
  const fake = createFakeServices();
  const metrics = createMetricsService();
  const app = buildServer({ logger: false, services: fake.services, metrics });
  try {
    await app.inject({ url: '/health' });
    assert.equal((await app.inject({ url: '/metrics' })).statusCode, 401);
    const response = await app.inject({ url: '/metrics', headers: HI });
    assert.equal(response.statusCode, 200);
    assert.match(response.headers['content-type'], /text\/plain/);
    assert.match(response.body, /blackchin_http_requests_total/);
    assert.match(response.body, /route="\\/health"/);
    assert.equal(response.body.includes('route="\\/metrics"'), false);
  } finally {
    await app.close();
  }
});

test('health is public; every other route requires the API key', async () => {
  const { app } = makeApp();

  try {
    assert.equal((await app.inject({ url: '/health' })).statusCode, 200);
    assert.equal((await app.inject({ url: '/api/v1/hd-wallets/1' })).statusCode, 401);
    assert.equal(
      (await app.inject({ url: '/api/v1/hd-wallets/1', headers: { 'x-api-key': 'wrong' } })).statusCode,
      401
    );
    assert.equal((await app.inject({ url: '/api/v1/hd-wallets/1', headers: HI })).statusCode, 200);
  } finally {
    await app.close();
  }
});

test('unknown routes return 404 and invalid JSON returns 400', async () => {
  const { app } = makeApp();

  try {
    const notFound = await app.inject({ url: '/api/v1/nope', headers: HI });
    assert.equal(notFound.statusCode, 404);
    assert.equal(notFound.json().error, 'NOT_FOUND');

    const badJson = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets',
      headers: { ...HI, 'content-type': 'application/json' },
      payload: '{'
    });

    assert.equal(badJson.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('creating an HD wallet validates the body and returns the recovery token', async () => {
  const { app, fake } = makeApp();

  try {
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets',
      headers: HI,
      payload: { label: 'treasury' }
    });

    assert.equal(created.statusCode, 201);
    assert.ok(created.json().recovery.token);
    assert.equal(created.json().wallet.id, '1');
    assert.deepEqual(fake.calls.at(-1)[1], { label: 'treasury', ownerId: undefined });

    const unknownField = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets',
      headers: HI,
      payload: { label: 'x', ownerId: 'a', nextAccountIndex: 99 }
    });

    assert.equal(unknownField.statusCode, 400);
    assert.match(unknownField.json().message, /Unsupported/);

    const badOwner = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets',
      headers: HI,
      payload: { ownerId: 'bad owner!' }
    });

    assert.equal(badOwner.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('HD wallet id routing validates numeric ids', async () => {
  const { app } = makeApp();

  try {
    assert.equal((await app.inject({ url: '/api/v1/hd-wallets/abc', headers: HI })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/hd-wallets/0', headers: HI })).statusCode, 400);
    assert.equal((await app.inject({ url: '/api/v1/hd-wallets/2', headers: HI })).statusCode, 404);
  } finally {
    await app.close();
  }
});

test('batch account creation enforces count limits', async () => {
  const { app, fake } = makeApp();

  try {
    for (const count of [0, 51, 2.5, 'abc']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/hd-wallets/1/accounts/batch',
        headers: HI,
        payload: { count }
      });

      assert.equal(response.statusCode, 400, `count=${count}`);
    }

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets/1/accounts/batch',
      headers: HI,
      payload: { count: 2 }
    });

    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().accounts.length, 1);
    assert.equal(fake.calls.find(([name]) => name === 'createAccounts')[2], 2);

    // The mnemonic is resolved through the HD wallet service, never the body.
    assert.ok(fake.calls.some(([name]) => name === 'revealMnemonicForSigning'));
  } finally {
    await app.close();
  }
});

test('recovery phrase consumption requires explicit confirmation', async () => {
  const { app } = makeApp();

  try {
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/hd-wallets/1/recovery-phrase/consume',
      headers: HI,
      payload: { token: 't'.repeat(40), confirm: false }
    });

    assert.equal(response.statusCode, 409);
  } finally {
    await app.close();
  }
});

test('wallet metadata resolves HD children when no standalone wallet exists', async () => {
  const { app } = makeApp();

  try {
    const response = await app.inject({ url: `/api/v1/wallets/${DESTINATION}`, headers: HI });

    assert.equal(response.statusCode, 200);
    assert.equal(response.json().walletType, 'hd_child');

    const invalid = await app.inject({ url: '/api/v1/wallets/not-a-key', headers: HI });
    assert.equal(invalid.statusCode, 400);
    assert.equal(invalid.json().error, 'INVALID_PUBLIC_KEY');
  } finally {
    await app.close();
  }
});

test('transfer estimate and submit validate their contract', async () => {
  const { app, fake } = makeApp();

  try {
    const missing = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers/estimate',
      headers: HI,
      payload: { fromPublicKey: DESTINATION }
    });

    assert.equal(missing.statusCode, 400);

    const unapproved = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { ...HI, 'idempotency-key': 'key-0000000000001' },
      payload: { fromPublicKey: DESTINATION, toPublicKey: DESTINATION, amountSol: '0.1', approved: false }
    });

    assert.equal(unapproved.statusCode, 400);
    assert.equal(unapproved.json().error, 'APPROVAL_REQUIRED');

    const noKey = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: HI,
      payload: { fromPublicKey: DESTINATION, toPublicKey: DESTINATION, amountSol: '0.1', approved: true }
    });

    assert.equal(noKey.statusCode, 400);
    assert.equal(noKey.json().error, 'INVALID_IDEMPOTENCY_KEY');

    const badAmount = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { ...HI, 'idempotency-key': 'key-0000000000001' },
      payload: { fromPublicKey: DESTINATION, toPublicKey: DESTINATION, amountSol: '0.0000000001', approved: true }
    });

    assert.equal(badAmount.statusCode, 400);
    assert.equal(badAmount.json().error, 'INVALID_AMOUNT');

    const ok = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { ...HI, 'idempotency-key': 'key-0000000000001' },
      payload: { fromPublicKey: DESTINATION, toPublicKey: DESTINATION, amountSol: '0.1', approved: true }
    });

    assert.equal(ok.statusCode, 201);
    assert.equal(ok.json().sent, true);
    assert.equal(fake.calls.filter(([name]) => name === 'submit').length, 1);

    const replay = await app.inject({
      method: 'POST',
      url: '/api/v1/transfers',
      headers: { ...HI, 'idempotency-key': 'replay-key-0000001' },
      payload: { fromPublicKey: DESTINATION, toPublicKey: DESTINATION, amountSol: '0.1', approved: true }
    });

    assert.equal(replay.statusCode, 200);
  } finally {
    await app.close();
  }
});

test('deposit routes validate signatures and public keys', async () => {
  const { app } = makeApp();

  try {
    const badSignature = await app.inject({
      url: '/api/v1/deposits/abc?publicKey=' + DESTINATION,
      headers: HI
    });

    assert.equal(badSignature.statusCode, 400);

    const goodSignature = '2'.repeat(88);
    const verify = await app.inject({
      url: `/api/v1/transfers/${goodSignature}?publicKey=${DESTINATION}`,
      headers: HI
    });

    assert.equal(verify.statusCode, 200);
    assert.equal(verify.json().found, true);

    const record = await app.inject({
      method: 'POST',
      url: `/api/v1/transfers/${goodSignature}/confirm`,
      headers: HI,
      payload: { publicKey: DESTINATION }
    });

    assert.equal(record.statusCode, 201);
    assert.equal(record.json().created, true);

    const history = await app.inject({
      url: `/api/v1/wallets/${DESTINATION}/deposits?limit=5`,
      headers: HI
    });

    assert.equal(history.statusCode, 200);
    assert.equal(history.json().walletPublicKey, DESTINATION);
  } finally {
    await app.close();
  }
});

test('domain errors are mapped without leaking internals', async () => {
  const fake = createFakeServices();

  fake.services.hdWallets.getHdWallet = async () => {
    const error = new Error('connection to 10.0.0.5:5432 failed');
    error.code = 'ECONNREFUSED';
    throw error;
  };

  const app = buildServer({ logger: false, services: fake.services });

  try {
    const response = await app.inject({ url: '/api/v1/hd-wallets/1', headers: HI });

    assert.equal(response.statusCode, 500);
    assert.equal(response.json().error, 'INTERNAL_SERVER_ERROR');
    assert.doesNotMatch(response.json().message, /10\.0\.0\.5/);
  } finally {
    await app.close();
  }
});

test('balance and history endpoints preserve their query contracts', async () => {
  const { app, fake } = makeApp();

  try {
    const balance = await app.inject({ url: `/api/v1/wallets/${DESTINATION}/balance`, headers: HI });
    assert.equal(balance.statusCode, 200);
    assert.equal(fake.calls.at(-1)[0], 'getWalletBalance');

    const aggregate = await app.inject({ url: '/api/v1/hd-wallets/1/balance', headers: HI });
    assert.equal(aggregate.statusCode, 200);
    assert.equal(fake.calls.at(-1)[0], 'getHdWalletBalance');

    const transactions = await app.inject({ url: '/api/v1/hd-wallets/1/transactions?limit=5', headers: HI });
    assert.equal(transactions.statusCode, 200);
    assert.deepEqual(fake.calls.find(([name]) => name === 'listHdWalletTransactions')[2].limit, 5);

    const badLimit = await app.inject({ url: '/api/v1/hd-wallets/1/transactions?limit=1000', headers: HI });
    assert.equal(badLimit.statusCode, 400);
  } finally {
    await app.close();
  }
});

test('status routes accept only known lifecycle values', async () => {
  const { app } = makeApp();

  try {
    const ok = await app.inject({
      method: 'PATCH',
      url: '/api/v1/hd-wallets/1',
      headers: HI,
      payload: { status: 'disabled' }
    });

    assert.equal(ok.statusCode, 200);

    const bad = await app.inject({
      method: 'PATCH',
      url: '/api/v1/hd-wallets/1',
      headers: HI,
      payload: { status: 'nuked' }
    });

    assert.equal(bad.statusCode, 400);

    const account = await app.inject({
      method: 'PATCH',
      url: `/api/v1/wallets/${DESTINATION}/status`,
      headers: HI,
      payload: { status: 'archived' }
    });

    assert.equal(account.statusCode, 200);
  } finally {
    await app.close();
  }
});
