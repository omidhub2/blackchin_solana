'use client';

import clsx from 'clsx';
import type { LucideIcon } from 'lucide-react';

export function StatCard({
  label,
  value,
  hint,
  icon: Icon,
  accent = 'cyan'
}: {
  label: string;
  value: string | number;
  hint?: string;
  icon: LucideIcon;
  accent?: 'cyan' | 'blue' | 'violet' | 'emerald' | 'amber' | 'rose';
}) {
  const accents: Record<string, string> = {
    cyan: 'from-cyan-400/20 to-cyan-400/0 text-cyan-300',
    blue: 'from-electric-400/20 to-electric-400/0 text-electric-400',
    violet: 'from-violet-400/20 to-violet-400/0 text-violet-300',
    emerald: 'from-emerald-400/20 to-emerald-400/0 text-emerald-300',
    amber: 'from-amber-400/20 to-amber-400/0 text-amber-300',
    rose: 'from-rose-400/20 to-rose-400/0 text-rose-300'
  };

  return (
    <div className="panel panel-hover relative overflow-hidden p-5 md:p-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-slate-400">{label}</p>
          <p className="mt-3 text-[26px] font-bold tabular-nums tracking-tight text-white md:text-[28px]">{value}</p>
          {hint ? <p className="mt-2 text-xs text-slate-400">{hint}</p> : null}
        </div>
        <span className={clsx('rounded-xl border border-white/[0.09] bg-white/[0.045] p-3 shadow-inner', accents[accent])}>
          <Icon size={18} />
        </span>
      </div>
    </div>
  );
}