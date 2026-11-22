'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Modal, Panel } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { HdWallet, ListResponse } from '@/lib/types';

type CreateResponse = {
  wallet: { id: string; network: string; label: string | null; status: string };
  recovery: { token: string; wordCount: number; expiresAt: string; warning: string };
};

export default function HdWalletsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ tenantId: '', label: '' });
  const [formError, setFormError] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<CreateResponse['recovery'] | null>(null);

  const wallets = useQuery({
    queryKey: ['wallets', 'hd'],
    queryFn: () => api.get<ListResponse<HdWallet>>('/wallets', { type: 'hd', limit: 200 })
  });

  const create = useMutation({
    mutationFn: () => api.post<CreateResponse>(`/tenants/${form.tenantId}/hd-wallets`, {
      label: form.label || undefined
    }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setForm({ tenantId: '', label: '' });
      setRecovery(result.recovery);
      void queryClient.invalidateQueries({ queryKey: ['wallets', 'hd'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => setFormError(error instanceof ApiError ? error.message : 'Request failed')
  });

  const columns: Column<HdWallet>[] = [
    { key: 'id', header: 'ID', render: (row) => <span className="mono text-slate-200">#{row.id}</span>, className: 'w-20' },
    { key: 'label', header: t('form.label'), render: (row) => <span className="text-slate-200">{row.label ?? '—'}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId ?? 'legacy'}</span> },
    { key: 'network', header: t('common.network'), render: (row) => <span className="chip border-white/10 bg-white/[0.04] text-slate-300">{row.network}</span> },
    { key: 'children', header: t('hd.childCount'), render: (row) => <span className="text-slate-200">{row.childCount}</span> },
    { key: 'next', header: t('hd.nextIndex'), render: (row) => <span className="mono text-slate-400">{row.nextAccountIndex}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('hd.title')}
        subtitle={t('hd.subtitle')}
        actions={
          <button type="button" className="btn-primary" onClick={() => { setFormError(null); setCreateOpen(true); }}>
            <Plus size={15} /> {t('hd.create')}
          </button>
        }
      />

      <DataTable
        columns={columns}
        rows={wallets.data?.items ?? []}
        loading={wallets.isLoading}
        error={wallets.error ? wallets.error.message : null}
        onRetry={() => wallets.refetch()}
        emptyTitle={t('common.noData')}
      />

      <Modal
        open={createOpen}
        title={t('hd.create')}
        onClose={() => setCreateOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</button>
            <button
              type="button"
              className="btn-primary"
              disabled={create.isPending || !form.tenantId}
              onClick={() => { setFormError(null); create.mutate(); }}
            >
              {create.isPending ? '…' : t('form.create')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t('form.tenantId')} hint="The authenticated tenant that will own this root.">
            <input className="input" inputMode="numeric" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} placeholder="42" />
          </Field>
          <Field label={t('form.label')}>
            <input className="input" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="treasury" />
          </Field>
          {formError ? <p className="text-xs text-rose-300">{formError}</p> : null}
          <p className="rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3 py-2.5 text-[11px] text-amber-200">
            The recovery phrase is returned once. Store it offline before closing the next dialog.
          </p>
        </div>
      </Modal>

      <Modal open={Boolean(recovery)} title={t('hd.recoveryTitle')} onClose={() => setRecovery(null)}>
        {recovery ? (
          <div className="space-y-4">
            <pre className="mono max-h-52 overflow-auto whitespace-pre-wrap rounded-xl border border-white/10 bg-ink-900/80 p-3 text-cyan-100">{recovery.token}</pre>
            <div className="flex items-center justify-between">
              <span className="text-[11px] text-slate-500">{recovery.wordCount} words · token expires {formatDateTime(recovery.expiresAt)}</span>
              <CopyButton value={recovery.token} />
            </div>
            <Panel className="border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-200">{recovery.warning}</Panel>
          </div>
        ) : null}
      </Modal>
    </div>
  );
}