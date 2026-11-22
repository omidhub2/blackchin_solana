/**
 * HD wallet dependencies, resolvable from the environment.
 *
 * Everything the HD services need (pool, cipher, network, RPC functions) is
 * injected so unit tests can run without PostgreSQL or Solana RPC.
 */
import { connection, solanaNetwork, commitment as defaultCommitment } from '../../config/connection.js';
import { pool } from '../../PostgreSQL/walletStorage.js';
import * as solana from '../../Solana/solTransfer.js';
import { getDefaultCipher } from './security/hd-envelope.js';

/**
 * Solana RPC facade used by the HD services. Delegates to the existing
 * adapter implementation instead of duplicating chain logic.
 */
export const solanaRpc = Object.freeze({
  network: solanaNetwork,
  commitment: defaultCommitment,
  getBalance: (publicKey, commitment) => solana.getSolBalance(publicKey, commitment ?? defaultCommitment),
  estimateTransfer: (input) => solana.estimateSolTransfer(input),
  getSignatureStatuses: (signatures) =>
    connection.getSignatureStatuses(signatures, { searchTransactionHistory: true }),
  getParsedTransaction: (signature, commitment) =>
    connection.getParsedTransaction(signature, {
      commitment: commitment ?? defaultCommitment,
      maxSupportedTransactionVersion: 0
    }),
  sendSolWithSigner: (input) => solana.sendSolWithSigner(input),
  formatLamports: solana.formatLamports,
  parseSolToLamports: solana.parseSolToLamports,
  extractIncomingTransfers: solana.extractIncomingTransfers
});

let cachedDefaults;

/**
 * Lazily built production dependencies (creates no connection until used).
 */
export function getDefaultDependencies() {
  if (!cachedDefaults) {
    cachedDefaults = Object.freeze({
      db: pool,
      pool,
      cipher: getDefaultCipher(),
      rpc: solanaRpc,
      network: solanaNetwork,
      commitment: defaultCommitment,
      now: () => new Date()
    });
  }

  return cachedDefaults;
}

export function resolveDependencies(overrides = {}) {
  const deps = getDefaultDependencies();

  return {
    ...deps,
    ...overrides,
    rpc: overrides.rpc ?? deps.rpc
  };
}
