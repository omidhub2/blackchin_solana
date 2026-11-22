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
    const ambiguousAddresses = new Set();
    for (const wallet of [...standaloneWallets, ...hdWallets]) {
      if (ambiguousAddresses.has(wallet.publicKey)) continue;
      const normalized = { ...wallet, tenantId: wallet.tenantId ?? null };
      const existing = byPublicKey.get(wallet.publicKey);
      if (!existing) {
        byPublicKey.set(wallet.publicKey, normalized);
        continue;
      }
      if (existing.tenantId !== null && normalized.tenantId !== null &&
          existing.tenantId !== normalized.tenantId) {
        // A shared address with conflicting explicit owners is never assigned
        // to either tenant by scanner iteration order.
        byPublicKey.delete(wallet.publicKey);
        ambiguousAddresses.add(wallet.publicKey);
        continue;
      }
      if (existing.tenantId === null && normalized.tenantId !== null) {
        byPublicKey.set(wallet.publicKey, normalized);
        continue;
      }
      if (existing.tenantId === normalized.tenantId && normalized.hdWalletId !== null) {
        byPublicKey.set(wallet.publicKey, normalized);
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
