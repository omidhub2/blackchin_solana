import test from 'node:test';
import assert from 'node:assert/strict';

import {
  extractIncomingTransfers,
  formatLamports,
  parseSolToLamports
} from '../Solana/solTransfer.js';

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
