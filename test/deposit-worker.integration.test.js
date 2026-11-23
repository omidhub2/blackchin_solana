import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import pg from 'pg';
import { Keypair } from '@solana/web3.js';

import { createDepositService } from '../src/core/deposits/deposit.service.js';

const enabled = Boolean(process.env.DATABASE_URL && process.env.DEPOSIT_WORKER_DATABASE_URL);
const source = Keypair.generate().publicKey.toBase58();
const lamports = '42000';

async function createLegacyWallet(admin, publicKey) {
  await admin.query(
    `INSERT INTO wallets (
       public_key, private_key_encrypted, private_key_iv, private_key_auth_tag
     ) VALUES ($1, 'test-ciphertext', 'test-iv', 'test-tag')`,
    [publicKey]
  );
}

function depositInput(publicKey, signature) {
  return {
    signature,
    publicKey,
    tenantId: null,
    hdWalletId: null,
    from: source,
    lamports,
    transfers: [{ from: source, to: publicKey, lamports }],
    commitment: 'finalized',
    confirmations: null,
    confirmationStatus: 'finalized',
    status: 'credited',
    slot: 123
  };
}

test('restricted deposit worker atomically persists ledger, webhook and operational event; duplicate replay emits no duplicate event', {
  skip: !enabled && 'requires DATABASE_URL and DEPOSIT_WORKER_DATABASE_URL'
}, async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const workerPool = new pg.Pool({ connectionString: process.env.DEPOSIT_WORKER_DATABASE_URL });
  const publicKey = Keypair.generate().publicKey.toBase58();
  const signature = '5'.repeat(88);

  try {
    await createLegacyWallet(admin, publicKey);
    const service = createDepositService({
      db: workerPool,
      rpc: {},
      network: 'devnet',
      commitment: 'confirmed'
    });

    const first = await service.recordVerifiedDeposit(depositInput(publicKey, signature));
    assert.equal(first.created, true);

    const replay = await service.recordVerifiedDeposit(depositInput(publicKey, signature));
    assert.equal(replay.created, false);

    const ledger = await admin.query(
      `SELECT COUNT(*)::int AS count FROM blockchain_transactions
        WHERE signature = $1 AND wallet_public_key = $2 AND direction = 'deposit'`,
      [signature, publicKey]
    );
    const outbox = await admin.query(
      `SELECT COUNT(*)::int AS count FROM webhook_outbox
        WHERE wallet_public_key = $1 AND event_type = 'deposit.confirmed'`,
      [publicKey]
    );
    const operational = await admin.query(
      `SELECT COUNT(*)::int AS count FROM operational_events
        WHERE wallet_public_key = $1 AND event_type = 'deposit.confirmed'`,
      [publicKey]
    );

    assert.equal(ledger.rows[0].count, 1);
    assert.equal(outbox.rows[0].count, 1);
    assert.equal(operational.rows[0].count, 1);
  } finally {
    await workerPool.end();
    await admin.end();
  }
});

test('failed webhook outbox insert rolls back the deposit ledger row', {
  skip: !enabled && 'requires DATABASE_URL and DEPOSIT_WORKER_DATABASE_URL'
}, async () => {
  const admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  const workerPool = new pg.Pool({ connectionString: process.env.DEPOSIT_WORKER_DATABASE_URL });
  const publicKey = Keypair.generate().publicKey.toBase58();
  const signature = '6'.repeat(88);

  try {
    await createLegacyWallet(admin, publicKey);
    const failingPool = {
      query: (...args) => workerPool.query(...args),
      async connect() {
        const client = await workerPool.connect();
        return {
          query(sql, params) {
            if (String(sql).includes('INSERT INTO webhook_outbox')) {
              const error = new Error('simulated outbox write failure');
              error.code = 'TEST_OUTBOX_FAILURE';
              throw error;
            }
            return client.query(sql, params);
          },
          release: (...args) => client.release(...args)
        };
      }
    };
    const service = createDepositService({
      db: failingPool,
      rpc: {},
      network: 'devnet',
      commitment: 'confirmed'
    });

    await assert.rejects(
      () => service.recordVerifiedDeposit(depositInput(publicKey, signature)),
      (error) => error.code === 'TEST_OUTBOX_FAILURE'
    );

    const ledger = await admin.query(
      `SELECT COUNT(*)::int AS count FROM blockchain_transactions
        WHERE signature = $1 AND wallet_public_key = $2 AND direction = 'deposit'`,
      [signature, publicKey]
    );
    const outbox = await admin.query(
      `SELECT COUNT(*)::int AS count FROM webhook_outbox
        WHERE wallet_public_key = $1 AND event_type = 'deposit.confirmed'`,
      [publicKey]
    );

    assert.equal(ledger.rows[0].count, 0);
    assert.equal(outbox.rows[0].count, 0);
  } finally {
    await workerPool.end();
    await admin.end();
  }
});
