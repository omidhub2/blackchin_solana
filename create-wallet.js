import {
  connectToPostgres,
  disconnectPostgres
} from './PostgreSQL/walletStorage.js';

import { createAndSaveWallet } from './PostgreSQL/createWallet.js';

// ============================================================
// Create and persist one Solana wallet
// ============================================================

async function main() {
  let exitCode = 0;

  try {
    console.log('Connecting to PostgreSQL...');
    await connectToPostgres();

    console.log('\nGenerating and saving a new Solana wallet...');
    const wallet = await createAndSaveWallet();

    console.log('\n======================================');
    console.log(' WALLET CREATED SUCCESSFULLY');
    console.log('======================================');
    console.log('Wallet ID:', wallet.id);
    console.log('Public Key:', wallet.publicKey);
    console.log('Created At:', wallet.createdAt);
    console.log('\nThe private key was encrypted before database storage.');
    console.log('Only the public key is displayed. Keep your .env encryption key safe.');
  } catch (error) {
    exitCode = 1;

    console.error('\nWALLET CREATION FAILED');
    console.error('Code:', error.code ?? 'UNKNOWN');
    console.error('Message:', error.message);
  } finally {
    try {
      await disconnectPostgres();
    } catch (shutdownError) {
      exitCode = 1;
      console.error('Database shutdown failed:', shutdownError.message);
    }
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main();
