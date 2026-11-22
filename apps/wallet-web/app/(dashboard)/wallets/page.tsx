'use client';

import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Flame, GitBranch, Layers } from 'lucide-react';
import Link from 'next/link';

import { PageHeader } from '@/components/page-header';
import { StatCard } from '@/components/stat-card';
import { api } from '@/lib/api';
import { useI18n } from '@/lib/i18n';
import type { ChildWallet, HdWallet, HotWallet, ListResponse } from '@/lib/types';

export default function WalletsPage() {
  const { t } = useI18n();

  const hd = useQuery({ queryKey: ['wallets', 'hd'], queryFn: () => api.get<ListResponse<HdWallet>>('/wallets', { type: 'hd', limit: 200 }) });
  const child = useQuery({ queryKey: ['wallets', 'child'], queryFn: () => api.get<ListResponse<ChildWallet>>('/wallets', { type: 'child', limit: 200 }) });
  const hot = useQuery({ queryKey: ['wallets', 'hot'], queryFn: () => api.get<ListResponse<HotWallet>>('/wallets', { type: 'hot', limit: 200 }) });

  const cards = [
    { href: '/hd-wallets', label: t('overview.hdWallets'), value: hd.data?.items.length ?? 0, icon: Layers, accent: 'cyan' as const },
    { href: '/child-wallets', label: t('overview.childWallets'), value: child.data?.items.length ?? 0, icon: GitBranch, accent: 'blue' as const },
    { href: '/hot-wallets', label: t('overview.hotWallets'), value: hot.data?.items.length ?? 0, icon: Flame, accent: 'amber' as const }
  ];

  return (
    <div className="space-y-6">
      <PageHeader title={t('wallets.title')} subtitle={t('wallets.subtitle')} />

      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((card) => (
          <Link key={card.href} href={card.href} className="group">
            <StatCard label={card.label} value={card.value} icon={card.icon} accent={card.accent} />
            <span className="mt-2 inline-flex items-center gap-1 text-[11px] text-slate-500 transition group-hover:text-cyan-300">
              {t('common.details')} <ArrowRight size={12} className="rtl:rotate-180" />
            </span>
          </Link>
        ))}
      </div>

      <div className="panel p-5">
        <h2 className="mb-3 text-sm font-semibold text-slate-200">{t('overview.addressGrowth')}</h2>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            { label: t('overview.registeredAddresses'), value: (hd.data?.items.reduce((sum, item) => sum + item.childCount, 0) ?? 0) },
            { label: t('overview.monitoredAddresses'), value: child.data?.items.filter((item) => item.status === 'active').length ?? 0 },
            { label: t('common.frozen'), value: hot.data?.items.filter((item) => item.status === 'frozen').length ?? 0 },
            { label: t('common.active'), value: hot.data?.items.filter((item) => item.status === 'active').length ?? 0 }
          ].map((item) => (
            <div key={item.label} className="panel-muted p-4">
              <p className="text-[10px] uppercase tracking-[0.16em] text-slate-500">{item.label}</p>
              <p className="mt-1.5 text-xl font-semibold text-white">{item.value}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}