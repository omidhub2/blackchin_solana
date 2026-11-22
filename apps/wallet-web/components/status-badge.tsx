'use client';

import clsx from 'clsx';

import { humanize, statusTone } from '@/lib/format';

const tones: Record<string, string> = {
  emerald: 'border-emerald-400/20 bg-emerald-400/10 text-emerald-300',
  amber: 'border-amber-400/20 bg-amber-400/10 text-amber-300',
  rose: 'border-rose-400/20 bg-rose-400/10 text-rose-300',
  violet: 'border-violet-400/20 bg-violet-400/10 text-violet-300',
  slate: 'border-white/10 bg-white/[0.04] text-slate-400'
};

export function StatusBadge({ status, label }: { status: string | null | undefined; label?: string }) {
  const tone = tones[statusTone(status)] ?? tones.slate;
  return (
    <span className={clsx('chip', tone)}>
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {label ?? humanize(status)}
    </span>
  );
}