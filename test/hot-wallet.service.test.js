import test from 'node:test';
import assert from 'node:assert/strict';

import { createHotWalletService } from '../src/core/hot-wallets/hot-wallet.service.js';

function buildDb({ candidate = true, existing = null, status = 'active', maxSingle = '0' } = {}) {
  const calls = [];
  let wallet = existing;

  return {
    calls,
    async query(sql, params = []) {
      const text = String(sql);
      calls.push({ sql: text, params });

      if (text.includes('FROM wallet_accounts a') && text.includes('INNER JOIN hd_wallets h')) {
        if (!candidate) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            account_id: '55',
            public_key: params[1],
            network: 'devnet',
            account_status: 'active',
            hd_wallet_id: '9',
            parent_id: '9',
            parent_status: 'active',
            parent_network: 'devnet'
          }],
          rowCount: 1
        };
      }
      if (text.includes('FROM hot_wallets') && text.includes('WHERE tenant_id = $1 AND public_key = $2')) {
        return { rows: wallet ? [wallet] : [], rowCount: wallet ? 1 : 0 };
      }
      if (text.includes('INSERT INTO hot_wallets')) {
        wallet = {
          id: '3',
          tenant_id: params[0],
          hd_wallet_id: params[1],
          wallet_account_id: params[2],
          public_key: params[3],
          network: params[4],
          label: params[5],
          status: 'active',
          signing_enabled: true,
          max_single_lamports: params[6],
          freeze_reason: null,
          created_by: params[7],
          frozen_at: null,
          created_at: new Date(),
          updated_at: new Date()
        };
        return { rows: [wallet], rowCount: 1 };
      }
      if (text.includes('UPDATE hot_wallets')) {
        if (!wallet) return { rows: [], rowCount: 0 };
        wallet = {
          ...wallet,
          status: params[2],
          signing_enabled: params[3],
          freeze_reason: params[2] === 'frozen' ? params[4] : null
        };
        return { rows: [wallet], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    setMaxSingle(value) {
      if (wallet) wallet.max_single_lamports = value;
    },
    setStatus(value) {
      if (wallet) {
        wallet.status = value;
        wallet.signing_enabled = value === 'active';
      }
    },
    get wallet() {
      return wallet;
    },
    status,
    maxSingle
  };
}

test('hot wallet registration binds an active tenant HD child', async () => {
  const db = buildDb();
  const service = createHotWalletService({ db, network: 'devnet' });

  const wallet = await service.register({
    tenantId: 42,
    publicKey: 'So11111111111111111111111111111111111111112',
    label: 'payout',
    maxSingleLamports: '500000000'
  });

  assert.equal(wallet.tenantId, '42');
  assert.equal(wallet.publicKey, 'So11111111111111111111111111111111111111112');
  assert.equal(wallet.maxSingleLamports, '500000000');
  assert.equal(db.calls.some((call) => call.sql.includes('INSERT INTO hot_wallets')), true);
});

test('hot wallet registration fails closed for a wallet outside the tenant', async () => {
  const service = createHotWalletService({ db: buildDb({ candidate: false }), network: 'devnet' });
  await assert.rejects(
    () => service.register({ tenantId: 42, publicKey: 'So11111111111111111111111111111111111111112' }),
    (error) => error.code === 'WALLET_ACCOUNT_NOT_FOUND'
  );
});

test('hot wallet signing guard enforces freeze state and single-transfer ceiling', async () => {
  const db = buildDb({ existing: {
    id: '3', tenant_id: '42', hd_wallet_id: '9', wallet_account_id: '55',
    public_key: 'So11111111111111111111111111111111111111112', network: 'devnet',
    label: 'payout', status: 'active', signing_enabled: true,
    max_single_lamports: '1000', freeze_reason: null, created_by: null,
    frozen_at: null, created_at: new Date(), updated_at: new Date()
  } });
  const service = createHotWalletService({ db, network: 'devnet' });

  await assert.rejects(
    () => service.assertCanSpend({
      tenantId: 42,
      publicKey: 'So11111111111111111111111111111111111111112',
      amountLamports: '1001'
    }),
    (error) => error.code === 'HOT_WALLET_LIMIT_EXCEEDED'
  );

  const allowed = await service.assertCanSpend({
    tenantId: 42,
    publicKey: 'So11111111111111111111111111111111111111112',
    amountLamports: '1000'
  });
  assert.equal(allowed.hotWallet, true);

  db.setStatus('frozen');
  await assert.rejects(
    () => service.assertCanSpend({
      tenantId: 42,
      publicKey: 'So11111111111111111111111111111111111111112',
      amountLamports: '1'
    }),
    (error) => error.code === 'HOT_WALLET_NOT_ACTIVE'
  );
});

test('freezing a hot wallet requires a reason', async () => {
  const db = buildDb({ existing: {
    id: '3', tenant_id: '42', hd_wallet_id: '9', wallet_account_id: '55',
    public_key: 'So11111111111111111111111111111111111111112', network: 'devnet',
    label: 'payout', status: 'active', signing_enabled: true,
    max_single_lamports: '0', freeze_reason: null, created_by: null,
    frozen_at: null, created_at: new Date(), updated_at: new Date()
  } });
  const service = createHotWalletService({ db, network: 'devnet' });

  await assert.rejects(
    () => service.freeze(42, 'So11111111111111111111111111111111111111112', '  '),
    (error) => error.code === 'FREEZE_REASON_REQUIRED'
  );

  const frozen = await service.freeze(42, 'So11111111111111111111111111111111111111112', 'incident');
  assert.equal(frozen.status, 'frozen');
  assert.equal(frozen.signingEnabled, false);
});