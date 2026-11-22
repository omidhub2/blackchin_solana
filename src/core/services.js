/**
 * Composition root: wires repositories, security primitives and services.
 *
 * `createServices(deps)` is pure with respect to the environment: production
 * uses `getDefaultDependencies()` (PostgreSQL pool, env key provider, Solana
 * RPC); tests inject fakes.
 */
import { createEnvKeyProvider, createCipher } from '../infrastructure/security/hd-envelope.js';
import { resolveDependencies } from '../infrastructure/dependencies.js';
import * as depositScannerCursors from '../infrastructure/database/deposit-scanner.repository.js';
import { createHdWalletService } from './hd-wallet/hd-wallet.service.js';
import { createChildWalletService } from './wallets/child-wallet.service.js';
import { createTenantWalletService } from './tenant-wallets/tenant-wallet.service.js';
import { createBalanceService } from './balance/hd-balance.service.js';
import { createDepositService } from './deposits/deposit.service.js';
import { createDepositReconciliationService } from './deposits/deposit-reconciliation.service.js';
import { createWithdrawalService } from './withdrawals/withdrawal.service.js';
import { createTenantWithdrawalService } from './withdrawals/tenant-withdrawal.service.js';
import { createWithdrawalReconciliationService } from './withdrawals/withdrawal-reconciliation.service.js';
import { createTransactionService } from './transactions/transaction-history.service.js';
import { standaloneWalletService } from './wallet/standalone-wallet.service.js';
import {
  createDepositScanner,
  SCANNER_MAX_BATCH_DEFAULT,
  SCANNER_PAGE_SIZE_DEFAULT
} from './deposits/deposit-scanner.service.js';
import { resolveScanWallets } from './deposits/deposit-scanner-wallets.js';
export { resolveScanWallets } from './deposits/deposit-scanner-wallets.js';

/**
 * @param {object} [overrides] Dependency overrides (tests).
 */
export function createServices(overrides = {}) {
  const base = resolveDependencies(overrides);
  const keyProvider = overrides.keyProvider ?? createEnvKeyProvider();
  const cipher = overrides.cipher ?? createCipher(keyProvider);

  const deps = {
    ...base,
    cipher,
    keyProvider,
    cursors: overrides.cursors ?? depositScannerCursors
  };

  const hdWalletService = createHdWalletService(deps);
  const childWalletService = createChildWalletService(deps);

  const depositService = createDepositService(deps);
  const withdrawalReconciliation = createWithdrawalReconciliationService({
    db: deps.db,
    rpc: deps.rpc,
    network: deps.network,
    batchSize: deps.withdrawalReconciliationBatchSize ?? 100,
    log: deps.log ?? (() => {})
  });

  const depositReconciliation = createDepositReconciliationService({
    db: deps.db,
    deposits: depositService,
    network: deps.network,
    batchSize: deps.reconciliationBatchSize ?? 100,
    log: deps.log ?? (() => {})
  });

  const scanner = createDepositScanner({
    db: deps.db,
    rpc: deps.rpc,
    deposits: depositService,
    cursors: deps.cursors,
    resolveWallets: (scope, network) => resolveScanWallets(deps, scope, network),
    confirmationsRequired: deps.scannerConfirmations ?? 1,
    pageSize: deps.scannerPageSize ?? SCANNER_PAGE_SIZE_DEFAULT,
    maxBatch: deps.scannerMaxBatch ?? SCANNER_MAX_BATCH_DEFAULT,
    log: deps.log ?? (() => {})
  });

  return Object.freeze({
    deps,
    hdWallets: hdWalletService,
    childWallets: childWalletService,
    tenantWallets: createTenantWalletService(deps),
    tenantWithdrawals: createTenantWithdrawalService(deps),
    balances: createBalanceService(deps),
    deposits: depositService,
    withdrawals: createWithdrawalService(deps),
    withdrawalReconciliation,
    transactions: createTransactionService(deps),
    standaloneWallets: standaloneWalletService,
    depositScanner: scanner,
    depositReconciliation
  });
}
