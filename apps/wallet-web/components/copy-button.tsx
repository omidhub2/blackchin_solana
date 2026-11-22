'use client';

import { Check, Copy } from 'lucide-react';
import { useState } from 'react';

import { useI18n } from '@/lib/i18n';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  }

  return (
    <button
      type="button"
      onClick={copy}
      className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.03] px-2 py-1 text-[11px] text-slate-400 transition hover:border-cyan-400/30 hover:text-cyan-200"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
      {label ?? (copied ? t('common.copied') : t('common.copy'))}
    </button>
  );
}