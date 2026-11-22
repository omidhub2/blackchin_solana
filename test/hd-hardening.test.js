import test from 'node:test';
import assert from 'node:assert/strict';
import { Keypair } from '@solana/web3.js';

import { createHdWalletService } from '../src/core/hd-wallet/hd-wallet.service.js';
import { createPurposeTokenCodec } from '../src/infrastructure/security/purpose-token.js';
import {
  createCipher,
  createEnvKeyProvider
} from '../src/infrastructure/security/hd-envelope.js';
import { withSigningKey } from '../src/infrastructure/security/wallet-signer.js';
import { deriveSolanaAccount } from '../src/blockchain/solana/hd/derivation.js';
import { createFakePool } from './helpers/fake-pool.js';
import { MemoryHdDatabase } from './helpers/memory-hd-db.js';

const KEY = 'a9'.repeat(32);
const keyProvider = createEnvKeyProvider({ ENCRYPTION_KEY: KEY });
const cipher = createCipher(keyProvider);

const MNEMONIC =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon diesel';

const b64 = (value) => Buffer.from(value, 'utf8').toString('base64url');

/**
 * Minimal HD-wallet fake pool with recovery-token state.
 */
function buildRecoveryHarness({ clock } = {}) {
  const now = clock ?? (() => new Date());
  const pool = createFakePool();
  const rows = new Map();
  let nextId = 1;
  let failRedemption = false;
  let failTokenStore = false;

  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);

  pool.onQuery('INSERT INTO hd_wallets', (params) => {
    const id = String(nextId);
    nextId += 1;
    const row = {
      id,
      owner_id: params[0],
      label: params[1],
      network: params[2],
      derivation_scheme: params[3],
      derivation_path_template: params[4],
      mnemonic_encrypted: params[5],
      mnemonic_iv: params[6],
      mnemonic_auth_tag: params[7],
      encryption_key_version: params[8],
      next_account_index: 0,
      status: params[9],
      phrase_provisioned_at: null,
      recovery_token_hash: null,
      recovery_token_expires_at: null,
      created_at: now(),
      updated_at: now()
    };
    rows.set(id, row);
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET mnemonic_encrypted = $2', (params) => {
    const row = rows.get(String(params[0]));
    Object.assign(row, {
      mnemonic_encrypted: params[1],
      mnemonic_iv: params[2],
      mnemonic_auth_tag: params[3],
      encryption_key_version: params[4],
      status: 'active'
    });
    return { rows: [row], rowCount: 1 };
  });

  pool.onQuery('SET recovery_token_hash = $2,', (params) => {
    if (failTokenStore) {
      // Simulates a write that affects no row (e.g. a racing provisioning)
      // without throwing: the service must fail closed on its own.
      return { rows: [], rowCount: 0 };
    }

    const row = rows.get(String(params[0]));
    if (!row || row.phrase_provisioned_at) return { rows: [], rowCount: 0 };
    row.recovery_token_hash = params[1];
    row.recovery_token_expires_at = new Date(params[2]);
    return { rows: [{ id: row.id }], rowCount: 1 };
  });

  pool.onQuery('SET phrase_provisioned_at = NOW()', (params) => {
    if (failRedemption) {
      throw new Error('database write failed');
    }

    const [id, tokenHash] = params;
    const row = rows.get(String(id));

    if (!row || row.phrase_provisioned_at !== null) return { rows: [], rowCount: 0 };
    if (tokenHash !== undefined) {
      if (row.recovery_token_hash !== tokenHash) return { rows: [], rowCount: 0 };
      if (!row.recovery_token_expires_at || row.recovery_token_expires_at <= now()) {
        return { rows: [], rowCount: 0 };
      }
    }

    row.phrase_provisioned_at = now();
    row.recovery_token_hash = null;
    row.recovery_token_expires_at = null;
    return { rows: [{ id: row.id }], rowCount: 1 };
  });

  pool.onQuery('FROM hd_wallets', (params) => {
    const row = rows.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  const service = createHdWalletService({
    db: pool,
    cipher,
    keyProvider,
    network: 'devnet',
    now
  });

  return {
    service,
    rows,
    pool,
    failRedemption: (value = true) => {
      failRedemption = value;
    },
    // The token-hash UPDATE matches no row, without throwing.
    failTokenStore: (value = true) => {
      failTokenStore = value;
    }
  };
}

test('correct token redeems for the correct wallet only', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  assert.match(recovery.tokenId, /^[0-9a-f-]{36}$/);
  assert.ok(new Date(recovery.expiresAt).getTime() > Date.now());

  const redeemed = await h.service.consumeRecoveryPhrase({
    hdWalletId: wallet.id,
    token: recovery.token,
    confirm: true
  });

  assert.equal(redeemed.hdWalletId, wallet.id);
  assert.equal(redeemed.tokenId, recovery.tokenId);
  assert.equal(redeemed.wordCount, 24);
  assert.equal(typeof redeemed.mnemonic, 'string');
  assert.equal(redeemed.mnemonic.split(' ').length, 24);
});

test('a token for wallet A is rejected for wallet B and B stays redeemable', async () => {
  const h = buildRecoveryHarness();
  const a = await h.service.createHdWallet();
  const b = await h.service.createHdWallet();

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: b.wallet.id,
      token: a.recovery.token,
      confirm: true
    }),
    (error) => error.statusCode === 409 && error.code === 'INVALID_RECOVERY_TOKEN'
  );

  // B was not consumed by the failed attempt.
  const rowB = h.rows.get(b.wallet.id);
  assert.equal(rowB.phrase_provisioned_at, null);

  const result = await h.service.consumeRecoveryPhrase({
    hdWalletId: b.wallet.id,
    token: b.recovery.token,
    confirm: true
  });

  assert.equal(result.hdWalletId, b.wallet.id);
});

test('expired tokens are rejected using the server clock', async () => {
  let current = new Date('2026-03-01T10:00:00.000Z');
  const h = buildRecoveryHarness({ clock: () => current });
  const { wallet, recovery } = await h.service.createHdWallet();

  // Move the server clock past expiry; the token itself is untouched.
  current = new Date(new Date(recovery.expiresAt).getTime() + 1);

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: recovery.token,
      confirm: true
    }),
    (error) => error.code === 'INVALID_RECOVERY_TOKEN'
  );

  assert.equal(h.rows.get(wallet.id).phrase_provisioned_at, null);
});

test('expired tokens are also rejected by the database condition', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  // Simulate a token that decrypts correctly but is already expired in the DB.
  h.rows.get(wallet.id).recovery_token_expires_at = new Date(Date.now() - 1000);

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: recovery.token,
      confirm: true
    }),
    (error) => error.code === 'INVALID_RECOVERY_TOKEN'
  );
});

test('tampered tokens and wrong purposes are rejected', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  const raw = Buffer.from(recovery.token, 'base64url');
  raw[raw.length - 1] ^= 0xff;

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: raw.toString('base64url'),
      confirm: true
    }),
    (error) => error.code === 'INVALID_RECOVERY_TOKEN'
  );

  const codec = createPurposeTokenCodec(keyProvider);
  assert.throws(
    () => codec.open('root-mnemonic', recovery.token, { walletId: wallet.id }),
    /invalid/i
  );
});

test('a tampered clear-text binding does not authenticate', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  const raw = Buffer.from(recovery.token, 'base64url');
  const text = raw.toString('latin1');
  const altered = Buffer.from(
    text.replace(`"walletId":"${wallet.id}"`, '"walletId":"999"'),
    'latin1'
  );

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: altered.toString('base64url'),
      confirm: true
    }),
    (error) => error.code === 'INVALID_RECOVERY_TOKEN'
  );
});

test('token is invalidated after a successful redemption', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  await h.service.consumeRecoveryPhrase({
    hdWalletId: wallet.id,
    token: recovery.token,
    confirm: true
  });

  assert.equal(h.rows.get(wallet.id).recovery_token_hash, null);
  assert.equal(h.rows.get(wallet.id).recovery_token_expires_at, null);

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: recovery.token,
      confirm: true
    }),
    (error) => error.code === 'RECOVERY_PHRASE_ALREADY_PROVISIONED'
  );
});

test('two concurrent redemptions produce exactly one winner', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  const results = await Promise.allSettled([
    h.service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: true }),
    h.service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: true })
  ]);

  const fulfilled = results.filter((item) => item.status === 'fulfilled');
  const rejected = results.filter((item) => item.status === 'rejected');

  assert.equal(fulfilled.length, 1);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0].reason.code, 'INVALID_RECOVERY_TOKEN');
});

test('confirmation is mandatory and checked before redemption', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: false }),
    (error) => error.code === 'CONFIRMATION_REQUIRED'
  );

  assert.equal(h.rows.get(wallet.id).phrase_provisioned_at, null);
});

test('database failure during redemption leaves the token redeemable', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  h.failRedemption(true);

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({ hdWalletId: wallet.id, token: recovery.token, confirm: true }),
    /database write failed/
  );

  h.failRedemption(false);

  const result = await h.service.consumeRecoveryPhrase({
    hdWalletId: wallet.id,
    token: recovery.token,
    confirm: true
  });

  assert.equal(result.hdWalletId, wallet.id);
});

test('redemption errors never echo the supplied token', async () => {
  const h = buildRecoveryHarness();
  const { wallet } = await h.service.createHdWallet();

  const secretish = b64(`blackchin:recovery-phrase:v2|recovery-phrase|${wallet.id}`);
  let message = '';

  try {
    await h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: secretish,
      confirm: true
    });
  } catch (error) {
    message = `${error.message} ${error.code}`;
  }

  assert.match(message, /invalid, expired, or already used/i);
  assert.ok(!message.includes(secretish));
  assert.ok(!message.includes('blackchin:recovery-phrase'));
});

// ---------------------------------------------------------------------------
// Stage C: lifecycle enforcement
// ---------------------------------------------------------------------------

function signingHarness({ parentStatus = 'active', childStatus = 'active', childNetwork = 'devnet' } = {}) {
  const memory = new MemoryHdDatabase();
  const parent = memory.addHdWallet({ status: parentStatus });
  const sealed = cipher.encrypt(MNEMONIC, { aad: `hd_wallets:${parent.id}:mnemonic:v1` });

  Object.assign(parent, {
    mnemonic_encrypted: sealed.ciphertext,
    mnemonic_iv: sealed.iv,
    mnemonic_auth_tag: sealed.authTag
  });

  const expected = deriveSolanaAccount(MNEMONIC, 0);
  const account = memory.addAccount({
    hdWalletId: parent.id,
    publicKey: expected.publicKey,
    accountIndex: 0,
    status: childStatus,
    network: childNetwork
  });

  const pool = createFakePool();
  pool.onQuery('BEGIN', () => undefined);
  pool.onQuery('COMMIT', () => undefined);
  pool.onQuery('ROLLBACK', () => undefined);
  pool.onQuery('lock_timeout', () => undefined);
  pool.onQuery('FROM wallet_accounts WHERE public_key', (params) => {
    const row = memory.accountByPublicKey(params[0]);
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM hd_wallets', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM wallet_accounts\n      WHERE id = $1', (params) => {
    const row = memory.accounts.find((item) => String(item.id) === String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });
  pool.onQuery('FROM hd_wallets\n      WHERE id = $1', (params) => {
    const row = memory.hdWallets.get(String(params[0]));
    return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
  });

  return { pool, memory, parent, account };
}

test('active parent + active child signs', async () => {
  const h = signingHarness();
  const result = await withSigningKey(h.pool, h.account.public_key, async ({ wallet }) => wallet, {
    cipher,
    deploymentNetwork: 'devnet'
  });

  assert.equal(result.walletType, 'hd_child');
  assert.equal(result.parentStatus, 'active');
});

test('disabled parent blocks an otherwise active child', async () => {
  const h = signingHarness({ parentStatus: 'disabled' });

  await assert.rejects(
    () => withSigningKey(h.pool, h.account.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.statusCode === 409 && error.code === 'HD_WALLET_DISABLED'
  );
});

test('archived parent blocks an otherwise active child', async () => {
  const h = signingHarness({ parentStatus: 'archived' });

  await assert.rejects(
    () => withSigningKey(h.pool, h.account.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.code === 'HD_WALLET_ARCHIVED'
  );
});

test('unknown parent status denies signing', async () => {
  const h = signingHarness({ parentStatus: 'quarantined' });

  await assert.rejects(
    () => withSigningKey(h.pool, h.account.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.code === 'HD_WALLET_NOT_ACTIVE'
  );
});

test('disabled child is rejected', async () => {
  const h = signingHarness({ childStatus: 'disabled' });

  await assert.rejects(
    () => withSigningKey(h.pool, h.account.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.code === 'WALLET_NOT_ACTIVE'
  );
});

test('missing parent row is rejected', async () => {
  const h = signingHarness();

  // Build a child whose parent row does not exist.
  const orphan = h.memory.addAccount({
    hdWalletId: '999',
    publicKey: Keypair.generate().publicKey.toBase58(),
    accountIndex: 0
  });

  await assert.rejects(
    () => withSigningKey(h.pool, orphan.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.code === 'HD_WALLET_NOT_FOUND'
  );
});

test('network mismatch between parent/child and deployment is rejected', async () => {
  const mismatched = signingHarness({ childNetwork: 'devnet' });
  mismatched.memory.hdWallets.get(mismatched.parent.id).network = 'mainnet-beta';

  await assert.rejects(
    () => withSigningKey(mismatched.pool, mismatched.account.public_key, async () => 'signed', {
      cipher,
      deploymentNetwork: 'devnet'
    }),
    (error) => error.code === 'NETWORK_MISMATCH'
  );

  const wrongDeployment = signingHarness();

  await assert.rejects(
    () => withSigningKey(wrongDeployment.pool, wrongDeployment.account.public_key, async () => 'signed', {
      cipher,
      deploymentNetwork: 'testnet'
    }),
    (error) => error.code === 'NETWORK_MISMATCH'
  );
});

test('parent disabled while the withdrawal callback runs does not bypass the policy', async () => {
  const h = signingHarness();
  let keypairSeen = null;

  await withSigningKey(
    h.pool,
    h.account.public_key,
    async ({ keypair }) => {
      keypairSeen = keypair;

      // Parent is disabled during the callback (after authorization, before the
      // next signing attempt). The current keypair stays valid for this
      // operation; a *new* signing attempt must observe the new status.
      h.memory.hdWallets.get(h.parent.id).status = 'disabled';
    },
    { cipher, deploymentNetwork: 'devnet' }
  );

  assert.ok(keypairSeen);
  keypairSeen.secretKey.fill(0);

  await assert.rejects(
    () => withSigningKey(h.pool, h.account.public_key, async () => 'signed', { cipher, deploymentNetwork: 'devnet' }),
    (error) => error.code === 'HD_WALLET_DISABLED'
  );
});

test('concurrent disable and signing: the lock orders them deterministically', async () => {
  const h = signingHarness();

  // Simulate the row lock: disable waits for the signing transaction and the
  // signing either fully happens before it or not at all.
  let lock = Promise.resolve();
  const originalQuery = h.pool.query.bind(h.pool);

  h.pool.query = async (sql, params) => {
    const text = String(sql);

    if (text.includes('FOR SHARE')) {
      const previous = lock;
      let release;
      lock = new Promise((resolve) => {
        release = resolve;
      });
      await previous;

      try {
        return await originalQuery(sql, params);
      } finally {
        setImmediate(release);
      }
    }

    if (text.includes('SET status = $2')) {
      await lock;
    }

    return originalQuery(sql, params);
  };

  h.pool.onQuery('SET status = $2', (params) => {
    const row = h.memory.hdWallets.get(String(params[0]));
    if (!row) return { rows: [], rowCount: 0 };
    row.status = params[1];
    return { rows: [row], rowCount: 1 };
  });

  const disable = (async () => {
    await h.pool.query('UPDATE hd_wallets SET status = $2 WHERE id = $1', [h.parent.id, 'disabled']);
  })();

  const sign = withSigningKey(h.pool, h.account.public_key, async () => 'signed', {
    cipher,
    deploymentNetwork: 'devnet'
  });

  const [signResult] = await Promise.allSettled([sign, disable]);

  if (signResult.status === 'fulfilled') {
    assert.equal(signResult.value, 'signed');
  } else {
    assert.equal(signResult.reason.code, 'HD_WALLET_DISABLED');
  }

  assert.equal(h.memory.hdWallets.get(h.parent.id).status, 'disabled');
});

// ---------------------------------------------------------------------------
// Recovery-token persistence (fail closed)
// ---------------------------------------------------------------------------

const countCalls = (pool, pattern) =>
  pool.calls.filter((call) => call.sql.includes(pattern)).length;

test('a token is only returned after its hash and expiry are persisted', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  const row = h.rows.get(wallet.id);

  assert.equal(row.recovery_token_hash.length, 64);
  assert.match(row.recovery_token_hash, /^[a-f0-9]{64}$/);
  assert.ok(row.recovery_token_expires_at instanceof Date);
  assert.ok(row.recovery_token_expires_at > new Date());

  // The plaintext token itself is never written to the database.
  for (const call of h.pool.calls) {
    for (const param of call.params ?? []) {
      if (typeof param === 'string') {
        assert.notEqual(param, recovery.token, 'plaintext token must never be persisted');
      }
    }
  }

  assert.equal(countCalls(h.pool, 'COMMIT'), 1);
  assert.equal(countCalls(h.pool, 'ROLLBACK'), 0);
});

test('a token-persistence write affecting no row fails closed and rolls back', async () => {
  const h = buildRecoveryHarness();
  h.failTokenStore(true);

  await assert.rejects(
    () => h.service.createHdWallet(),
    (error) => {
      assert.equal(error.statusCode, 500);
      assert.equal(error.code, 'RECOVERY_TOKEN_PERSISTENCE_FAILED');
      return true;
    }
  );

  assert.equal(countCalls(h.pool, 'ROLLBACK'), 1);
  assert.equal(countCalls(h.pool, 'COMMIT'), 0);
  // The transaction was rolled back, so the root is not committed and no
  // token was returned. (The in-memory fake does not undo its own inserts.)
  assert.equal(countCalls(h.pool, 'SET recovery_token_hash = $2,'), 1);
});

test('a token-persistence error also rolls the transaction back', async () => {
  const h = buildRecoveryHarness();
  const original = h.pool.query.bind(h.pool);

  h.pool.query = async (sql, params) => {
    if (String(sql).includes('SET recovery_token_hash = $2,')) {
      throw new Error('deadlock detected');
    }

    return original(sql, params);
  };

  await assert.rejects(() => h.service.createHdWallet(), /deadlock detected/);
  assert.equal(countCalls(h.pool, 'ROLLBACK'), 1);
  assert.equal(countCalls(h.pool, 'COMMIT'), 0);
});

test('a root created successfully can be redeemed exactly once', async () => {
  const h = buildRecoveryHarness();
  const { wallet, recovery } = await h.service.createHdWallet();

  const first = await h.service.consumeRecoveryPhrase({
    hdWalletId: wallet.id,
    token: recovery.token,
    confirm: true
  });

  assert.equal(first.hdWalletId, wallet.id);
  assert.equal(first.wordCount, 24);

  const row = h.rows.get(wallet.id);
  assert.ok(row.phrase_provisioned_at);
  assert.equal(row.recovery_token_hash, null);
  assert.equal(row.recovery_token_expires_at, null);

  await assert.rejects(
    () => h.service.consumeRecoveryPhrase({
      hdWalletId: wallet.id,
      token: recovery.token,
      confirm: true
    }),
    (error) => error.code === 'RECOVERY_PHRASE_ALREADY_PROVISIONED'
  );
});
