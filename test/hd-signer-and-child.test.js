import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import {
  withSigningKey,
  resolveWallet,
  requireWallet
} from '../src/infrastructure/security/wallet-signer.js';
import {
  createCipher,
  createEnvKeyProvider
} from '../src/infrastructure/security/hd-envelope.js';
import { deriveSolanaAccount } from '../src/blockchain/solana/hd/derivation.js';
import { createAccountsInTransaction, MAX_BATCH_SIZE } from '../src/core/wallets/child-wallet.service.js';
import { createFakePool } from './helpers/fake-pool.js';
import { MemoryHdDatabase } from './helpers/memory-hd-db.js';

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art';

const keyProvider = createEnvKeyProvider({ ENCRYPTION_KEY: 'c'.repeat(64) });
const cipher = createCipher(keyProvider);

function sealedMnemonic(hdWalletId) {
  return cipher.encrypt(MNEMONIC, { aad: `hd_wallets:${hdWalletId}:mnemonic:v1` });
}

/**
 * Fake pool that understands the queries used by the signer and the child
 * wallet service, backed by MemoryHdDatabase.
 */
function buildPool(memory) {
  const pool = createFakePool();

  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);
  pool.onQuery('lock_timeout', () => undefined);
  pool.onQuery('pg_advisory_xact_lock', () => undefined);

  pool.onQuery('SELECT public_key FROM wallets', (params) => {
    const row = memory.legacyWallets?.get(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  // Legacy wallet metadata lookup used by resolveWallet().
  pool.onQuery('FROM wallets', (params) => {
    const row = memory.legacyWallets?.get(params[0]);
    return {
      rows: row ? [{
        id: row.id,
        public_key: row.public_key,
        created_at: row.created_at
      }] : [],
      rowCount: row ? 1 : 0
    };
  });

  // Signing-path locks (SELECT ... FOR SHARE).
  pool.onQuery('FROM wallet_accounts\n      WHERE id = $1', (params) => {
    const row = memory.accounts.find((item) => String(item.id) === String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM hd_wallets\n      WHERE id = $1', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM wallet_accounts WHERE public_key', (params) => {
    const row = memory.accountByPublicKey(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('FROM hd_wallets', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  pool.onQuery('UPDATE hd_wallets\n      SET next_account_index = $2, updated_at = NOW()', (params) => {
    const row = memory.hdWallets.get(String(params[0]));

    if (!row) return { rows: [], rowCount: 0 };

    row.next_account_index = Number(params[1]);
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET next_account_index = $2', (params) => {
    const row = memory.hdWallets.get(String(params[0]));

    if (!row) return { rows: [], rowCount: 0 };

    row.next_account_index = Number(params[1]);
    return { rows: [{ next_account_index: row.next_account_index }], rowCount: 1 };
  });

  pool.onQuery('INSERT INTO wallet_accounts', (params) => {
    const [hdWalletIds, publicKeys, accountIndexes] = params;

    const rows = publicKeys.map((publicKey, index) =>
      memory.addAccount({
        hdWalletId: String(hdWalletIds[index]),
        publicKey,
        accountIndex: Number(accountIndexes[index])
      })
    );

    return { rows, rowCount: rows.length };
  });

  return pool;
}

test('signer derives the stored HD child key and zeroes it afterwards', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const sealed = sealedMnemonic(hdWallet.id);

  Object.assign(hdWallet, {
    mnemonic_encrypted: sealed.ciphertext,
    mnemonic_iv: sealed.iv,
    mnemonic_auth_tag: sealed.authTag
  });

  const expected = deriveSolanaAccount(MNEMONIC, 0);
  expected.secretKey.fill(0);

  const account = memory.addAccount({
    hdWalletId: hdWallet.id,
    publicKey: expected.publicKey,
    accountIndex: 0
  });

  const pool = buildPool(memory);
  let internalSecret;

  const result = await withSigningKey(
    pool,
    account.public_key,
    async ({ keypair, wallet }) => {
      assert.equal(wallet.walletType, 'hd_child');
      assert.equal(wallet.hdWalletId, hdWallet.id);
      assert.equal(wallet.derivationPath, "m/44'/501'/0'/0'");

      // web3.js returns a copy from `secretKey`; keep a copy of the real
      // internal buffer so zeroization can be asserted afterwards.
      internalSecret = keypair._keypair?.secretKey ?? null;

      return keypair.publicKey.toBase58();
    },
    { cipher }
  );

  assert.equal(result, expected.publicKey);
  assert.ok(internalSecret, 'expected an internal secret buffer');
  assert.equal(internalSecret.length, 64);
  assert.ok(internalSecret.every((byte) => byte === 0), 'secret key must be zeroed after signing');
});

test('signer refuses a child whose stored public key does not match derivation', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const sealed = sealedMnemonic(hdWallet.id);

  Object.assign(hdWallet, {
    mnemonic_encrypted: sealed.ciphertext,
    mnemonic_iv: sealed.iv,
    mnemonic_auth_tag: sealed.authTag
  });

  const wrongKey = Keypair.generate().publicKey.toBase58();
  const account = memory.addAccount({ hdWalletId: hdWallet.id, publicKey: wrongKey, accountIndex: 3 });

  await assert.rejects(
    () => withSigningKey(buildPool(memory), account.public_key, async () => 'signed', { cipher }),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'WALLET_KEY_INTEGRITY_ERROR');
      assert.doesNotMatch(error.message, /abandon|mnemonic/i);
      return true;
    }
  );
});

test('signer rejects inactive child wallets', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();

  const expected = deriveSolanaAccount(MNEMONIC, 1);
  expected.secretKey.fill(0);

  const account = memory.addAccount({
    hdWalletId: hdWallet.id,
    publicKey: expected.publicKey,
    accountIndex: 1,
    status: 'disabled'
  });

  await assert.rejects(
    () => withSigningKey(buildPool(memory), account.public_key, async () => 'signed', { cipher }),
    (error) => error.statusCode === 409 && error.code === 'WALLET_NOT_ACTIVE'
  );
});

test('resolveWallet reports unknown addresses as null and requireWallet as 404', async () => {
  const memory = new MemoryHdDatabase();
  const pool = buildPool(memory);
  const unknown = Keypair.generate().publicKey.toBase58();

  assert.equal(await resolveWallet(pool, unknown), null);
  await assert.rejects(() => requireWallet(pool, unknown), (error) => error.statusCode === 404);
});

test('child wallet creation allocates consecutive, non-duplicated indexes', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const pool = buildPool(memory);

  const first = await createAccountsInTransaction({ db: pool }, hdWallet.id, {
    count: 2,
    mnemonicResolver: async () => MNEMONIC
  });

  const second = await createAccountsInTransaction({ db: pool }, hdWallet.id, {
    count: 1,
    mnemonicResolver: async () => MNEMONIC
  });

  assert.deepEqual(first.accounts.map((item) => item.accountIndex), [0, 1]);
  assert.deepEqual(second.accounts.map((item) => item.accountIndex), [2]);
  assert.equal(second.nextAccountIndex, 3);

  const expected = [0, 1, 2].map((index) => deriveSolanaAccount(MNEMONIC, index).publicKey);

  assert.deepEqual(
    memory.accountsOf(hdWallet.id).map((item) => item.public_key),
    expected
  );

  assert.ok(pool.sqlCalls('pg_advisory_xact_lock').length >= 2);
  assert.ok(pool.sqlCalls('BEGIN').length >= 2);
  assert.equal(pool.released, pool.sqlCalls('BEGIN').length);
});

test('concurrent child creation never reuses an index', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();

  // Serialize the critical section the way a real row lock would.
  let lock = Promise.resolve();
  const pool = buildPool(memory);
  const acquire = pool.query.bind(pool);

  pool.query = async (sql, params) => {
    if (String(sql).includes('FOR UPDATE') || String(sql).includes('pg_advisory_xact_lock')) {
      const previous = lock;
      let release;
      lock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;

      try {
        return await acquire(sql, params);
      } finally {
        setImmediate(release);
      }
    }

    return acquire(sql, params);
  };

  const results = await Promise.all(
    Array.from({ length: 5 }, () =>
      createAccountsInTransaction({ db: pool }, hdWallet.id, {
        count: 1,
        mnemonicResolver: async () => MNEMONIC
      })
    )
  );

  const indexes = results.flatMap((result) => result.accounts.map((item) => item.accountIndex)).sort();

  assert.deepEqual(indexes, [0, 1, 2, 3, 4]);
  assert.equal(new Set(indexes).size, indexes.length);
});

test('a failed insert rolls back the reservation and rewinds the counter', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const pool = buildPool(memory);

  // Force a unique violation by pre-inserting the key that index 0 derives to.
  const collision = deriveSolanaAccount(MNEMONIC, 0).publicKey;
  memory.addAccount({ hdWalletId: '999', publicKey: collision, accountIndex: 0 });

  await assert.rejects(
    () =>
      createAccountsInTransaction({ db: pool }, hdWallet.id, {
        count: 1,
        mnemonicResolver: async () => MNEMONIC
      }),
    (error) => error.statusCode === 409 && error.code === 'DUPLICATE_PUBLIC_KEY'
  );

  assert.ok(pool.sqlCalls('ROLLBACK').length >= 1);
  assert.ok(pool.sqlCalls('SET next_account_index = $2').length >= 1, 'counter must be rewound');
  assert.equal(memory.hdWallets.get(hdWallet.id).next_account_index, 0);
});

test('batch size is validated', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet();
  const pool = buildPool(memory);

  for (const count of [0, -1, 1.5, MAX_BATCH_SIZE + 1, '2']) {
    await assert.rejects(
      () =>
        createAccountsInTransaction({ db: pool }, hdWallet.id, {
          count,
          mnemonicResolver: async () => MNEMONIC
        }),
      (error) => error.code === 'INVALID_BATCH_SIZE'
    );
  }
});

test('inactive HD roots cannot create accounts', async () => {
  const memory = new MemoryHdDatabase();
  const hdWallet = memory.addHdWallet({ status: 'disabled' });
  const pool = buildPool(memory);

  await assert.rejects(
    () =>
      createAccountsInTransaction({ db: pool }, hdWallet.id, {
        count: 1,
        mnemonicResolver: async () => MNEMONIC
      }),
    (error) => error.code === 'HD_WALLET_NOT_ACTIVE'
  );

  assert.equal(memory.accountsOf(hdWallet.id).length, 0);
});

test('unknown HD roots return 404 and release the client', async () => {
  const memory = new MemoryHdDatabase();
  const pool = buildPool(memory);

  await assert.rejects(
    () =>
      createAccountsInTransaction({ db: pool }, '424242', {
        count: 1,
        mnemonicResolver: async () => MNEMONIC
      }),
    (error) => error.statusCode === 404
  );

  assert.equal(pool.released, 1);
});
