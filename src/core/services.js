/**
 * Composition root: wires repositories, security primitives and services.
 *
 * `createServices(deps)` is pure with respect to the environment: production
 * uses `getDefaultDependencies()` (PostgreSQL pool, env key provider, Solana
 * RPC); tests inject fakes.
 */
import { createEnvKeyProvider, createCipher } from '../infrastructure/security/hd-envelope.js';
import { resolveDependencies } from '../infrastructure/dependencies.js';
import { createHdWalletService } from './hd-wallet/hd-wallet.service.js';
import { createChildWalletService } from './wallets/child-wallet.service.js';
import { createBalanceService } from './balance/hd-balance.service.js';
import { createDepositService } from './deposits/deposit.service.js';
import { createWithdrawalService } from './withdrawals/withdrawal.service.js';
import { createTransactionService } from './transactions/transaction-history.service.js';
import { standaloneWalletService } from './wallet/standalone-wallet.service.js';

/**
 * @param {object} [overrides] Dependency overrides (tests).
 */
export function createServices(overrides = {}) {
  const base = resolveDependencies(overrides);
  const keyProvider = overrides.keyProvider ?? createEnvKeyProvider();
  const cipher = overrides.cipher ?? createCipher(keyProvider);

  const deps = { ...base, cipher, keyProvider };

  const hdWalletService = createHdWalletService(deps);
  const childWalletService = createChildWalletService(deps);

  return Object.freeze({
    deps,
    hdWallets: hdWalletService,
    childWallets: childWalletService,
    balances: createBalanceService(deps),
    deposits: createDepositService(deps),
    withdrawals: createWithdrawalService(deps),
    transactions: createTransactionService(deps),
    standaloneWallets: standaloneWalletService
  });
}
