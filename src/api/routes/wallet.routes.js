import {
  createWallet,
  getWallet
} from '../../core/wallet/wallet.service.js';
import { getWalletBalance } from '../../core/balance/balance.service.js';
import {
  getDepositAddress,
  getIncomingTransactions,
  verifyIncomingTransaction
} from '../../core/transactions/receive.service.js';

export async function walletRoutes(app) {
  app.post('/api/v1/wallets', async (_request, reply) => {
    const wallet = await createWallet();
    return reply.code(201).send(wallet);
  });

  app.get('/api/v1/wallets/:publicKey', async (request, reply) => {
    const wallet = await getWallet(request.params.publicKey);
    if (!wallet) {
      return reply.code(404).send({ error: 'WALLET_NOT_FOUND' });
    }
    return wallet;
  });

  app.get('/api/v1/wallets/:publicKey/balance', async (request, reply) => {
    return getWalletBalance(request.params.publicKey);
  });

  app.get('/api/v1/wallets/:publicKey/deposit-address', async (request, reply) => {
    return getDepositAddress(request.params.publicKey);
  });

  app.get('/api/v1/wallets/:publicKey/transactions', async (request, reply) => {
    const rawLimit = Number(request.query.limit ?? 10);
    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return reply.code(400).send({
        error: 'INVALID_LIMIT',
        message: 'limit must be an integer between 1 and 50'
      });
    }

    return {
      items: await getIncomingTransactions(request.params.publicKey, rawLimit)
    };
  });

  app.get('/api/v1/transfers/:signature', async (request, reply) => {
    const publicKey = request.query.publicKey;
    if (typeof publicKey !== 'string') {
      return reply.code(400).send({
        error: 'PUBLIC_KEY_REQUIRED',
        message: 'Provide the recipient publicKey query parameter'
      });
    }

    return verifyIncomingTransaction(request.params.signature, publicKey);
  });
}
