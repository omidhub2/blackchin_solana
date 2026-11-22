import test from 'node:test';
import assert from 'node:assert/strict';

import { createDepositScanner } from '../src/core/deposits/deposit-scanner.service.js';

test('scanner keeps independent cursors per address and refreshes known deposits', async () => {
  const addressA = '11111111111111111111111111111111';
  const addressB = 'So11111111111111111111111111111111111111112';
  const initialCursors = new Map([
    [`address:${addressA}`, 'old-signature-A'],
    [`address:${addressB}`, 'old-signature-B']
  ]);
  const ensuredScopes = [];
  const pageCalls = [];
  const refreshed = [];
  const recorded = [];
  const advanced = [];

  const cursors = {
    async ensureCursor(_db, { network, scope }) {
      ensuredScopes.push(scope);
      return {
        id: scope,
        network,
        scope,
        lastSignature: initialCursors.get(scope) ?? null,
        lastSlot: null
      };
    },
    async markCursorRunning() {},
    async advanceCursor(_db, id, position) {
      advanced.push({ id, ...position });
      return {
        lastSignature: position.lastSignature,
        lastSlot: position.lastSlot
      };
    },
    async markCursorError(_db, id, message) {
      throw new Error(`Unexpected cursor error for ${id}: ${message}`);
    }
  };

  const deposits = {
    async isRecorded(signature) {
      return signature === 'known-deposit-A';
    },
    async refreshDeposit(signature, publicKey) {
      refreshed.push({ signature, publicKey });
    },
    async recordVerifiedDeposit(input) {
      recorded.push(input);
      return { created: true };
    }
  };

  const rpc = {
    network: 'devnet',
    commitment: 'confirmed',
    async getRecentSignatures(address, options) {
      pageCalls.push({ address, options });
      return [{
        signature: address === addressA ? 'known-deposit-A' : 'new-deposit-B',
        slot: address === addressA ? 10 : 20,
        blockTime: 1_800_000_000
      }];
    },
    async getParsedTransaction(signature) {
      return {
        slot: 20,
        blockTime: 1_800_000_000,
        meta: { err: null },
        signature
      };
    },
    async getSignatureStatuses() {
      return { value: [{ confirmationStatus: 'finalized', err: null }] };
    },
    extractIncomingTransfers() {
      return [{
        from: '11111111111111111111111111111111',
        to: addressB,
        lamports: '250000000'
      }];
    }
  };

  const scanner = createDepositScanner({
    db: {},
    rpc,
    deposits,
    cursors,
    resolveWallets: async () => [
      { publicKey: addressA, hdWalletId: '1' },
      { publicKey: addressB, hdWalletId: '2' }
    ],
    pageSize: 10,
    maxBatch: 20
  });

  const summary = await scanner.scan({ network: 'devnet', scope: 'all' });

  assert.deepEqual(ensuredScopes, [
    `address:${addressA}`,
    `address:${addressB}`
  ]);
  assert.deepEqual(pageCalls.map((call) => call.options.until), [
    'old-signature-A',
    'old-signature-B'
  ]);
  assert.deepEqual(refreshed, [{
    signature: 'known-deposit-A',
    publicKey: addressA
  }]);
  assert.equal(recorded.length, 1);
  assert.equal(recorded[0].signature, 'new-deposit-B');
  assert.equal(recorded[0].publicKey, addressB);
  assert.deepEqual(advanced.map((item) => item.id), [
    `address:${addressA}`,
    `address:${addressB}`
  ]);
  assert.deepEqual(advanced.map((item) => item.lastSignature), [
    'known-deposit-A',
    'new-deposit-B'
  ]);
  assert.equal(summary.wallets, 2);
  assert.equal(summary.recorded, 1);
  assert.equal(summary.duplicates, 1);
  assert.equal(summary.cursors.length, 2);
});
