import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveScanWallets } from '../src/core/deposits/deposit-scanner-wallets.js';

test('all scan scope combines active HD children and legacy standalone wallets without duplicates', async () => {
  const queries = [];
  const db = {
    async query(sql, values) {
      queries.push({ sql, values });

      if (sql.includes('FROM wallet_accounts AS account')) {
        return {
          rows: [
            { public_key: 'shared-address', hd_wallet_id: '7' },
            { public_key: 'hd-only-address', hd_wallet_id: '7' }
          ]
        };
      }

      if (sql.includes('FROM wallets')) {
        return {
          rows: [
            { public_key: 'legacy-only-address' },
            { public_key: 'shared-address' }
          ]
        };
      }

      throw new Error('Unexpected query');
    }
  };

  const wallets = await resolveScanWallets({ db }, 'all', 'devnet');

  assert.deepEqual(wallets, [
    { publicKey: 'legacy-only-address', hdWalletId: null },
    { publicKey: 'shared-address', hdWalletId: '7' },
    { publicKey: 'hd-only-address', hdWalletId: '7' }
  ]);
  assert.equal(queries.length, 2);
  assert.deepEqual(queries[0].values, ['devnet', 5_000, null]);
  assert.match(queries[0].sql, /root\.status = 'active'/);
  assert.match(queries[0].sql, /account\.status = 'active'/);
});

test('HD-only scan scope does not include legacy standalone wallets', async () => {
  const calls = [];
  const db = {
    async query(sql, values) {
      calls.push({ sql, values });
      return { rows: [{ public_key: 'hd-only-address', hd_wallet_id: '42' }] };
    }
  };

  const wallets = await resolveScanWallets({ db }, 'hd:42', 'mainnet-beta');

  assert.deepEqual(wallets, [
    { publicKey: 'hd-only-address', hdWalletId: '42' }
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].values, ['mainnet-beta', 5_000, '42']);
  assert.match(calls[0].sql, /root\.status = 'active'/);
});
