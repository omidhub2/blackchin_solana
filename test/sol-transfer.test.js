import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractIncomingTransfers,
  formatLamports,
  parseSolToLamports,
  confirmWithBlockhashWindow,
  sendSolWithSigner
} from '../Solana/solTransfer.js';
import { Keypair } from '@solana/web3.js';

test('SOL amount conversion uses exact integer lamports', () => {
  assert.equal(parseSolToLamports('1').toString(), '1000000000');
  assert.equal(parseSolToLamports('0.1').toString(), '100000000');
  assert.equal(parseSolToLamports('0.000000001').toString(), '1');
  assert.equal(parseSolToLamports('12.345678901').toString(), '12345678901');
});

test('SOL amount conversion rejects unsafe or ambiguous input', () => {
  for (const invalid of [
    1,
    '0',
    '0.0000000001',
    '-1',
    '1e-3',
    '01.2',
    '1.',
    ' 1'
  ]) {
    assert.throws(() => parseSolToLamports(invalid));
  }
});

test('lamports are formatted without floating-point rounding', () => {
  assert.equal(formatLamports('1'), '0.000000001');
  assert.equal(formatLamports('1000000000'), '1');
  assert.equal(formatLamports('12345678901'), '12.345678901');
});

test('incoming SystemProgram transfers are extracted from parsed transactions', () => {
  const recipient = '11111111111111111111111111111111';
  const sender = 'Vote111111111111111111111111111111111111111';

  const parsedTransaction = {
    transaction: {
      message: {
        instructions: [
          {
            program: 'system',
            parsed: {
              type: 'transfer',
              info: {
                source: sender,
                destination: recipient,
                lamports: 250000000
              }
            }
          },
          {
            program: 'system',
            parsed: {
              type: 'transfer',
              info: {
                source: sender,
                destination: 'Stake11111111111111111111111111111111111111',
                lamports: 900000000
              }
            }
          }
        ]
      }
    },
    meta: {
      err: null,
      innerInstructions: [
        {
          index: 0,
          instructions: [
            {
              program: 'system',
              parsed: {
                type: 'transfer',
                info: {
                  source: sender,
                  destination: recipient,
                  lamports: 50000000
                }
              }
            }
          ]
        }
      ]
    }
  };

  const transfers = extractIncomingTransfers(
    parsedTransaction,
    recipient
  );

  assert.equal(transfers.length, 2);
  assert.equal(transfers[0].lamports, '250000000');
  assert.equal(transfers[0].amountSol, '0.25');
  assert.equal(transfers[1].lamports, '50000000');
  assert.equal(transfers[1].amountSol, '0.05');
});

test('failed or missing transaction metadata produces no incoming transfers', () => {
  const recipient = '11111111111111111111111111111111';

  assert.deepEqual(
    extractIncomingTransfers({ meta: { err: { InstructionError: [0, 'Custom'] } } }, recipient),
    []
  );

  assert.deepEqual(
    extractIncomingTransfers(null, recipient),
    []
  );
});

test('unparsed inner instructions do not crash transfer extraction', () => {
  const recipient = '11111111111111111111111111111111';
  const sender = 'Vote111111111111111111111111111111111111111';

  const transfers = extractIncomingTransfers(
    {
      transaction: {
        message: {
          instructions: [
            {
              program: 'system',
              parsed: {
                type: 'transfer',
                info: { source: sender, destination: recipient, lamports: 1000000000 }
              }
            }
          ]
        }
      },
      meta: {
        err: null,
        innerInstructions: [
          {
            index: 0,
            instructions: [
              { program: 'spl-token', parsed: null },
              { programId: 'ComputeBudget111111111111111111111111111111', stackHeight: 2 }
            ]
          }
        ]
      }
    },
    recipient
  );

  assert.equal(transfers.length, 1);
  assert.equal(transfers[0].amountSol, '1');
});


test('confirmation helper resolves successfully using the injected RPC connection', async () => {
  const rpcConnection = {
    async getBlockHeight() { return 100; },
    async confirmTransaction() {
      return { context: { slot: 321 }, value: { err: null } };
    }
  };
  const result = await confirmWithBlockhashWindow({
    signature: 'test-signature',
    latestBlockhash: { blockhash: Keypair.generate().publicKey.toBase58(), lastValidBlockHeight: 200 },
    commitmentLevel: 'confirmed',
    rpcConnection
  });
  assert.equal(result.context.slot, 321);
  assert.equal(result.value.err, null);
});

test('sendSolWithSigner persists the signed identity before broadcast and confirms it', async () => {
  const sender = Keypair.generate();
  const recipient = Keypair.generate().publicKey;
  const blockhash = Keypair.generate().publicKey.toBase58();
  const calls = [];
  let persistedSignature = null;
  const rpcConnection = {
    async getLatestBlockhash() {
      calls.push('blockhash');
      return { blockhash, lastValidBlockHeight: 500 };
    },
    async getFeeForMessage() {
      calls.push('fee');
      return 5000;
    },
    async getBalance() {
      calls.push('balance');
      return 10_000_000;
    },
    async sendRawTransaction() {
      calls.push('broadcast');
      assert.ok(persistedSignature, 'signature must be persisted before broadcast');
      return persistedSignature;
    },
    async getBlockHeight() {
      return 100;
    },
    async confirmTransaction() {
      calls.push('confirm');
      return { context: { slot: 777 }, value: { err: null } };
    }
  };

  const result = await sendSolWithSigner({
    fromPublicKey: sender.publicKey.toBase58(),
    toPublicKey: recipient.toBase58(),
    amountSol: '0.001',
    getKeypair: () => sender,
    rpcConnection,
    onSigned: async ({ signature }) => {
      calls.push('persist');
      persistedSignature = signature;
    }
  });

  assert.equal(result.sent, true);
  assert.equal(result.signature, persistedSignature);
  assert.equal(result.slot, 777);
  assert.ok(calls.indexOf('persist') < calls.indexOf('broadcast'));
  assert.ok(calls.indexOf('broadcast') < calls.indexOf('confirm'));
});
