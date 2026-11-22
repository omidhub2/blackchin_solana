'use client';

import { useQuery } from '@tanstack/react-query';
import { Activity, Cpu, Radio, Server } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { InlineError, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatRelative, humanize } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { NetworkResponse } from '@/lib/types';

export default function NetworkPage() {
  const { t } = useI18n();

  const network = useQuery({
    queryKey: ['network'],
    queryFn: () => api.get<NetworkResponse>('/network'),
    refetchInterval: 20_000
  });

  const data = network.data;

  return (
    <div className="space-y-6">
      <PageHeader title={t('network.title')} subtitle={t('network.subtitle')} />

      {network.error ? <InlineError message={network.error.message} onRetry={() => network.refetch()} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {[
          { icon: Server, label: t('network.cluster'), value: data?.network ?? '—' },
          { icon: Activity, label: t('network.commitment'), value: data?.commitment ?? '—' },
          { icon: Cpu, label: t('network.rpcStatus'), value: data ? humanize(data.rpc.status) : '—' },
          { icon: Radio, label: t('network.latency'), value: data?.rpc.latencyMs !== undefined ? `${data.rpc.latencyMs} ms` : '—' }
        ].map((item) => (
          <div key={item.label} className="panel p-5">
            <div className="flex items-center justify-between">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</p>
              <item.icon size={16} className="text-cyan-300" />
            </div>
            <p className="mt-2 text-lg font-semibold text-white">{item.value}</p>
            {item.label === t('network.rpcStatus') && data ? <div className="mt-2"><StatusBadge status={data.rpc.status} /></div> : null}
          </div>
        ))}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('network.scannerCursors')}</h2>
          {data?.scanner.cursors.length ? (
            <div className="divide-y divide-white/[0.04]">
              {data.scanner.cursors.map((cursor) => (
                <div key={cursor.status} className="flex items-center justify-between gap-3 py-2.5 text-xs">
                  <span className="flex items-center gap-2">
                    <StatusBadge status={cursor.status} />
                    <span className="text-slate-400">{cursor.cursors} cursors</span>
                  </span>
                  <span className="text-[11px] text-slate-500">
                    {cursor.lastRunAt ? formatRelative(cursor.lastRunAt) : t('common.never')}
                  </span>
                </div>
              ))}
            </div>
          ) : <p className="text-xs text-slate-500">No scanner cursors recorded.</p>}
          <p className="mt-3 text-[11px] text-slate-500">Last scan: {data?.scanner.lastRunAt ? formatDateTime(data.scanner.lastRunAt) : t('common.never')}</p>
        </Panel>

        <Panel className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('network.supported')}</h2>
          <div className="flex flex-wrap gap-2">
            {(data?.supportedAssets ?? []).map((asset) => (
              <span key={asset} className="chip border-emerald-400/20 bg-emerald-400/10 text-emerald-300">SOL · Solana native</span>
            ))}
          </div>
          <h2 className="mb-2 mt-5 text-sm font-semibold text-slate-200">{t('network.unsupported')}</h2>
          <div className="flex flex-wrap gap-2">
            {(data?.unsupported ?? []).map((item) => (
              <span key={item} className="chip border-white/10 bg-white/[0.04] text-slate-500">{item}</span>
            ))}
          </div>
        </Panel>
      </div>
    </div>
  );
}