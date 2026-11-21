import {
  connectToPostgres,
  disconnectPostgres
} from './PostgreSQL/walletStorage.js';

import {
  getDepositAddress,
  getRecentIncomingTransfers,
  getSolBalance
} from './Solana/solTransfer.js';

async function main() {
  const [publicKey] = process.argv.slice(2);

  if (!publicKey) {
    throw new Error(
      'Usage: node receive-sol.js <WALLET_PUBLIC_KEY>'
    );
  }

  let connected = false;

  try {
    await connectToPostgres();
    connected = true;

    const deposit = await getDepositAddress(publicKey);
    const balance = await getSolBalance(publicKey);
    const transfers = await getRecentIncomingTransfers(publicKey, {
      limit: 10
    });

    console.log('\n======================================');
    console.log('         SOLANA RECEIVE');
    console.log('======================================');
    console.log('Network:', deposit.network);
    console.log('Deposit address:', deposit.publicKey);
    console.log('Balance:', balance.sol, 'SOL');
    console.log('Commitment:', balance.commitment);

    console.log('\nRecent incoming SOL transfers:');

    if (transfers.length === 0) {
      console.log('No recent incoming native SOL transfers found.');
    } else {
      for (const transfer of transfers) {
        console.log({
          from: transfer.from,
          amount: transfer.amountSol,
          signature: transfer.signature,
          slot: transfer.slot,
          confirmationStatus: transfer.confirmationStatus
        });
      }
    }
  } finally {
    if (connected) {
      await disconnectPostgres();
    }
  }
}

main().catch((error) => {
  console.error('[SOL RECEIVE ERROR]', error.message);
  process.exitCode = 1;
});
