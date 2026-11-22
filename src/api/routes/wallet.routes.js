/**
 * Wallet routes (standalone wallets and HD child wallets).
 *
 * Responses keep the same shape as before the HD feature: standalone wallets
 * behave exactly as they did, HD children simply resolve to the same
 * endpoints through the unified signer.
 */
import { badRequest, notFound } from '../../core/errors.js';
import { getIncomingTransactions } from '../../core/transactions/receive.service.js';
import { getServices } from '../services-context.js';
import { requirePublicKey } from '../validation.js';

export async function walletRoutes(app) {
  const services = (request) => getServices(app, request);

  app.post('/api/v1/wallets', async (request, reply) => {
    const wallet = await services(request).standaloneWallets.createWallet();
    return reply.code(201).send(wallet);
  });

  app.get('/api/v1/wallets/:publicKey', async (request, reply) => {
    const publicKey = requirePublicKey(request.params.publicKey);

    const wallet = await services(request).standaloneWallets.getWallet(publicKey);

    if (wallet) {
      return wallet;
    }

    // HD child wallets are looked up in wallet_accounts instead.
    const account = await services(request).childWallets.getAccountByPublicKey(publicKey);

    if (!account) {
      return reply.code(404).send({ error: 'WALLET_NOT_FOUND' });
    }

    return account;
  });

  app.get('/api/v1/wallets/:publicKey/balance', async (request) => {
    const publicKey = requirePublicKey(request.params.publicKey);

    return services(request).balances.getWalletBalance(publicKey);
  });

  app.get('/api/v1/wallets/:publicKey/deposit-address', async (request) => {
    const publicKey = requirePublicKey(request.params.publicKey);

    return services(request).deposits.getDepositAddress(publicKey);
  });

  app.get('/api/v1/wallets/:publicKey/transactions', async (request, reply) => {
    const publicKey = requirePublicKey(request.params.publicKey);
    const rawLimit = Number(request.query.limit ?? 10);

    if (!Number.isSafeInteger(rawLimit) || rawLimit < 1 || rawLimit > 50) {
      return reply.code(400).send({
        error: 'INVALID_LIMIT',
        message: 'limit must be an integer between 1 and 50'
      });
    }

    return {
      items: await getIncomingTransactions(publicKey, rawLimit)
    };
  });

  /**
   * Native SOL deposit history (recorded, verified deposits).
   */
  app.get('/api/v1/wallets/:publicKey/deposits', async (request) => {
    const publicKey = requirePublicKey(request.params.publicKey);

    return services(request).transactions.listWalletTransactions(publicKey, {
      limit: request.query.limit,
      offset: request.query.offset,
      direction: 'deposit'
    });
  });

  /**
   * Native SOL withdrawal history for one wallet.
   */
  app.get('/api/v1/wallets/:publicKey/withdrawals', async (request) => {
    const publicKey = requirePublicKey(request.params.publicKey);

    return services(request).transactions.listWalletTransactions(publicKey, {
      limit: request.query.limit,
      offset: request.query.offset,
      direction: 'withdrawal'
    });
  });

  app.get('/api/v1/transfers/:signature', async (request, reply) => {
    const publicKey = request.query.publicKey;

    if (typeof publicKey !== 'string') {
      return reply.code(400).send({
        error: 'PUBLIC_KEY_REQUIRED',
        message: 'Provide the recipient publicKey query parameter'
      });
    }

    const signature = request.params.signature;

    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      throw badRequest('Invalid Solana transaction signature', 'INVALID_SIGNATURE');
    }

    return services(request).deposits.verifyIncoming(
      signature,
      requirePublicKey(publicKey)
    );
  });

  /**
   * Verify and persist an incoming deposit (idempotent per signature).
   */
  app.post('/api/v1/transfers/:signature/confirm', async (request, reply) => {
    const signature = request.params.signature;

    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      throw badRequest('Invalid Solana transaction signature', 'INVALID_SIGNATURE');
    }

    const body = request.body ?? {};
    const publicKey = requirePublicKey(body.publicKey, 'publicKey');

    const result = await services(request).deposits.recordDeposit(signature, publicKey);

    return reply.code(result.created ? 201 : 200).send({
      created: result.created,
      deposit: result.deposit
    });
  });

  app.get('/api/v1/deposits/:signature', async (request) => {
    const signature = request.params.signature;

    if (typeof signature !== 'string' || !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) {
      throw badRequest('Invalid Solana transaction signature', 'INVALID_SIGNATURE');
    }

    const publicKey = requirePublicKey(request.query.publicKey, 'publicKey');
    await services(request).deposits.refreshDeposit(signature, publicKey);

    const history = await services(request).transactions.listWalletTransactions(publicKey, {
      limit: 1,
      offset: 0,
      direction: 'deposit'
    });

    const deposit = history.items.find((item) => item.signature === signature);

    if (!deposit) {
      throw notFound('Deposit record was not found', 'DEPOSIT_NOT_FOUND');
    }

    return deposit;
  });
}
