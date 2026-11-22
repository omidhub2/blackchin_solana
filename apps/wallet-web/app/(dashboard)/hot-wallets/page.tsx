'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Flame, Plus, Snowflake, Play } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Modal } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, formatSol, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { HotWallet, ListResponse } from '@/lib/types';

export default function HotWalletsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [freezeTarget, setFreezeTarget] = useState<HotWallet | null>(null);
  const [reason, setReason] = useState('');
  const [form, setForm] = useState({ tenantId: '', publicKey: '', label: '', maxSingleLamports: '0' });
  const [error, setError] = useState<string | null>(null);

  const wallets = useQuery({
    queryKey: ['wallets', 'hot'],
    queryFn: () => api.get<ListResponse<HotWallet>>('/wallets', { type: 'hot', limit: 200 })
  });

  function refresh() {
    void queryClient.invalidateQueries({ queryKey: ['wallets', 'hot'] });
    void queryClient.invalidateQueries({ queryKey: ['security'] });
    void queryClient.invalidateQueries({ queryKey: ['overview'] });
  }

  const register = useMutation({
    mutationFn: () => api.post('/hot-wallets', {
      tenantId: Number(form.tenantId),
      publicKey: form.publicKey,
      label: form.label || undefined,
      maxSingleLamports: form.maxSingleLamports || '0'
    }),
    onSuccess: () => { setOpen(false); setForm({ tenantId: '', publicKey: '', label: '', maxSingleLamports: '0' }); refresh(); },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const freeze = useMutation({
    mutationFn: () => api.post(`/hot-wallets/${freezeTarget?.publicKey}/freeze`, { tenantId: Number(freezeTarget?.tenantId), reason }),
    onSuccess: () => { setFreezeTarget(null); setReason(''); refresh(); },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const unfreeze = useMutation({
    mutationFn: (wallet: HotWallet) => api.post(`/hot-wallets/${wallet.publicKey}/unfreeze`, { tenantId: Number(wallet.tenantId) }),
    onSuccess: refresh,
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const columns: Column<HotWallet>[] = [
    { key: 'publicKey', header: t('common.address'), render: (row) => (
      <div className="flex items-center gap-2">
        <span className="mono text-slate-200">{shortAddress(row.publicKey, 8)}</span>
        <CopyButton value={row.publicKey} label="" />
      </div>
    ) },
    { key: 'label', header: t('form.label'), render: (row) => <span className="text-slate-300">{row.label ?? '—'}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId}</span> },
    { key: 'signing', header: t('hot.signing'), render: (row) => <StatusBadge status={row.signingEnabled ? 'active' : 'disabled'} label={row.signingEnabled ? t('common.enabled') : t('common.disabled')} /> },
    { key: 'max', header: t('hot.maxSingle'), render: (row) => <span className="mono text-slate-400">{formatSol(row.maxSingleLamports)} SOL</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'actions', header: t('common.actions'), searchable: false, render: (row) => (
      row.status === 'active' ? (
        <button type="button" className="btn-danger !px-2.5 !py-1.5 text-[11px]" onClick={() => { setError(null); setFreezeTarget(row); }}>
          <Snowflake size={12} /> {t('hot.freeze')}
        </button>
      ) : (
        <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-[11px]" disabled={unfreeze.isPending} onClick={() => { setError(null); unfreeze.mutate(row); }}>
          <Play size={12} /> {t('hot.unfreeze')}
        </button>
      )
    ) }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('hot.title')}
        subtitle={t('hot.subtitle')}
        actions={
          <button type="button" className="btn-primary" onClick={() => { setError(null); setOpen(true); }}>
            <Plus size={15} /> {t('hot.register')}
          </button>
        }
      />

      {error ? <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-2.5 text-xs text-rose-200">{error}</p> : null}

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
        title={t('hot.register')}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn-primary" disabled={register.isPending || !form.tenantId || !form.publicKey} onClick={() => { setError(null); register.mutate(); }}>
              {register.isPending ? '…' : t('form.register')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t('form.tenantId')}>
            <input className="input" inputMode="numeric" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} placeholder="42" />
          </Field>
          <Field label={t('form.publicKey')} hint="An existing tenant HD child address.">
            <input className="input mono" value={form.publicKey} onChange={(event) => setForm({ ...form, publicKey: event.target.value })} placeholder="So1111…" />
          </Field>
          <Field label={t('form.label')}>
            <input className="input" value={form.label} onChange={(event) => setForm({ ...form, label: event.target.value })} placeholder="payout signer" />
          </Field>
          <Field label={t('hot.maxSingle')} hint="0 disables the per-transfer ceiling (the tenant withdrawal policy still applies).">
            <input className="input mono" inputMode="numeric" value={form.maxSingleLamports} onChange={(event) => setForm({ ...form, maxSingleLamports: event.target.value })} />
          </Field>
          <p className="rounded-xl border border-amber-400/15 bg-amber-400/[0.05] px-3 py-2.5 text-[11px] text-amber-200">
            Registering a hot wallet does not create or copy any key material. Signing still uses the encrypted HD root.
          </p>
        </div>
      </Modal>

      <Modal
        open={Boolean(freezeTarget)}
        title={t('hot.freeze')}
        onClose={() => setFreezeTarget(null)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setFreezeTarget(null)}>{t('common.cancel')}</button>
            <button type="button" className="btn-danger" disabled={freeze.isPending || reason.trim().length === 0} onClick={() => freeze.mutate()}>
              {freeze.isPending ? '…' : t('hot.freeze')}
            </button>
          </div>
        }
      >
        <Field label={t('hot.freezeReason')}>
          <input className="input" value={reason} onChange={(event) => setReason(event.target.value)} placeholder="incident-2026-11" />
        </Field>
      </Modal>
    </div>
  );
}