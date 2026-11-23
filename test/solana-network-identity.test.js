import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSolanaNetworkIdentity, solanaNetwork } from '../config/connection.js';

const DEVNET_GENESIS = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';

test('Solana network identity accepts the expected genesis hash', async () => {
  const result = await assertSolanaNetworkIdentity({
    expectedGenesisHash: DEVNET_GENESIS,
    rpcConnection: { async getGenesisHash() { return DEVNET_GENESIS; } }
  });
  assert.equal(result.genesisHash, DEVNET_GENESIS);
  assert.equal(result.network, solanaNetwork);
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
