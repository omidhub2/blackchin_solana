'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { GitBranch } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Modal } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ChildWallet, ListResponse } from '@/lib/types';

export default function ChildWalletsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ tenantId: '', hdWalletId: '', count: '1' });
  const [formError, setFormError] = useState<string | null>(null);

  const wallets = useQuery({
    queryKey: ['wallets', 'child'],
    queryFn: () => api.get<ListResponse<ChildWallet>>('/wallets', { type: 'child', limit: 200 })
  });

  const generate = useMutation({
    mutationFn: () => api.post(`/tenants/${form.tenantId}/hd-wallets/${form.hdWalletId}/accounts`, {
      count: Number(form.count)
    }),
    onSuccess: () => {
      setOpen(false);
      setForm({ tenantId: '', hdWalletId: '', count: '1' });
      void queryClient.invalidateQueries({ queryKey: ['wallets', 'child'] });
      void queryClient.invalidateQueries({ queryKey: ['addresses'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (error) => setFormError(error instanceof ApiError ? error.message : 'Request failed')
  });

  const columns: Column<ChildWallet>[] = [
    { key: 'publicKey', header: t('common.address'), render: (row) => (
      <div className="flex items-center gap-2">
        <span className="mono text-slate-200">{shortAddress(row.publicKey, 8)}</span>
        <CopyButton value={row.publicKey} label="" />
      </div>
    ) },
    { key: 'parent', header: t('child.parent'), render: (row) => <span className="mono text-slate-400">#{row.hdWalletId}{row.parentLabel ? ` · ${row.parentLabel}` : ''}</span> },
    { key: 'index', header: t('child.index'), render: (row) => <span className="mono text-slate-300">{row.accountIndex}</span> },
    { key: 'path', header: t('child.path'), render: (row) => <span className="mono text-[11px] text-slate-500">{row.derivationPath}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId ?? 'legacy'}</span> },
    { key: 'network', header: t('common.network'), render: (row) => <span className="chip border-white/10 bg-white/[0.04] text-slate-300">{row.network}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('child.title')}
        subtitle={t('child.subtitle')}
        actions={
          <button type="button" className="btn-primary" onClick={() => { setFormError(null); setOpen(true); }}>
            <GitBranch size={15} /> {t('child.generate')}
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
        open={open}
        title={t('child.generate')}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button
              type="button"
              className="btn-primary"
              disabled={generate.isPending || !form.tenantId || !form.hdWalletId}
              onClick={() => { setFormError(null); generate.mutate(); }}
            >
              {generate.isPending ? '…' : t('form.generate')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t('form.tenantId')}>
            <input className="input" inputMode="numeric" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} placeholder="42" />
          </Field>
          <Field label={t('child.parent')} hint="Numeric HD wallet ID.">
            <input className="input" inputMode="numeric" value={form.hdWalletId} onChange={(event) => setForm({ ...form, hdWalletId: event.target.value })} placeholder="7" />
          </Field>
          <Field label={t('form.count')} hint="1–50 accounts are derived atomically.">
            <input className="input" inputMode="numeric" value={form.count} onChange={(event) => setForm({ ...form, count: event.target.value })} />
          </Field>
          {formError ? <p className="text-xs text-rose-300">{formError}</p> : null}
        </div>
      </Modal>
    </div>
  );
}