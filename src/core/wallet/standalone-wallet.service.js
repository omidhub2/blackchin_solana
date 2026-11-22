/**
 * Standalone (legacy) wallet service.
 *
 * Unchanged behaviour: `Keypair.generate()` persisted with the existing
 * encrypted `wallets` table. Provides the metadata lookup used by the unified
 * API, which is also used for HD child wallets (different table).
 */
import { createAndSaveWallet } from '../../../PostgreSQL/createWallet.js';
import { findWalletMetadataByPublicKey } from '../../infrastructure/database/wallet.repository.js';

export const standaloneWalletService = Object.freeze({
  async createWallet() {
    return createAndSaveWallet();
  },

  async getWallet(publicKey) {
    return findWalletMetadataByPublicKey(publicKey);
  }
});
