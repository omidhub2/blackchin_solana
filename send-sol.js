import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  connectToPostgres,
  disconnectPostgres
} from './PostgreSQL/walletStorage.js';

import { sendSol } from './Solana/solTransfer.js';

async function main() {
  const [fromPublicKey, toPublicKey, amountSol] = process.argv.slice(2);

  if (!fromPublicKey || !toPublicKey || !amountSol) {
    throw new Error(
      'Usage: node send-sol.js <FROM_PUBLIC_KEY> <TO_PUBLIC_KEY> <AMOUNT_SOL>'
    );
  }

  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Sending SOL requires an interactive terminal for explicit confirmation'
    );
  }

  let connected = false;

  try {
    await connectToPostgres();
    connected = true;

    const result = await sendSol({
      fromPublicKey,
      toPublicKey,
      amountSol,
      confirm: async (preview) => {
        console.log('\n======================================');
        console.log('       SOL TRANSFER REVIEW');
        console.log('======================================');
        console.log('Network:', preview.network);
        console.log('From:', preview.from);
        console.log('To:', preview.to);
        console.log('Amount:', preview.amountSol, 'SOL');
        console.log('Estimated fee:', preview.estimatedFeeSol, 'SOL');
        console.log(
          'Estimated total:',
          (
            BigInt(preview.amountLamports) +
            BigInt(preview.estimatedFeeLamports)
          ).toString(),
          'lamports'
        );
        console.log('Available balance:', preview.availableLamports, 'lamports');

        const readline = createInterface({ input: stdin, output: stdout });

        try {
          const answer = await readline.question(
            '\nTo authorize and broadcast this transaction, type exactly SEND SOL: '
          );

          return answer === 'SEND SOL';
        } finally {
          readline.close();
        }
      }
    });

    if (result.cancelled) {
      console.log('\nTransfer cancelled. No transaction was submitted.');
      return;
    }

    console.log('\n======================================');
    console.log('       SOL TRANSFER SUBMITTED');
    console.log('======================================');
    console.log('Signature:', result.signature);
    console.log('From:', result.from);
    console.log('To:', result.to);
    console.log('Amount:', result.amountSol, 'SOL');
    console.log('Fee:', result.feeSol, 'SOL');
    console.log('Slot:', result.slot);
    console.log('Confirmation:', result.confirmationStatus);
    console.log('Network:', result.network);
  } finally {
    if (connected) {
      await disconnectPostgres();
    }
  }
}

main().catch((error) => {
  console.error('[SOL SEND ERROR]', {
    message: error.message,
    signature: error.signature ?? undefined
  });

  process.exitCode = 1;
});
