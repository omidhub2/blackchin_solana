/**
 * Platform operations dashboard read service.
 *
 * Every number is derived from persisted operational state. When a live
 * metric is unavailable (for example the RPC probe fails), the response says
 * so explicitly instead of inventing a value.
 */
import { badRequest } from '../errors.js';
import {
  getActivitySeries,
  getOverviewStats,
  getScannerStatus,
  listAddresses,
  listChildWallets,
  listHdWallets,
  listHotWallets,
  listTenantCredentials,
  listTenantPolicies,
  listTenants,
  listTransactions,
  listWebhookEvents,
  listWithdrawals
} from '../../infrastructure/database/dashboard.repository.js';
import {
  latestOperationalEventId,
  listRecentOperationalEvents
} from '../../infrastructure/database/operational-event.repository.js';

const RANGES = Object.freeze({
  '24h': { ms: 24 * 60 * 60 * 1000, bucket: 'hour' },
  '7d': { ms: 7 * 24 * 60 * 60 * 1000, bucket: 'day' },
  '30d': { ms: 30 * 24 * 60 * 60 * 1000, bucket: 'day' }
});

function parseRange(range, now) {
  if (range === undefined || range === null || range === '') {
    return { key: '24h', ...RANGES['24h'], since: new Date(now() - RANGES['24h'].ms) };
  }
  const definition = RANGES[range];
  if (!definition) {
    throw badRequest('range must be 24h, 7d or 30d', 'INVALID_RANGE');
  }
  return { key: range, ...definition, since: new Date(now() - definition.ms) };
}

async function probeRpc(rpc, commitment, timeoutMs = 3_000) {
  if (!rpc || typeof rpc.getSlot !== 'function') {
    return { status: 'unavailable', reason: 'not_configured' };
  }

  const startedAt = Date.now();
  let timer;

  try {
    const slot = await Promise.race([
      rpc.getSlot(commitment),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('rpc_probe_timeout')), timeoutMs);
      })
    ]);
    return { status: 'ok', slot: Number(slot), latencyMs: Date.now() - startedAt };
  } catch (error) {
    return {
      status: 'unavailable',
      reason: error.message === 'rpc_probe_timeout' ? 'timeout' : 'rpc_error',
      latencyMs: Date.now() - startedAt
    };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export function createDashboardService({
  db,
  rpc = null,
  network,
  commitment = 'confirmed',
  webhookWorker = null,
  webhookWorkerRef = null,
  now = () => Date.now()
}) {
  if (!db || typeof db.query !== 'function') {
    throw new TypeError('A database query executor is required');
  }

  return Object.freeze({
    async overview({ range } = {}) {
      const parsed = parseRange(range, now);
      const [stats, series, scanner, rpcHealth, recentEvents, lastEventId] = await Promise.all([
        getOverviewStats(db, { since: parsed.since }),
        getActivitySeries(db, { since: parsed.since, bucket: parsed.bucket }),
        getScannerStatus(db),
        probeRpc(rpc, commitment),
        listRecentOperationalEvents(db, { limit: 20 }),
        latestOperationalEventId(db)
      ]);

      const activeWebhookWorker = webhookWorkerRef?.current ?? webhookWorker;
      const webhookMetrics = activeWebhookWorker?.metrics ?? null;

      return {
        range: parsed.key,
        since: parsed.since.toISOString(),
        generatedAt: new Date(now()).toISOString(),
        stats,
        series,
        services: {
          rpc: { network, ...rpcHealth },
          scanner: {
            status: scanner.lastRunAt ? 'running' : 'idle',
            lastRunAt: scanner.lastRunAt,
            cursors: scanner.cursors
          },
          signer: {
            status: 'application_encrypted',
            kms: false,
            note: 'AES-256-GCM application encryption; KMS/HSM integration is not configured'
          },
          webhooks: webhookMetrics
            ? {
                status: 'running',
                delivered: webhookMetrics.delivered,
                retried: webhookMetrics.retried,
                discarded: webhookMetrics.discarded,
                lastRunAt: webhookMetrics.lastRunAt
              }
            : { status: 'disabled' }
        },
        recentEvents,
        lastEventId
      };
    },

    async wallets({ type = 'hd', limit = 50, offset = 0, tenantId = null } = {}) {
      if (type === 'hd') {
        return { type, items: await listHdWallets(db, { limit, offset, tenantId }) };
      }
      if (type === 'child') {
        return { type, items: await listChildWallets(db, { limit, offset, tenantId }) };
      }
      if (type === 'hot') {
        return { type, items: await listHotWallets(db, { limit, offset, tenantId }) };
      }
      throw badRequest('type must be hd, child or hot', 'INVALID_WALLET_TYPE');
    },

    async addresses({ limit = 50, offset = 0, tenantId = null } = {}) {
      return { items: await listAddresses(db, { limit, offset, tenantId }) };
    },

    async deposits({ limit = 50, offset = 0, status = null, tenantId = null } = {}) {
      return {
        items: await listTransactions(db, {
          limit, offset, status, tenantId, direction: 'deposit'
        })
      };
    },

    async withdrawals({ limit = 50, offset = 0, status = null, tenantId = null } = {}) {
      return { items: await listWithdrawals(db, { limit, offset, status, tenantId }) };
    },

    async transactions({ limit = 50, offset = 0, status = null, tenantId = null } = {}) {
      return { items: await listTransactions(db, { limit, offset, status, tenantId }) };
    },

    async activity({ limit = 50, offset = 0 } = {}) {
      return { items: await listRecentOperationalEvents(db, { limit: limit + offset }) };
    },

    async webhooks({ limit = 50, offset = 0, status = null } = {}) {
      return { items: await listWebhookEvents(db, { limit, offset, status }) };
    },

    async credentials({ limit = 100, offset = 0 } = {}) {
      return { items: await listTenantCredentials(db, { limit, offset }) };
    },

    async tenants({ limit = 100, offset = 0 } = {}) {
      return { items: await listTenants(db, { limit, offset }) };
    },

    async security({ limit = 100, offset = 0 } = {}) {
      const [policies, credentials, hotWallets] = await Promise.all([
        listTenantPolicies(db, { limit, offset }),
        listTenantCredentials(db, { limit, offset }),
        listHotWallets(db, { limit, offset })
      ]);
      return { policies, credentials, hotWallets };
    },

    async network() {
      const [rpcHealth, scanner] = await Promise.all([
        probeRpc(rpc, commitment),
        getScannerStatus(db)
      ]);
      return {
        network,
        commitment,
        rpc: rpcHealth,
        scanner,
        supportedAssets: ['SOL'],
        unsupported: ['SPL tokens', 'EVM networks', 'TRON', 'Bitcoin']
      };
    }
  });
}