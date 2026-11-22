'use client';

import { useQuery } from '@tanstack/react-query';
import {
  Activity,
  ArrowDownToLine,
  ArrowUpFromLine,
  CheckCircle2,
  Clock,
  Cpu,
  Flame,
  GitBranch,
  Layers,
  MapPin,
  Radio,
  Server,
  Wallet,
  Webhook,
  XCircle
} from 'lucide-react';
import { useState } from 'react';

import { ActivityCharts, StatusDistribution } from '@/components/charts';
import { PageHeader } from '@/components/page-header';
import { useRealtime } from '@/components/realtime-provider';
import { StatCard } from '@/components/stat-card';
import { StatusBadge } from '@/components/status-badge';
import { InlineError } from '@/components/ui';
import { api } from '@/lib/api';
import { formatNumber, formatRelative, humanize, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { OverviewResponse } from '@/lib/types';

const ranges = [
  { key: '24h', label: '24H' },
  { key: '7d', label: '7D' },
  { key: '30d', label: '30D' }
];

function ServiceRow({
  icon: Icon,
  label,
  status,
  detail
}: {
  icon: typeof Server;
  label: string;
  status: string;
  detail?: string;
}) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-3">
      <div className="flex items-center gap-3">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-slate-300">
          <Icon size={15} />
        </span>
        <div>
          <p className="text-xs font-medium text-slate-200">{label}</p>
          {detail ? <p className="text-[10px] text-slate-500">{detail}</p> : null}
        </div>
      </div>
      <StatusBadge status={status} />
    </div>
  );
}

export default function OverviewPage() {
  const { t } = useI18n();
  const { status: streamStatus, recentEvents } = useRealtime();
  const [range, setRange] = useState('24h');

  const overview = useQuery({
    queryKey: ['overview', range],
    queryFn: () => api.get<OverviewResponse>('/overview', { range }),
    refetchInterval: streamStatus === 'live' ? false : 15_000
  });

  const data = overview.data;

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('overview.title')}
        subtitle={t('overview.subtitle')}
        actions={
          <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
            {ranges.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => setRange(item.key)}
                className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${
                  range === item.key ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-slate-200'
                }`}
              >
                {item.label}
              </button>
            ))}
          </div>
        }
      />

      {overview.error ? <InlineError message={overview.error.message} onRetry={() => overview.refetch()} /> : null}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label={t('overview.hdWallets')} value={data ? formatNumber(data.stats.hdWallets) : '—'} icon={Layers} accent="cyan" hint={data ? `${data.stats.tenants} tenants` : undefined} />
        <StatCard label={t('overview.childWallets')} value={data ? formatNumber(data.stats.childWallets) : '—'} icon={GitBranch} accent="blue" hint={data ? `${formatNumber(data.stats.monitoredAddresses)} monitored` : undefined} />
        <StatCard label={t('overview.hotWallets')} value={data ? formatNumber(data.stats.hotWallets) : '—'} icon={Flame} accent="amber" hint={data ? `${data.stats.frozenHotWallets} frozen` : undefined} />
        <StatCard label={t('overview.registeredAddresses')} value={data ? formatNumber(data.stats.registeredAddresses) : '—'} icon={MapPin} accent="violet" hint={data ? `${formatNumber(data.stats.activeCredentials)} active credentials` : undefined} />
        <StatCard label={t('overview.deposits')} value={data ? formatNumber(data.stats.deposits.total) : '—'} icon={ArrowDownToLine} accent="emerald" hint={data ? `${data.stats.deposits.confirmed} confirmed · ${data.stats.deposits.pending} pending` : undefined} />
        <StatCard label={t('overview.withdrawals')} value={data ? formatNumber(data.stats.withdrawals.total) : '—'} icon={ArrowUpFromLine} accent="cyan" hint={data ? `${data.stats.withdrawals.confirmed} confirmed · ${data.stats.withdrawals.pending} processing` : undefined} />
        <StatCard label={t('overview.transactions')} value={data ? formatNumber(data.stats.transactions.total) : '—'} icon={Activity} accent="blue" hint={data ? `${data.stats.transactions.confirmed} confirmed · ${data.stats.transactions.failed} failed` : undefined} />
        <StatCard label={t('overview.webhookEndpoints')} value={data ? formatNumber(data.stats.webhooks.endpoints) : '—'} icon={Webhook} accent="violet" hint={data ? `${data.stats.webhooks.pending} pending · ${data.stats.webhooks.failed} failed` : undefined} />
      </div>

      <div className="grid gap-4 xl:grid-cols-[2fr_1fr]">
        <div className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-sm font-semibold text-slate-200">{t('overview.serviceHealth')}</h2>
            <span className="text-[11px] text-slate-500">{data ? formatRelative(data.generatedAt) : '—'}</span>
          </div>
          <div className="grid gap-2.5 sm:grid-cols-2">
            <ServiceRow icon={Server} label={t('overview.rpcHealth')} status={data?.services.rpc.status ?? 'unavailable'} detail={data?.services.rpc.latencyMs !== undefined ? `${data.services.rpc.latencyMs} ms` : data?.services.rpc.reason} />
            <ServiceRow icon={Radio} label={t('overview.scanner')} status={data?.services.scanner.status ?? 'idle'} detail={data?.services.scanner.lastRunAt ? formatRelative(data.services.scanner.lastRunAt) : 'No scan yet'} />
            <ServiceRow icon={Cpu} label={t('overview.signer')} status={data?.services.signer.status ?? 'unavailable'} detail={data?.services.signer.kms ? 'KMS/HSM' : 'Application encryption'} />
            <ServiceRow icon={Webhook} label={t('overview.webhooks')} status={data?.services.webhooks.status ?? 'disabled'} detail={data?.services.webhooks.lastRunAt ? formatRelative(data.services.webhooks.lastRunAt) : undefined} />
          </div>
          <div className="mt-4 grid grid-cols-3 gap-2.5">
            <div className="rounded-xl border border-emerald-400/10 bg-emerald-400/[0.04] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-emerald-300"><CheckCircle2 size={12} /> {t('overview.confirmed')}</p>
              <p className="mt-1 text-lg font-semibold text-white">{data ? formatNumber(data.stats.transactions.confirmed) : '—'}</p>
            </div>
            <div className="rounded-xl border border-amber-400/10 bg-amber-400/[0.04] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-amber-300"><Clock size={12} /> {t('overview.pending')}</p>
              <p className="mt-1 text-lg font-semibold text-white">{data ? formatNumber(data.stats.transactions.pending) : '—'}</p>
            </div>
            <div className="rounded-xl border border-rose-400/10 bg-rose-400/[0.04] px-3 py-2.5">
              <p className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-rose-300"><XCircle size={12} /> {t('overview.failed')}</p>
              <p className="mt-1 text-lg font-semibold text-white">{data ? formatNumber(data.stats.transactions.failed) : '—'}</p>
            </div>
          </div>
        </div>

        <StatusDistribution
          confirmed={data?.stats.transactions.confirmed ?? 0}
          pending={data?.stats.transactions.pending ?? 0}
          failed={data?.stats.transactions.failed ?? 0}
          underReview={data?.stats.transactions.underReview ?? 0}
        />
      </div>

      {data ? <ActivityCharts series={data.series} /> : null}

      <div className="panel overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-sm font-semibold text-slate-200">{t('overview.recentActivity')}</h2>
          <span className="text-[11px] text-slate-500">{recentEvents.length} events</span>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {recentEvents.length === 0 ? (
            <p className="px-5 py-8 text-center text-sm text-slate-500">{t('overview.noEvents')}</p>
          ) : recentEvents.slice(0, 12).map((event) => (
            <div key={event.eventId} className="flex flex-wrap items-center gap-3 px-5 py-3 text-xs">
              <span className="grid h-7 w-7 place-items-center rounded-lg border border-white/10 bg-white/[0.03] text-cyan-300">
                <Activity size={13} />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium text-slate-200">{humanize(event.eventType)}</p>
                <p className="truncate text-[11px] text-slate-500">
                  {event.walletPublicKey ? shortAddress(event.walletPublicKey) : event.hdWalletId ? `HD #${event.hdWalletId}` : 'Platform'}
                  {event.tenantId ? ` · tenant ${event.tenantId}` : ''}
                </p>
              </div>
              <span className="text-[11px] text-slate-500">{formatRelative(event.createdAt)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}