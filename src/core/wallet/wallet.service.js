import { createAndSaveWallet } from '../../../PostgreSQL/createWallet.js';
import { findWalletMetadataByPublicKey } from '../../infrastructure/database/wallet.repository.js';

export async function createWallet() {
  return createAndSaveWallet();
}

export async function getWallet(publicKey) {
  return findWalletMetadataByPublicKey(publicKey);
}
