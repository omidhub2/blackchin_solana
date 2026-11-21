import { Keypair } from '@solana/web3.js';
import { saveWallet } from './walletStorage.js';

// ============================================================
// Wallet creation
// ============================================================

/**
 * Generate a new Solana keypair and persist it using the encrypted
 * PostgreSQL wallet storage module.
 *
 * The private key is passed only to saveWallet(), where it is validated
 * and encrypted before being written to PostgreSQL. It is never logged
 * or returned from this function.
 *
 * @returns {Promise<{
 *   id: string | number,
 *   publicKey: string,
 *   createdAt: Date | string
 * }>}
 */
export async function createAndSaveWallet() {
  console.log('[WALLET] Generating a new Solana keypair...');

  try {
    // Await works with the standard synchronous web3.js API as well as
    // compatible implementations that return a Promise.
    const keypair = await Keypair.generate();

    if (
      !keypair ||
      !keypair.publicKey ||
      !(keypair.secretKey instanceof Uint8Array)
    ) {
      throw new Error('Solana SDK returned an invalid keypair');
    }

    if (keypair.secretKey.length !== 64) {
      throw new Error('Generated Solana secret key must be exactly 64 bytes');
    }

    const publicKey = keypair.publicKey.toBase58();
    const privateKey = Buffer.from(keypair.secretKey).toString('hex');

    // Independently reconstruct the keypair and verify that the generated
    // secret key corresponds to the public key before persisting it.
    const reconstructedKeypair = await Keypair.fromSecretKey(
      Uint8Array.from(keypair.secretKey)
    );

    if (
      !reconstructedKeypair?.publicKey ||
      reconstructedKeypair.publicKey.toBase58() !== publicKey
    ) {
      throw new Error('Generated Solana keypair failed consistency validation');
    }

    console.log('[WALLET] Keypair generated and validated', {
      publicKey
    });

    const savedWallet = await saveWallet({
      publicKey,
      privateKey,
      mnemonic: null
    });

    if (
      !savedWallet ||
      savedWallet.publicKey !== publicKey ||
      savedWallet.id === undefined ||
      savedWallet.id === null
    ) {
      throw new Error('Wallet storage returned an invalid save result');
    }

    console.log('[WALLET] Wallet securely saved to PostgreSQL', {
      walletId: savedWallet.id,
      publicKey: savedWallet.publicKey
    });

    return {
      id: savedWallet.id,
      publicKey: savedWallet.publicKey,
      createdAt: savedWallet.createdAt
    };
  } catch (error) {
    // Do not log the keypair, secretKey, privateKey, or mnemonic.
    console.error('[WALLET CREATION FAILED]', {
      name: error.name,
      code: error.code ?? 'UNKNOWN',
      message: error.message
    });

    throw error;
  }
}
