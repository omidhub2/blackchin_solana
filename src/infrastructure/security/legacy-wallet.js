/**
 * Read access to standalone wallets created before the HD wallet feature.
 *
 * Kept in its own module so `wallet-signer.js` never depends on low-level SQL
 * and so the legacy code path is explicit and testable.
 */
import { Keypair } from '@solana/web3.js';

import { conflict } from '../../core/errors.js';
import { loadWalletByPublicKey } from '../../../PostgreSQL/walletStorage.js';

export async function findLegacyWalletByPublicKey(publicKey) {
  return loadWalletByPublicKey(publicKey);
}

/**
 * Convert the decrypted legacy hex secret key into a Keypair.
 * Throws a generic conflict on mismatch so key material never leaks.
 */
export function decryptLegacyPrivateKey(wallet) {
  if (!wallet || typeof wallet.privateKey !== 'string' || !/^[a-fA-F0-9]{128}$/.test(wallet.privateKey)) {
    throw conflict('Stored private key is invalid; the wallet cannot sign', 'WALLET_KEY_INVALID');
  }

  const secretKey = Buffer.from(wallet.privateKey, 'hex');

  // Avoid keeping the plaintext hex copy referenced on the wallet object.
  wallet.privateKey = '';
  wallet.mnemonic = null;

  try {
    const keypair = Keypair.fromSecretKey(Uint8Array.from(secretKey));

    if (keypair.publicKey.toBase58() !== wallet.publicKey) {
      secretKey.fill(0);
      keypair.secretKey.fill(0);
      throw conflict('Stored private key does not match the wallet address', 'WALLET_KEY_MISMATCH');
    }

    return keypair;
  } finally {
    secretKey.fill(0);
  }
}
