'use client';

import { useQuery } from '@tanstack/react-query';
import { ExternalLink } from 'lucide-react';
import { useState } from 'react';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { api } from '@/lib/api';
import { explorerUrl, formatDateTime, formatSol, humanize, shortAddress, shortSignature } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ListResponse, TransactionRecord } from '@/lib/types';

const statuses = ['all', 'detected', 'confirming', 'confirmed', 'credited', 'under_review', 'failed', 'rejected'];

export default function TransactionsPage() {
  const { t } = useI18n();
  const [status, setStatus] = useState('all');

  const transactions = useQuery({
    queryKey: ['transactions', status],
    queryFn: () => api.get<ListResponse<TransactionRecord>>('/transactions', {
      limit: 200,
      status: status === 'all' ? undefined : status
    })
  });

  const columns: Column<TransactionRecord>[] = [
    { key: 'signature', header: t('common.signature'), render: (row) => {
      const link = explorerUrl(row.network, row.signature);
      return (
        <span className="inline-flex items-center gap-1.5">
          <span className="mono text-slate-200">{shortSignature(row.signature)}</span>
          {link ? <a href={link} target="_blank" rel="noreferrer" className="text-cyan-400 hover:text-cyan-300"><ExternalLink size={12} /></a> : null}
        </span>
      );
    } },
    { key: 'direction', header: t('transactions.direction'), render: (row) => (
      <span className={`chip ${row.direction === 'deposit' ? 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300' : 'border-violet-400/20 bg-violet-400/10 text-violet-300'}`}>
        {humanize(row.direction)}
      </span>
    ) },
    { key: 'wallet', header: t('common.wallet'), render: (row) => <span className="mono text-slate-300">{shortAddress(row.walletPublicKey, 8)}</span> },
    { key: 'amount', header: t('common.amount'), render: (row) => <span className="mono text-slate-100">{formatSol(row.amountLamports)} SOL</span> },
    { key: 'fee', header: t('transactions.fee'), render: (row) => <span className="mono text-slate-500">{row.feeLamports ? `${formatSol(row.feeLamports)} SOL` : '—'}</span> },
    { key: 'slot', header: t('transactions.slot'), render: (row) => <span className="mono text-slate-500">{row.slot ?? '—'}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('transactions.title')} subtitle={t('transactions.subtitle')} />
      <DataTable
        columns={columns}
        rows={transactions.data?.items ?? []}
        loading={transactions.isLoading}
        error={transactions.error ? transactions.error.message : null}
        onRetry={() => transactions.refetch()}
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