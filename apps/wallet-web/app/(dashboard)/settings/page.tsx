'use client';

import { useQuery } from '@tanstack/react-query';
import { Globe, Info, ShieldCheck, User } from 'lucide-react';

import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { Panel } from '@/components/ui';
import { api } from '@/lib/api';
import { formatDateTime } from '@/lib/format';
import { useI18n } from '@/lib/i18n';
import type { SessionResponse } from '@/lib/types';

export default function SettingsPage() {
  const { t, locale, setLocale } = useI18n();

  const session = useQuery({
    queryKey: ['session'],
    queryFn: () => api.get<SessionResponse>('/auth/session'),
    staleTime: 60_000
  });

  return (
    <div className="space-y-6">
      <PageHeader title={t('settings.title')} subtitle={t('settings.subtitle')} />

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel className="p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200"><Globe size={15} className="text-cyan-300" /> {t('settings.appearance')}</h2>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setLocale('en')} className={locale === 'en' ? 'btn-primary !py-2' : 'btn-secondary !py-2'}>English</button>
            <button type="button" onClick={() => setLocale('fa')} className={locale === 'fa' ? 'btn-primary !py-2' : 'btn-secondary !py-2'}>فارسی</button>
          </div>
          <p className="mt-3 text-[11px] text-slate-500">Persian switches the entire dashboard to RTL layout.</p>
        </Panel>

        <Panel className="p-5">
          <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200"><User size={15} className="text-cyan-300" /> {t('settings.session')}</h2>
          {session.data ? (
            <div className="space-y-3 text-xs">
              <div className="flex items-center justify-between"><span className="text-slate-500">{t('common.email')}</span><span className="text-slate-200">{session.data.user.email}</span></div>
              <div className="flex items-center justify-between"><span className="text-slate-500">{t('common.role')}</span><StatusBadge status="active" label={t(`common.${session.data.user.role}`)} /></div>
              <div className="flex items-center justify-between"><span className="text-slate-500">Expires</span><span className="text-slate-300">{formatDateTime(session.data.expiresAt)}</span></div>
              <div className="flex items-center justify-between"><span className="text-slate-500">Last login</span><span className="text-slate-300">{session.data.user.lastLoginAt ? formatDateTime(session.data.user.lastLoginAt) : '—'}</span></div>
            </div>
          ) : <p className="text-xs text-slate-500">{t('common.loading')}…</p>}
        </Panel>
      </div>

      <Panel className="p-5">
        <h2 className="mb-4 flex items-center gap-2 text-sm font-semibold text-slate-200"><Info size={15} className="text-cyan-300" /> {t('settings.notes')}</h2>
        <ul className="space-y-3 text-xs text-slate-400">
          <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-emerald-400" /> {t('settings.note1')}</li>
          <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-amber-400" /> {t('settings.note2')}</li>
          <li className="flex gap-2"><ShieldCheck size={14} className="mt-0.5 shrink-0 text-slate-400" /> {t('settings.note3')}</li>
        </ul>
      </Panel>
    </div>
  );
}