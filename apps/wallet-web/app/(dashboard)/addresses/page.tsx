'use client';

import { useQuery } from '@tanstack/react-query';
import { QRCodeSVG } from 'qrcode.react';
import { useState } from 'react';

import { CopyButton } from '@/components/copy-button';
import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Modal } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, humanize, shortAddress } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { AddressRecord, ListResponse } from '@/lib/types';

export default function AddressesPage() {
  const { t } = useI18n();
  const [qr, setQr] = useState<AddressRecord | null>(null);

  const addresses = useQuery({
    queryKey: ['addresses'],
    queryFn: () => api.get<ListResponse<AddressRecord>>('/addresses', { limit: 200 })
  });

  const columns: Column<AddressRecord>[] = [
    { key: 'publicKey', header: t('common.address'), render: (row) => (
      <div className="flex items-center gap-2">
        <span className="mono text-slate-200">{shortAddress(row.publicKey, 8)}</span>
        <CopyButton value={row.publicKey} label="" />
      </div>
    ) },
    { key: 'type', header: t('common.type'), render: (row) => <span className="chip border-white/10 bg-white/[0.04] text-slate-300">{humanize(row.walletType)}</span> },
    { key: 'parent', header: t('child.parent'), render: (row) => <span className="mono text-slate-400">{row.hdWalletId ? `#${row.hdWalletId} · ${row.accountIndex}` : '—'}</span> },
    { key: 'tenant', header: t('common.tenant'), render: (row) => <span className="mono text-slate-400">{row.tenantId ?? 'legacy'}</span> },
    { key: 'network', header: t('common.network'), render: (row) => <span className="text-slate-300">{row.network ?? '—'}</span> },
    { key: 'status', header: t('common.status'), render: (row) => <StatusBadge status={row.status} /> },
    { key: 'created', header: t('common.created'), render: (row) => <span className="text-[11px] text-slate-500">{formatDateTime(row.createdAt)}</span> },
    { key: 'qr', header: '', searchable: false, render: (row) => (
      <button type="button" className="btn-secondary !px-2.5 !py-1.5 text-[11px]" onClick={() => setQr(row)}>QR</button>
    ) }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('addresses.title')} subtitle={t('addresses.subtitle')} />
      <DataTable
        columns={columns}
        rows={addresses.data?.items ?? []}
        loading={addresses.isLoading}
        error={addresses.error ? addresses.error.message : null}
        onRetry={() => addresses.refetch()}
        emptyTitle={t('common.noData')}
      />

      <Modal open={Boolean(qr)} title={t('addresses.qr')} onClose={() => setQr(null)}>
        {qr ? (
          <div className="flex flex-col items-center gap-4">
            <div className="rounded-2xl bg-white p-4">
              <QRCodeSVG value={qr.publicKey} size={180} level="M" />
            </div>
            <p className="mono break-all text-center text-xs text-slate-300">{qr.publicKey}</p>
            <CopyButton value={qr.publicKey} label={t('common.copy')} />
          </div>
        ) : null}
      </Modal>
    </div>
  );
}