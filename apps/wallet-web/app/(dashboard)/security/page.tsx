'use client';

import { useQuery } from '@tanstack/react-query';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatSol } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { CredentialRecord, HotWallet, PolicyRecord } from '@/lib/types';

type SecurityResponse = {
  policies: PolicyRecord[];
  credentials: CredentialRecord[];
  hotWallets: HotWallet[];
};

export default function SecurityPage() {
  const { t } = useI18n();

  const security = useQuery({
    queryKey: ['security'],
    queryFn: () => api.get<SecurityResponse>('/security', { limit: 200 })
  });

  const policyColumns: Column<PolicyRecord>[] = [
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="text-slate-200">{row.tenantName} <span className="text-[11px] text-slate-500">#{row.tenantId}</span></span> },
    { key: 'enabled', header: t('security.policyEnabled'), render: (row) => <StatusBadge status={row.enabled ? 'active' : 'disabled'} label={row.enabled ? t('common.yes') : t('common.no')} /> },
    { key: 'frozen', header: t('security.emergencyFrozen'), render: (row) => <StatusBadge status={row.emergencyFrozen ? 'frozen' : 'active'} label={row.emergencyFrozen ? t('common.yes') : t('common.no')} /> },
    { key: 'single', header: t('security.maxSingle'), render: (row) => <span className="mono text-slate-400">{formatSol(row.maxSingleLamports)} SOL</span> },
    { key: 'daily', header: t('security.maxDaily'), render: (row) => <span className="mono text-slate-400">{formatSol(row.maxDailyLamports)} SOL</span> },
    { key: 'version', header: t('security.version'), render: (row) => <span className="mono text-slate-400">v{row.policyVersion}</span> },
    { key: 'updated', header: t('common.updated'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.updatedAt)}</span> }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('security.title')} subtitle={t('security.subtitle')} />

      <Panel className="p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('security.policies')}</h2>
        <DataTable
          columns={policyColumns}
          rows={security.data?.policies ?? []}
          loading={security.isLoading}
          error={security.error ? security.error.message : null}
          onRetry={() => security.refetch()}
          emptyTitle="No tenant withdrawal policy configured (submissions fail closed)"
        />
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('security.hotWallets')}</h2>
          <div className="space-y-2.5">
            {(security.data?.hotWallets ?? []).slice(0, 8).map((wallet) => (
              <div key={wallet.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate text-slate-200">{wallet.label ?? 'Hot wallet'}</p>
                  <p className="mono truncate text-[10px] text-slate-500">{wallet.publicKey}</p>
                </div>
                <StatusBadge status={wallet.status} />
              </div>
            ))}
            {(security.data?.hotWallets ?? []).length === 0 ? <p className="text-xs text-slate-500">No hot wallets registered.</p> : null}
          </div>
        </Panel>

        <Panel className="p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('security.credentials')}</h2>
          <div className="space-y-2.5">
            {(security.data?.credentials ?? []).slice(0, 8).map((credential) => (
              <div key={credential.id} className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.05] bg-white/[0.02] px-3.5 py-2.5 text-xs">
                <div className="min-w-0">
                  <p className="truncate text-slate-200">{credential.tenantName}</p>
                  <p className="mono truncate text-[10px] text-slate-500">{credential.keyPrefix}… · {credential.scopes.length} scopes</p>
                </div>
                <StatusBadge status={credential.status} />
              </div>
            ))}
            {(security.data?.credentials ?? []).length === 0 ? <p className="text-xs text-slate-500">No credentials issued.</p> : null}
          </div>
        </Panel>
      </div>
    </div>
  );
}