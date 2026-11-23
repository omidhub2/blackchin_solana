'use client';

import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { DataTable, type Column } from '@/components/data-table';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Field, Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime, formatSol } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type {
  ChildWallet,
  CredentialRecord,
  HotWallet,
  ListResponse,
  PolicyRecord,
  TenantRecord,
  TenantWithdrawalPolicy,
  WithdrawalApproval,
  WithdrawalDestination
} from '@/lib/types';

type SecurityResponse = {
  policies: PolicyRecord[];
  credentials: CredentialRecord[];
  hotWallets: HotWallet[];
};

const inputClass = 'field-input w-full';
const selectClass = 'field-input w-full';

export default function SecurityPage() {
  const { t } = useI18n();
  const queryClient = useQueryClient();

  const [tenantId, setTenantId] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [maxSingleLamports, setMaxSingleLamports] = useState('');
  const [maxDailyLamports, setMaxDailyLamports] = useState('');
  const [maxWeeklyLamports, setMaxWeeklyLamports] = useState('');
  const [maxDailyCount, setMaxDailyCount] = useState('5');
  const [maxWeeklyCount, setMaxWeeklyCount] = useState('20');
  const [freezeReason, setFreezeReason] = useState('');
  const [destinationAddress, setDestinationAddress] = useState('');
  const [destinationLabel, setDestinationLabel] = useState('');
  const [network, setNetwork] = useState('devnet');
  const [approvalCredentialId, setApprovalCredentialId] = useState('');
  const [approvalWallet, setApprovalWallet] = useState('');
  const [approvalDestination, setApprovalDestination] = useState('');
  const [approvalReference, setApprovalReference] = useState('');
  const [approvalAmountSol, setApprovalAmountSol] = useState('');
  const [approvalExpiry, setApprovalExpiry] = useState('300');

  const security = useQuery({
    queryKey: ['security'],
    queryFn: () => api.get<SecurityResponse>('/security', { limit: 200 })
  });
  const tenants = useQuery({
    queryKey: ['tenants'],
    queryFn: () => api.get<ListResponse<TenantRecord>>('/tenants', { limit: 200 })
  });

  useEffect(() => {
    if (!tenantId && tenants.data?.items[0]) setTenantId(tenants.data.items[0].id);
  }, [tenantId, tenants.data]);

  const policy = useQuery({
    queryKey: ['tenant-withdrawal-policy', tenantId],
    queryFn: () => api.get<TenantWithdrawalPolicy | null>(`/tenants/${tenantId}/withdrawal-policy`),
    enabled: Boolean(tenantId)
  });
  const destinations = useQuery({
    queryKey: ['tenant-withdrawal-destinations', tenantId],
    queryFn: () => api.get<ListResponse<WithdrawalDestination>>(`/tenants/${tenantId}/withdrawal-destinations`),
    enabled: Boolean(tenantId)
  });
  const childWallets = useQuery({
    queryKey: ['tenant-child-wallets', tenantId],
    queryFn: () => api.get<{ type: string; items: ChildWallet[] }>('/wallets', { type: 'child', tenantId }),
    enabled: Boolean(tenantId)
  });
  const approvals = useQuery({
    queryKey: ['tenant-withdrawal-approvals', tenantId],
    queryFn: () => api.get<ListResponse<WithdrawalApproval>>(`/tenants/${tenantId}/withdrawal-approvals`),
    enabled: Boolean(tenantId)
  });

  useEffect(() => {
    if (policy.data) {
      setEnabled(policy.data.enabled);
      setMaxSingleLamports(policy.data.maxSingleLamports);
      setMaxDailyLamports(policy.data.maxDailyLamports);
      setMaxWeeklyLamports(policy.data.maxWeeklyLamports);
      setMaxDailyCount(String(policy.data.maxDailyCount));
      setMaxWeeklyCount(String(policy.data.maxWeeklyCount));
      setFreezeReason(policy.data.freezeReason ?? '');
    } else if (policy.isSuccess) {
      setEnabled(false);
      setMaxSingleLamports('');
      setMaxDailyLamports('');
      setMaxWeeklyLamports('');
      setMaxDailyCount('5');
      setMaxWeeklyCount('20');
      setFreezeReason('');
    }
  }, [policy.data, policy.isSuccess]);

  const tenantCredentials = (security.data?.credentials ?? []).filter((credential) =>
    credential.tenantId === tenantId &&
    credential.status === 'active' &&
    credential.scopes.includes('withdrawals:submit')
  );
  const activeDestinations = (destinations.data?.items ?? []).filter((destination) =>
    destination.status === 'active'
  );
  const activeWallets = (childWallets.data?.items ?? []).filter((wallet) =>
    wallet.status === 'active' && wallet.network === network
  );

  useEffect(() => {
    if (!approvalCredentialId && tenantCredentials[0]) setApprovalCredentialId(tenantCredentials[0].id);
  }, [approvalCredentialId, tenantCredentials]);
  useEffect(() => {
    if (!approvalWallet && activeWallets[0]) setApprovalWallet(activeWallets[0].publicKey);
  }, [approvalWallet, activeWallets]);
  useEffect(() => {
    if (!approvalDestination && activeDestinations[0]) setApprovalDestination(activeDestinations[0].destinationPublicKey);
  }, [approvalDestination, activeDestinations]);

  const refreshPolicyData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['tenant-withdrawal-policy', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['tenant-withdrawal-destinations', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['tenant-withdrawal-approvals', tenantId] }),
      queryClient.invalidateQueries({ queryKey: ['security'] }),
      queryClient.invalidateQueries({ queryKey: ['tenants'] })
    ]);
  };

  const configure = useMutation({
    mutationFn: () => api.put<TenantWithdrawalPolicy>(`/tenants/${tenantId}/withdrawal-policy`, {
      enabled,
      maxSingleLamports,
      maxDailyLamports,
      maxWeeklyLamports,
      maxDailyCount: Number(maxDailyCount),
      maxWeeklyCount: Number(maxWeeklyCount)
    }),
    onSuccess: refreshPolicyData
  });
  const freeze = useMutation({
    mutationFn: () => api.post(`/tenants/${tenantId}/withdrawal-policy/freeze`, { reason: freezeReason }),
    onSuccess: refreshPolicyData
  });
  const unfreeze = useMutation({
    mutationFn: () => api.post(`/tenants/${tenantId}/withdrawal-policy/unfreeze`, {}),
    onSuccess: refreshPolicyData
  });
  const addDestination = useMutation({
    mutationFn: () => api.post<{ destination: WithdrawalDestination }>(`/tenants/${tenantId}/withdrawal-destinations`, {
      network, destinationPublicKey: destinationAddress, label: destinationLabel || undefined
    }),
    onSuccess: async () => {
      setDestinationAddress('');
      setDestinationLabel('');
      await refreshPolicyData();
    }
  });
  const activateDestination = useMutation({
    mutationFn: (id: string) => api.post(`/tenants/${tenantId}/withdrawal-destinations/${id}/activate`, {}),
    onSuccess: refreshPolicyData
  });
  const revokeDestination = useMutation({
    mutationFn: (id: string) => api.post(`/tenants/${tenantId}/withdrawal-destinations/${id}/revoke`, {}),
    onSuccess: refreshPolicyData
  });
  const revokeApproval = useMutation({
    mutationFn: (reference: string) => api.post(
      `/tenants/${tenantId}/withdrawal-approvals/${encodeURIComponent(reference)}/revoke`, {}
    ),
    onSuccess: refreshPolicyData
  });
  const issueApproval = useMutation({
    mutationFn: () => api.post(`/tenants/${tenantId}/withdrawal-approvals`, {
      credentialId: approvalCredentialId,
      approvalReference,
      walletPublicKey: approvalWallet,
      destinationPublicKey: approvalDestination,
      network,
      amountSol: approvalAmountSol,
      expiresInSeconds: Number(approvalExpiry)
    }),
    onSuccess: async () => {
      setApprovalReference('');
      setApprovalAmountSol('');
      await refreshPolicyData();
    }
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

  const mutationError = configure.error ?? freeze.error ?? unfreeze.error ??
    addDestination.error ?? activateDestination.error ?? revokeDestination.error ?? issueApproval.error ?? revokeApproval.error;

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

      <Panel className="space-y-4 p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-sm font-semibold text-slate-200">{t('security.withdrawalControl')}</h2>
          <div className="w-full max-w-xs">
            <select className={selectClass} value={tenantId} onChange={(event) => {
              setTenantId(event.target.value);
              setApprovalCredentialId('');
              setApprovalWallet('');
              setApprovalDestination('');
            }}>
              <option value="">{t('security.selectTenant')}</option>
              {(tenants.data?.items ?? []).map((tenant) => (
                <option key={tenant.id} value={tenant.id}>{tenant.displayName} · #{tenant.id}</option>
              ))}
            </select>
          </div>
        </div>

        {tenantId ? (
          <>
            <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
              <Field label={t('security.maxSingle')}>
                <input className={inputClass} inputMode="numeric" value={maxSingleLamports} onChange={(event) => setMaxSingleLamports(event.target.value)} placeholder="Lamports" />
              </Field>
              <Field label={t('security.maxDaily')}>
                <input className={inputClass} inputMode="numeric" value={maxDailyLamports} onChange={(event) => setMaxDailyLamports(event.target.value)} placeholder="Lamports" />
              </Field>
              <Field label={t('security.maxWeekly')}>
                <input className={inputClass} inputMode="numeric" value={maxWeeklyLamports} onChange={(event) => setMaxWeeklyLamports(event.target.value)} placeholder="Lamports" />
              </Field>
              <Field label={t('security.maxDailyCount')}>
                <input className={inputClass} type="number" min="1" value={maxDailyCount} onChange={(event) => setMaxDailyCount(event.target.value)} />
              </Field>
              <Field label={t('security.maxWeeklyCount')}>
                <input className={inputClass} type="number" min="1" value={maxWeeklyCount} onChange={(event) => setMaxWeeklyCount(event.target.value)} />
              </Field>
              <label className="flex items-center gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3 text-sm text-slate-300">
                <input type="checkbox" checked={enabled} onChange={(event) => setEnabled(event.target.checked)} />
                {t('security.enablePolicy')}
              </label>
            </div>
            <p className="text-xs text-amber-300/80">{t('security.policyFrozenNote')}</p>
            <div className="flex flex-wrap items-center gap-2">
              <button type="button" className="btn-primary" disabled={configure.isPending} onClick={() => configure.mutate()}>
                {configure.isPending ? t('common.loading') : t('common.save')}
              </button>
              {policy.data?.emergencyFrozen ? (
                <button type="button" className="btn-secondary" disabled={unfreeze.isPending || !policy.data.enabled} onClick={() => unfreeze.mutate()}>
                  {unfreeze.isPending ? t('common.loading') : t('security.unfreeze')}
                </button>
              ) : (
                <button type="button" className="btn-secondary" disabled={freeze.isPending || !freezeReason.trim()} onClick={() => freeze.mutate()}>
                  {freeze.isPending ? t('common.loading') : t('security.freeze')}
                </button>
              )}
              {policy.data?.emergencyFrozen && policy.data.freezeReason ? (
                <span className="text-xs text-amber-300/80">{policy.data.freezeReason}</span>
              ) : null}
            </div>
            {!policy.data?.emergencyFrozen ? (
              <Field label={t('security.freezeReason')}>
                <input className={inputClass} value={freezeReason} onChange={(event) => setFreezeReason(event.target.value)} maxLength={500} />
              </Field>
            ) : null}
            {policy.isLoading ? <p className="text-xs text-slate-500">{t('common.loading')}</p> : null}
          </>
        ) : (
          <p className="text-sm text-slate-500">{t('security.selectTenant')}</p>
        )}
      </Panel>

      {tenantId ? (
        <Panel className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-200">{t('security.destinationTitle')}</h2>
          <div className="grid gap-3 md:grid-cols-3">
            <Field label={t('common.network')}>
              <select className={selectClass} value={network} onChange={(event) => setNetwork(event.target.value)}>
                <option value="devnet">Devnet</option>
                <option value="testnet">Testnet</option>
                <option value="mainnet-beta">Mainnet Beta</option>
              </select>
            </Field>
            <Field label={t('security.destinationAddress')}>
              <input className={inputClass} value={destinationAddress} onChange={(event) => setDestinationAddress(event.target.value)} placeholder="Solana public key" />
            </Field>
            <Field label={t('security.destinationLabel')}>
              <input className={inputClass} value={destinationLabel} onChange={(event) => setDestinationLabel(event.target.value)} maxLength={100} />
            </Field>
          </div>
          <button type="button" className="btn-primary" disabled={addDestination.isPending || !destinationAddress.trim()} onClick={() => addDestination.mutate()}>
            {addDestination.isPending ? t('common.loading') : t('security.addDestination')}
          </button>
          <p className="text-xs text-slate-500">{t('security.secondApprover')}</p>
          <div className="space-y-2">
            {(destinations.data?.items ?? []).map((destination) => (
              <div key={destination.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
                <div className="min-w-0">
                  <p className="text-sm text-slate-200">{destination.label || destination.destinationPublicKey.slice(0, 8) + '…'} <span className="text-xs text-slate-500">· {destination.network}</span></p>
                  <p className="mono truncate text-xs text-slate-500">{destination.destinationPublicKey}</p>
                  {destination.approvedBy ? <p className="text-[11px] text-slate-500">Approved by {destination.approvedBy}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={destination.status} />
                  {destination.status === 'pending' ? (
                    <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" disabled={activateDestination.isPending} onClick={() => activateDestination.mutate(destination.id)}>
                      {t('security.activate')}
                    </button>
                  ) : null}
                  {destination.status !== 'revoked' ? (
                    <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" disabled={revokeDestination.isPending} onClick={() => revokeDestination.mutate(destination.id)}>
                      {t('security.revoke')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {(destinations.data?.items ?? []).length === 0 ? <p className="text-sm text-slate-500">{t('security.noDestinations')}</p> : null}
          </div>
        </Panel>
      ) : null}

      {tenantId ? (
        <Panel className="space-y-4 p-5">
          <h2 className="text-sm font-semibold text-slate-200">{t('security.approvalTitle')}</h2>
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <Field label={t('security.approvalCredential')}>
              <select className={selectClass} value={approvalCredentialId} onChange={(event) => setApprovalCredentialId(event.target.value)}>
                <option value="">Select credential</option>
                {tenantCredentials.map((credential) => (
                  <option key={credential.id} value={credential.id}>{credential.keyPrefix} · #{credential.id}</option>
                ))}
              </select>
            </Field>
            <Field label={t('security.approvalWallet')}>
              <select className={selectClass} value={approvalWallet} onChange={(event) => setApprovalWallet(event.target.value)}>
                <option value="">Select source wallet</option>
                {activeWallets.map((wallet) => (
                  <option key={wallet.id} value={wallet.publicKey}>{wallet.publicKey.slice(0, 10)}… · #{wallet.id}</option>
                ))}
              </select>
            </Field>
            <Field label={t('security.approvalDestination')}>
              <select className={selectClass} value={approvalDestination} onChange={(event) => setApprovalDestination(event.target.value)}>
                <option value="">Select approved destination</option>
                {activeDestinations.filter((destination) => destination.network === network).map((destination) => (
                  <option key={destination.id} value={destination.destinationPublicKey}>{destination.label || destination.destinationPublicKey.slice(0, 10) + '…'}</option>
                ))}
              </select>
            </Field>
            <Field label={t('security.approvalReference')}>
              <input className={inputClass} value={approvalReference} onChange={(event) => setApprovalReference(event.target.value)} minLength={8} maxLength={128} />
            </Field>
            <Field label={t('security.approvalAmount')}>
              <input className={inputClass} inputMode="decimal" value={approvalAmountSol} onChange={(event) => setApprovalAmountSol(event.target.value)} placeholder="0.1" />
            </Field>
            <Field label={t('security.approvalExpiry')}>
              <select className={selectClass} value={approvalExpiry} onChange={(event) => setApprovalExpiry(event.target.value)}>
                <option value="60">1 minute</option>
                <option value="300">5 minutes</option>
                <option value="600">10 minutes</option>
                <option value="900">15 minutes</option>
              </select>
            </Field>
          </div>
          <button type="button" className="btn-primary" disabled={
            issueApproval.isPending || !policy.data?.enabled || policy.data.emergencyFrozen ||
            !approvalCredentialId || !approvalWallet || !approvalDestination ||
            !approvalReference.trim() || !approvalAmountSol.trim()
          } onClick={() => issueApproval.mutate()}>
            {issueApproval.isPending ? t('common.loading') : t('security.issueApproval')}
          </button>
          <p className="text-xs text-slate-500">Approval is bound to one tenant credential, one source wallet, one allowlisted destination and one exact SOL amount. It expires automatically.</p>
        </Panel>
      ) : null}

      {tenantId ? (
        <Panel className="space-y-3 p-5">
          <h2 className="text-sm font-semibold text-slate-200">{t('security.approvalHistory')}</h2>
          <div className="space-y-2">
            {(approvals.data?.items ?? []).map((approval) => (
              <div key={approval.approvalReference} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-white/[0.06] bg-white/[0.02] px-3 py-3">
                <div className="min-w-0 space-y-1">
                  <p className="mono break-all text-xs text-slate-200">{approval.approvalReference}</p>
                  <p className="text-xs text-slate-400">{formatSol(approval.amountLamports)} SOL · {approval.network} · Credential #{approval.credentialId}</p>
                  <p className="mono truncate text-[11px] text-slate-500">{approval.walletPublicKey} → {approval.destinationPublicKey}</p>
                  <p className="text-[11px] text-slate-500">Expires {formatDateTime(approval.expiresAt)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <StatusBadge status={approval.status} />
                  {approval.status === 'approved' ? (
                    <button type="button" className="btn-secondary !px-3 !py-1.5 text-xs" disabled={revokeApproval.isPending} onClick={() => revokeApproval.mutate(approval.approvalReference)}>
                      {t('security.revokeApproval')}
                    </button>
                  ) : null}
                </div>
              </div>
            ))}
            {(approvals.data?.items ?? []).length === 0 ? <p className="text-sm text-slate-500">{t('common.noData')}</p> : null}
          </div>
        </Panel>
      ) : null}

      {mutationError ? <p className="rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">{mutationError.message}</p> : null}

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
