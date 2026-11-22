'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { api } from '@/lib/api';
import { explorerUrl, formatDateTime, formatSol, shortAddress, shortSignature } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ListResponse, WithdrawalRecord } from '@/lib/types';

const statuses = ['all', 'processing', 'completed', 'failed'];

export default function WithdrawalsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState('all');

  const withdrawals = useQuery({
    queryKey: ['withdrawals', status],
    queryFn: () => api.get<ListResponse<WithdrawalRecord>>('/withdrawals', {
      limit: 200,
      status: status === 'all' ? undefined : status
    })
  });

  const columns: Column<WithdrawalRecord>[] = [
    { key: 'key', header: 'Idempotency key', render: (row) => <span className="mono text-slate-300">{shortAddress(row.idempotencyKey, 10)}</span> },
    { key: 'from', header: 'Source', render: (row) => <span className="mono text-slate-300">{shortAddress(row.fromPublicKey, 6)}</span> },
    { key: 'to', header: 'Destination', render: (row) => <span className="mono text-slate-300">{shortAddress(row.toPublicKey, 6)}</span> },
    { key: 'amount', header: t('common.amount'), render: (row) => <span className="mono text-slate-100">{formatSol(row.amountLamports)} SOL</span> },
    { key: 'signature', header: t('common.signature'), render: (row) => {
      const link = explorerUrl(row.network, row.signature);
      return row.signature ? (
        <span className="inline-flex items-center gap-1.5">
          <span className="mono text-slate-300">{shortSignature(row.signature)}</span>
          {link ? <a href={link} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300"><ExternalLink size={12} /></a> : null}
        </span>
      ) : <span className="text-slate-500">—</span>;
    } },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('withdrawals.title')} subtitle={t('withdrawals.subtitle')} />
      <DataTable
        columns={columns}
        rows={withdrawals.data?.items ?? []}
        loading={withdrawals.isLoading}
        error={withdrawals.error ? withdrawals.error.message : null}
        onRetry={() => withdrawals.refetch()}
        emptyTitle={t('common.noData')}
        toolbar={
          <select value={status} onChange={(event) => setStatus(event.target.value)} className="select w-auto !py-2 text-xs">
            {statuses.map((item) => <option key={item} value={item}>{item === 'all' ? t('common.all') : item}</option>)}
          </select>
        }
      />
    </div>
  );
}