'use client';

import { useQuery } from '@tanstack/react-query';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { useRealtime } from '@/components/realtime-provider';
import { StatusBadge } from '@/components/status-badge';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative, humanize, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ListResponse, OperationalEvent } from '@/lib/types';

export default function ActivityPage() {
  const { t } = useI18n();
  const { recentEvents } = useRealtime();

  const activity = useQuery({
    queryKey: ['activity'],
    queryFn: () => api.get<ListResponse<OperationalEvent>>('/activity', { limit: 200 }),
    refetchInterval: 20_000
  });

  const rows = (() => {
    const map = new Map<string, OperationalEvent>();
    for (const event of activity.data?.items ?? []) map.set(event.eventId, event);
    for (const event of recentEvents) map.set(event.eventId, event);
    return [...map.values()].sort((a, b) => Number(b.id) - Number(a.id));
  })();

  const columns: Column<OperationalEvent>[] = [
    { key: 'type', header: t('activity.event'), render: (row) => <span className="text-slate-200">{humanize(row.eventType)}</span> },
    { key: 'tenant', header: t('activity.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId ?? 'platform'}</span> },
    { key: 'wallet', header: t('common.address'), render: (row) => <span className="mono text-slate-400">{row.walletPublicKey ? shortAddress(row.walletPublicKey, 6) : row.hdWalletId ? `HD #${row.hdWalletId}` : '—'}</span> },
    { key: 'network', header: t('common.network'), render: (row) => <StatusBadge status={row.network ?? 'active'} label={row.network ?? '—'} /> },
    { key: 'created', header: t('common.created'), render: (row) => (
      <span className="text-[11px] text-slate-500" title={formatDateTime(row.createdAt)}>{formatRelative(row.createdAt)}</span>
    ) }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('activity.title')} subtitle={t('activity.subtitle')} />
      <DataTable
        columns={columns}
        rows={rows}
        loading={activity.isLoading}
        error={activity.error ? activity.error.message : null}
        onRetry={() => activity.refetch()}
        emptyTitle={t('overview.noEvents')}
      />
    </div>
  );
}