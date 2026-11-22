'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { KeyRound, Plus } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Modal, Panel } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { CredentialRecord, ListResponse } from '@/lib/types';

const allScopes = [
  'wallets:read', 'wallets:write', 'addresses:write', 'deposits:read', 'deposits:write',
  'withdrawals:read', 'withdrawals:estimate', 'withdrawals:submit', 'transactions:read',
  'webhooks:read', 'webhooks:write', 'assets:read', 'assets:write'
];

export default function ApiCredentialsPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ tenantId: '', scopes: ['wallets:read', 'transactions:read'] });
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const credentials = useQuery({
    queryKey: ['credentials'],
    queryFn: () => api.get<ListResponse<CredentialRecord>>('/credentials', { limit: 200 })
  });

  const issue = useMutation({
    mutationFn: () => api.post<{ apiKey: string }>(`/tenants/${form.tenantId}/credentials`, { scopes: form.scopes }),
    onSuccess: (result) => {
      setOpen(false);
      setSecret(result.apiKey);
      void queryClient.invalidateQueries({ queryKey: ['credentials'] });
      void queryClient.invalidateQueries({ queryKey: ['overview'] });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const revoke = useMutation({
    mutationFn: (credential: CredentialRecord) => api.post(`/credentials/${credential.id}/revoke`, { tenantId: Number(credential.tenantId) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['credentials'] }),
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const columns: Column<CredentialRecord>[] = [
    { key: 'name', header: t('common.tenant'), render: (row) => (
      <div>
        <p className="text-slate-200">{row.tenantName}</p>
        <p className="text-[11px] text-slate-500">{row.tenantCode} · #{row.tenantId}</p>
      </div>
    ) },
    { key: 'prefix', header: t('credentials.keyPrefix'), render: (row) => <span className="mono text-slate-400">{row.keyPrefix}…</span> },
    { key: 'scopes', header: t('credentials.scopes'), render: (row) => (
      <div className="flex flex-wrap gap-1">
        {row.scopes.slice(0, 3).map((scope) => <span key={scope} className="chip border-white/10 bg-white/[0.04] text-[10px] text-slate-400">{scope}</span>)}
        {row.scopes.length > 3 ? <span className="chip border-white/10 bg-white/[0.04] text-[10px] text-slate-500">+{row.scopes.length - 3}</span> : null}
      </div>
    ) },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'lastUsed', header: t('credentials.lastUsed'), render: (row) => <span className="text-[11px] text-slate-500">{row.lastUsedAt ? formatDateTime(row.lastUsedAt) : t('common.never')}</span> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> },
    { key: 'actions', header: '', searchable: false, render: (row) => (
      row.status === 'active' ? (
        <button type="button" className="btn-danger !px-2.5 !py-1.5 text-[11px]" disabled={revoke.isPending} onClick={() => { setError(null); revoke.mutate(row); }}>
          {t('credentials.revoke')}
        </button>
      ) : null
    ) }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('credentials.title')}
        subtitle={t('credentials.subtitle')}
        actions={
          <button type="button" className="btn-primary" onClick={() => { setError(null); setOpen(true); }}>
            <Plus size={15} /> {t('credentials.create')}
          </button>
        }
      />

      {error ? <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-2.5 text-xs text-rose-200">{error}</p> : null}

      <DataTable
        columns={columns}
        rows={credentials.data?.items ?? []}
        loading={credentials.isLoading}
        error={credentials.error ? credentials.error.message : null}
        onRetry={() => credentials.refetch()}
        emptyTitle={t('common.noData')}
      />

      <Modal
        open={open}
        title={t('credentials.create')}
        onClose={() => setOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setOpen(false)}>{t('common.cancel')}</button>
            <button type="button" className="btn-primary" disabled={issue.isPending || !form.tenantId || form.scopes.length === 0} onClick={() => { setError(null); issue.mutate(); }}>
              {issue.isPending ? '…' : t('form.issue')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t('form.tenantId')}>
            <input className="input" inputMode="numeric" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} placeholder="42" />
          </Field>
          <div>
            <p className="field-label">{t('credentials.scopes')}</p>
            <div className="grid grid-cols-2 gap-2">
              {allScopes.map((scope) => (
                <label key={scope} className="flex items-center gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] px-2.5 py-2 text-[11px] text-slate-300">
                  <input
                    type="checkbox"
                    className="accent-cyan-400"
                    checked={form.scopes.includes(scope)}
                    onChange={(event) => setForm({
                      ...form,
                      scopes: event.target.checked
                        ? [...form.scopes, scope]
                        : form.scopes.filter((item) => item !== scope)
                    })}
                  />
                  <span className="mono">{scope}</span>
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>

      <Modal open={Boolean(secret)} title={t('credentials.secretOnce')} onClose={() => setSecret(null)}>
        <Panel className="border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-200">
          <span className="inline-flex items-center gap-1.5"><KeyRound size={12} /> This API key is stored hashed and cannot be shown again.</span>
        </Panel>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/80 p-3">
          <span className="mono break-all text-xs text-cyan-100">{secret}</span>
          {secret ? <CopyButton value={secret} /> : null}
        </div>
      </Modal>
    </div>
  );
}