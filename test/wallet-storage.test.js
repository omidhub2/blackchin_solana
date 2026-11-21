import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { Keypair } from '@solana/web3.js';

import {
  connectToPostgres,
  disconnectPostgres,
  getWalletCount,
  loadWallet,
  pool,
  saveWallet
} from '../PostgreSQL/walletStorage.js';

test('PostgreSQL wallet storage: encryption, recovery and duplicate protection', async (t) => {
  let publicKey;
  let savedWallet;
  let originalAuthTag;
  let walletIndex;

  try {
    // 1. Establish a real database connection.
    await connectToPostgres();
    await t.test('connects to PostgreSQL', async () => {
      const result = await pool.query('SELECT current_database() AS database');
      assert.equal(typeof result.rows[0].database, 'string');
      assert.ok(result.rows[0].database.length > 0);
    });

    // 2. Confirm that duplicate public keys are prevented by PostgreSQL.
    await t.test('has the unique public-key index', async () => {
      const result = await pool.query(
        `
          SELECT indexdef
          FROM pg_indexes
          WHERE schemaname = 'public'
            AND tablename = 'wallets'
            AND indexname = 'idx_wallets_public_key_unique'
        `
      );

      assert.equal(result.rowCount, 1, 'Unique index must exist');
      assert.match(result.rows[0].indexdef, /CREATE UNIQUE INDEX/i);
    });

    // 3. Generate an isolated test keypair.
    const keypair = Keypair.generate();
    publicKey = keypair.publicKey.toBase58();

    const privateKey = Buffer
      .from(keypair.secretKey)
      .toString('hex');

    await t.test('generates a valid Solana keypair', async () => {
      assert.equal(keypair.secretKey.length, 64);
      assert.match(publicKey, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    });

    // 4. Save through the production storage function.
    savedWallet = await saveWallet({
      publicKey,
      privateKey,
      mnemonic: null
    });

    await t.test('saves wallet metadata', async () => {
      assert.equal(savedWallet.publicKey, publicKey);
      assert.notEqual(savedWallet.id, undefined);
      assert.ok(savedWallet.createdAt);
    });

    // 5. Inspect the stored representation without printing secrets.
    const storedResult = await pool.query(
      `
        SELECT
          id,
          public_key,
          private_key_encrypted,
          private_key_iv,
          private_key_auth_tag,
          mnemonic_encrypted,
          mnemonic_iv,
          mnemonic_auth_tag,
          created_at
        FROM wallets
        WHERE public_key = $1
      `,
      [publicKey]
    );

    assert.equal(storedResult.rowCount, 1);
    const stored = storedResult.rows[0];
    originalAuthTag = stored.private_key_auth_tag;

    await t.test('stores private key as authenticated ciphertext', async () => {
      assert.notEqual(stored.private_key_encrypted, privateKey);
      assert.match(stored.private_key_encrypted, /^(?:[a-fA-F0-9]{2})+$/);
      assert.match(stored.private_key_iv, /^[a-fA-F0-9]{24}$/);
      assert.match(stored.private_key_auth_tag, /^[a-fA-F0-9]{32}$/);
      assert.equal(stored.mnemonic_encrypted, null);
      assert.equal(stored.mnemonic_iv, null);
      assert.equal(stored.mnemonic_auth_tag, null);
    });

    // 6. Resolve the wallet's current zero-based position for loadWallet().
    const positionResult = await pool.query(
      `
        SELECT COUNT(*)::integer AS position
        FROM wallets
        WHERE created_at < $1
           OR (created_at = $1 AND id < $2)
      `,
      [stored.created_at, stored.id]
    );

    walletIndex = positionResult.rows[0].position;

    const loadedWallet = await loadWallet(walletIndex);

    await t.test('decrypts and restores the original wallet', async () => {
      assert.ok(loadedWallet);
      assert.equal(loadedWallet.publicKey, publicKey);

      const recoveredSecret = Buffer.from(loadedWallet.privateKey, 'hex');

      assert.equal(recoveredSecret.length, 64);
      assert.equal(
        crypto.timingSafeEqual(recoveredSecret, keypair.secretKey),
        true
      );

      const recoveredKeypair = Keypair.fromSecretKey(recoveredSecret);
      assert.equal(recoveredKeypair.publicKey.toBase58(), publicKey);
    });

    // 7. Verify authenticated encryption rejects a modified tag.
    await pool.query(
      `
        UPDATE wallets
        SET private_key_auth_tag = $1
        WHERE public_key = $2
      `,
      ['00'.repeat(16), publicKey]
    );

    await t.test('rejects tampered ciphertext authentication tag', async () => {
      await assert.rejects(
        () => loadWallet(walletIndex),
        /Decryption failed|authentication failed/i
      );
    });

    // Restore the tag before running any further read checks.
    await pool.query(
      `
        UPDATE wallets
        SET private_key_auth_tag = $1
        WHERE public_key = $2
      `,
      [originalAuthTag, publicKey]
    );

    // 8. Verify duplicate insertion is rejected by the unique index.
    await t.test('rejects a duplicate public key', async () => {
      await assert.rejects(
        () => saveWallet({
          publicKey,
          privateKey,
          mnemonic: null
        }),
        (error) => {
          assert.equal(error.code, '23505');
          assert.equal(
            error.constraint,
            'idx_wallets_public_key_unique'
          );
          return true;
        }
      );
    });

    await t.test('wallet count query returns a non-negative integer', async () => {
      const count = await getWalletCount();
      assert.ok(Number.isSafeInteger(count));
      assert.ok(count >= 1);
    });
  } finally {
    // Remove only the unique wallet created by this test.
    if (publicKey) {
      await pool.query(
        'DELETE FROM wallets WHERE public_key = $1',
        [publicKey]
      );
    }

    await disconnectPostgres();
  }
});
