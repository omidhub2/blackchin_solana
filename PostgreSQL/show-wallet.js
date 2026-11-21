import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import {
  connectToPostgres,
  disconnectPostgres,
  loadWallet,
  loadWalletByPublicKey
} from './walletStorage.js';

// ============================================================
// Sensitive wallet inspection utility
// ============================================================

function parseTarget(args) {
  if (args.length === 0) {
    return { type: 'index', value: 0 };
  }

  if (args.length > 1) {
    throw new Error(
      'Usage: node PostgreSQL/show-wallet.js <PUBLIC_KEY> OR --index=<number>'
    );
  }

  const [argument] = args;

  if (argument.startsWith('--index=')) {
    const rawValue = argument.slice('--index='.length);

    if (!/^\d+$/.test(rawValue)) {
      throw new Error('Invalid --index value. Use a non-negative integer.');
    }

    const index = Number(rawValue);

    if (!Number.isSafeInteger(index)) {
      throw new Error('--index exceeds the JavaScript safe integer range.');
    }

    return { type: 'index', value: index };
  }

  return { type: 'publicKey', value: argument };
}

async function confirmPrivateKeyReveal() {
  if (!stdin.isTTY || !stdout.isTTY) {
    throw new Error(
      'Private-key reveal requires an interactive terminal. Run this command directly in a terminal.'
    );
  }

  const readline = createInterface({ input: stdin, output: stdout });

  try {
    console.warn('\nSECURITY WARNING');
    console.warn(
      'The private key controls the funds in this wallet. Anyone who sees it can take those funds.'
    );
    console.warn(
      'Do not share terminal output, screenshots, recordings, or logs.'
    );

    const answer = await readline.question(
      '\nType exactly SHOW PRIVATE KEY to reveal the decrypted private key: '
    );

    return answer === 'SHOW PRIVATE KEY';
  } finally {
    readline.close();
  }
}

async function main() {
  let connected = false;
  let exitCode = 0;

  try {
    const target = parseTarget(process.argv.slice(2));

    console.log('Connecting to PostgreSQL...');
    await connectToPostgres();
    connected = true;

    console.log('\nLoading wallet from encrypted storage...');

    const wallet = target.type === 'publicKey'
      ? await loadWalletByPublicKey(target.value)
      : await loadWallet(target.value);

    if (!wallet) {
      console.log(
        target.type === 'publicKey'
          ? 'No wallet found for the supplied public key.'
          : `No wallet found at index ${target.value}.`
      );
      return;
    }

    console.log('\n======================================');
    console.log('          SOLANA WALLET');
    console.log('======================================');
    console.log('Wallet ID:', wallet.id);
    console.log('Public Key:', wallet.publicKey);
    console.log('Created At:', wallet.createdAt);

    const confirmed = await confirmPrivateKeyReveal();

    if (!confirmed) {
      console.log('\nPrivate key was NOT displayed.');
      return;
    }

    console.log('\nPRIVATE KEY (HEX) — HANDLE AS A SECRET:');
    console.log(wallet.privateKey);
    console.log('\nPrivate key was decrypted and validated locally.');
    console.log('Never paste it into chat, websites, issue trackers, or GitHub.');
  } catch (error) {
    exitCode = 1;
    console.error('\n[SHOW WALLET ERROR]', error.message);
  } finally {
    if (connected) {
      try {
        await disconnectPostgres();
      } catch (error) {
        exitCode = 1;
        console.error('[DATABASE SHUTDOWN ERROR]', error.message);
      }
    }
  }

  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main();
