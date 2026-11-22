'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, RefreshCw, RotateCcw } from 'lucide-react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Modal, Panel } from '@/components/ui';
import { api, ApiError } from '@/lib/api';
import { formatDateTime, humanize, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { ListResponse, WebhookEndpoint, WebhookEvent } from '@/lib/types';

const availableEventTypes = [
  'wallet.created', 'wallet.child.created', 'deposit.detected', 'deposit.confirmed',
  'deposit.failed', 'withdrawal.accepted', 'withdrawal.broadcast', 'withdrawal.confirmed',
  'withdrawal.failed', 'transaction.status_changed'
];

export default function WebhooksPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'events' | 'endpoints'>('events');
  const [tenantId, setTenantId] = useState('');
  const [createOpen, setCreateOpen] = useState(false);
  const [form, setForm] = useState({ tenantId: '', endpointUrl: '', eventTypes: '' });
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const events = useQuery({
    queryKey: ['webhooks', 'events'],
    queryFn: () => api.get<ListResponse<WebhookEvent>>('/webhooks', { limit: 200 })
  });

  const endpoints = useQuery({
    queryKey: ['webhooks', 'endpoints', tenantId],
    queryFn: () => api.get<ListResponse<WebhookEndpoint>>('/webhooks/endpoints', { tenantId }),
    enabled: Boolean(tenantId)
  });

  const createEndpoint = useMutation({
    mutationFn: () => api.post<{ secret: string }>('/webhooks', {
      tenantId: Number(form.tenantId),
      endpointUrl: form.endpointUrl,
      eventTypes: form.eventTypes ? form.eventTypes.split(',').map((item) => item.trim()).filter(Boolean) : []
    }),
    onSuccess: (result) => {
      setCreateOpen(false);
      setSecret(result.secret);
      setForm({ tenantId: '', endpointUrl: '', eventTypes: '' });
      void queryClient.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const rotate = useMutation({
    mutationFn: (endpoint: WebhookEndpoint) =>
      api.post<{ secret: string }>(`/webhooks/${endpoint.id}/rotate`, { tenantId: Number(endpoint.tenantId) }),
    onSuccess: (result) => {
      setSecret(result.secret);
      void queryClient.invalidateQueries({ queryKey: ['webhooks', 'endpoints'] });
    },
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const retry = useMutation({
    mutationFn: (event: WebhookEvent) => api.post(`/webhooks/events/${event.eventId}/retry`),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ['webhooks', 'events'] }),
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : 'Request failed')
  });

  const eventColumns: Column<WebhookEvent>[] = [
    { key: 'type', header: 'Event', render: (row) => <span className="text-slate-200">{row.eventType}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId ?? 'platform'}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'attempts', header: t('webhooks.attempts'), render: (row) => <span className="mono text-slate-400">{row.attempts}/{row.maxAttempts}</span> },
    { key: 'http', header: 'HTTP', render: (row) => <span className="mono text-slate-400">{row.lastHttpStatus ?? '—'}</span> },
    { key: 'error', header: t('webhooks.lastError'), render: (row) => <span className="text-[11px] text-rose-300">{row.lastError ?? '—'}</span> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> },
    { key: 'actions', header: '', searchable: false, render: (row) => (
      ['failed', 'discarded', 'delivered'].includes(row.status) ? (
        <button
          type="button"
          className="btn-secondary !px-2.5 !py-1.5 text-[11px]"
          disabled={retry.isPending}
          onClick={() => { setError(null); retry.mutate(row); }}
        >
          <RotateCcw size={12} /> {t('webhooks.retry')}
        </button>
      ) : null
    ) }
  ];

  const endpointColumns: Column<WebhookEndpoint>[] = [
    { key: 'url', header: t('webhooks.endpointUrl'), render: (row) => <span className="mono text-slate-300">{shortAddress(row.endpointUrl, 24)}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId}</span> },
    { key: 'events', header: t('webhooks.eventTypes'), render: (row) => <span className="text-[11px] text-slate-500">{row.eventTypes.length ? row.eventTypes.join(', ') : humanize('all')}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'rotated', header: 'Rotated', render: (row) => <span className="text-[11px] text-slate-500">{row.rotatedAt ? formatDateTime(row.rotatedAt) : t('common.never')}</span> },
    { key: 'actions', header: '', searchable: false, render: (row) => (
      <button
        type="button"
        className="btn-secondary !px-2.5 !py-1.5 text-[11px]"
        disabled={rotate.isPending}
        onClick={() => { setError(null); rotate.mutate(row); }}
      >
        <RefreshCw size={12} /> {t('webhooks.rotate')}
      </button>
    ) }
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        title={t('webhooks.title')}
        subtitle={t('webhooks.subtitle')}
        actions={
          <button type="button" className="btn-primary" onClick={() => { setError(null); setCreateOpen(true); }}>
            <Plus size={15} /> {t('webhooks.createEndpoint')}
          </button>
        }
      />

      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-xl border border-white/10 bg-white/[0.03] p-1">
          {(['events', 'endpoints'] as const).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setTab(item)}
              className={`rounded-lg px-3 py-1.5 text-[11px] font-medium transition ${tab === item ? 'bg-cyan-400/15 text-cyan-200' : 'text-slate-500 hover:text-slate-200'}`}
            >
              {item === 'events' ? t('webhooks.events') : t('webhooks.endpoints')}
            </button>
          ))}
        </div>
        {tab === 'endpoints' ? (
          <input
            className="input w-auto !py-2 text-xs"
            inputMode="numeric"
            placeholder={t('form.tenantId')}
            value={tenantId}
            onChange={(event) => setTenantId(event.target.value)}
          />
        ) : null}
      </div>

      {error ? <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-2.5 text-xs text-rose-200">{error}</p> : null}

      {tab === 'events' ? (
        <DataTable
          columns={eventColumns}
          rows={events.data?.items ?? []}
          loading={events.isLoading}
          error={events.error ? events.error.message : null}
          onRetry={() => events.refetch()}
          emptyTitle={t('common.noData')}
        />
      ) : (
        <DataTable
          columns={endpointColumns}
          rows={endpoints.data?.items ?? []}
          loading={endpoints.isLoading}
          error={endpoints.error ? endpoints.error.message : null}
          onRetry={() => endpoints.refetch()}
          emptyTitle={tenantId ? t('common.noData') : 'Enter a tenant ID to load endpoints'}
        />
      )}

      <Modal
        open={createOpen}
        title={t('webhooks.createEndpoint')}
        onClose={() => setCreateOpen(false)}
        footer={
          <div className="flex justify-end gap-2">
            <button type="button" className="btn-secondary" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</button>
            <button
              type="button"
              className="btn-primary"
              disabled={createEndpoint.isPending || !form.tenantId || !form.endpointUrl}
              onClick={() => { setError(null); createEndpoint.mutate(); }}
            >
              {createEndpoint.isPending ? '…' : t('form.create')}
            </button>
          </div>
        }
      >
        <div className="space-y-4">
          <Field label={t('form.tenantId')}>
            <input className="input" inputMode="numeric" value={form.tenantId} onChange={(event) => setForm({ ...form, tenantId: event.target.value })} />
          </Field>
          <Field label={t('webhooks.endpointUrl')} hint="Public HTTPS only; private networks are rejected.">
            <input className="input mono" value={form.endpointUrl} onChange={(event) => setForm({ ...form, endpointUrl: event.target.value })} placeholder="https://partner.example.com/webhooks" />
          </Field>
          <Field label={t('webhooks.eventTypes')} hint={availableEventTypes.join(', ')}>
            <input className="input mono" value={form.eventTypes} onChange={(event) => setForm({ ...form, eventTypes: event.target.value })} placeholder="deposit.confirmed,withdrawal.broadcast" />
          </Field>
        </div>
      </Modal>

      <Modal open={Boolean(secret)} title={t('webhooks.secretOnce')} onClose={() => setSecret(null)}>
        <Panel className="border-amber-400/20 bg-amber-400/[0.05] p-3 text-[11px] text-amber-200">
          This signing secret is shown once. Verify deliveries with the <span className="mono">X-Blackchin-Signature</span> header.
        </Panel>
        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-white/10 bg-ink-900/80 p-3">
          <span className="mono break-all text-xs text-cyan-100">{secret}</span>
          {secret ? <CopyButton value={secret} /> : null}
        </div>
      </Modal>
    </div>
  );
}