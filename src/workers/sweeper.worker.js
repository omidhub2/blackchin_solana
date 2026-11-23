/** Cluster-serialized native SOL sweeper worker. */
import { createDepositScannerWorker } from './deposit-scanner.worker.js';
import { acquireSweeperLock } from '../infrastructure/database/sweeper.repository.js';

export function createSweeperWorker({ sweeper, pool, network, intervalMs = 60_000, log = () => {} }) {
  if (!sweeper || typeof sweeper.scan !== 'function') {
    throw new TypeError('A sweeper service is required');
  }
  if (!pool || typeof pool.connect !== 'function') {
    throw new TypeError('A dedicated sweeper PostgreSQL pool is required');
  }
  return createDepositScannerWorker({
    scanner: sweeper,
    cursors: {
      acquireScannerLock: (client, { network: requestedNetwork }) =>
        acquireSweeperLock(client, requestedNetwork)
    },
    pool,
    network,
    scope: 'native-sol-sweeper',
    intervalMs,
    minBackoffMs: 5_000,
    maxBackoffMs: 180_000,
    log: (event, meta) => log(event.replace('scanner.', 'sweeper.'), meta)
  });
}
