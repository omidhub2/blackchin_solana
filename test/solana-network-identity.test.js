import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSolanaNetworkIdentity } from '../config/connection.js';

const DEVNET_GENESIS = 'GH7ome3EiwEr7tu9JuTh2dpYWBJK3z69Xm1ZE3MEE6JC';

test('Solana network identity accepts the expected genesis hash', async () => {
  const result = await assertSolanaNetworkIdentity({
    expectedGenesisHash: DEVNET_GENESIS,
    rpcConnection: { async getGenesisHash() { return DEVNET_GENESIS; } }
  });
  assert.equal(result.genesisHash, DEVNET_GENESIS);
  assert.equal(result.network, 'devnet');
});

test('Solana network identity fails closed when the RPC points to another cluster', async () => {
  await assert.rejects(
    assertSolanaNetworkIdentity({
      expectedGenesisHash: DEVNET_GENESIS,
      rpcConnection: { async getGenesisHash() { return '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d'; } }
    }),
    /Solana RPC cluster mismatch/
  );
});

test('Solana network identity requires an explicit expected genesis hash', async () => {
  await assert.rejects(
    assertSolanaNetworkIdentity({
      expectedGenesisHash: '',
      rpcConnection: { async getGenesisHash() { throw new Error('must not call RPC'); } }
    }),
    /SOLANA_EXPECTED_GENESIS_HASH must be configured/
  );
});
