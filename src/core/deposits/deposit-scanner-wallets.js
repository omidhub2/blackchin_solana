/**
 * Resolve addresses watched by the native SOL deposit scanner.
 */
import {
  listActiveWatchedWallets,
  listStandaloneWatchedWallets
} from '../../infrastructure/database/wallet-account.repository.js';

/**
 * Scopes: `all` (active HD children plus legacy standalone wallets) and `hd:<id>`.
 */
export async function resolveScanWallets(deps, scope, network) {
  if (scope === 'all') {
    const [hdWallets, standaloneWallets] = await Promise.all([
      listActiveWatchedWallets(deps.db, network),
      listStandaloneWatchedWallets(deps.db)
    ]);

    // A legacy key may also have been imported as an HD child. Keep one scan
    // target and prefer the HD ownership metadata when the keys overlap.
    const byPublicKey = new Map();
    for (const wallet of [...standaloneWallets, ...hdWallets]) {
      const existing = byPublicKey.get(wallet.publicKey);
      if (!existing || wallet.hdWalletId !== null) {
        byPublicKey.set(wallet.publicKey, wallet);
      }
    }
    return [...byPublicKey.values()];
  }

  const match = /^hd:(\d+)$/.exec(scope);
  if (!match) {
    throw new TypeError(`Unsupported scanner scope: ${scope}`);
  }

  return listActiveWatchedWallets(deps.db, network, { hdWalletId: match[1] });
}
