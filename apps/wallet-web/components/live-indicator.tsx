'use client';

import clsx from 'clsx';

import { useI18n } from '@/lib/i18n';
import type { StreamStatus } from '@/lib/realtime';

const config: Record<StreamStatus, { dot: string; text: string; key: string }> = {
  connecting: { dot: 'bg-amber-400 animate-pulse-soft', text: 'text-amber-300', key: 'common.loading' },
  live: { dot: 'bg-emerald-400', text: 'text-emerald-300', key: 'common.live' },
  reconnecting: { dot: 'bg-amber-400 animate-pulse-soft', text: 'text-amber-300', key: 'common.reconnecting' },
  offline: { dot: 'bg-rose-400', text: 'text-rose-300', key: 'common.offline' }
};

export function LiveIndicator({ status }: { status: StreamStatus }) {
  const { t } = useI18n();
  const current = config[status];

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.03] px-3 py-1.5 text-[11px] font-medium">
      <span className={clsx('h-1.5 w-1.5 rounded-full', current.dot)} />
      <span className={current.text}>{t(current.key)}</span>
    </span>
  );
}