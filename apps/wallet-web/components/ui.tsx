'use client';

import clsx from 'clsx';
import { X } from 'lucide-react';
import { useEffect } from 'react';

export function Panel({ className, children }: { className?: string; children: React.ReactNode }) {
  return <div className={clsx('panel', className)}>{children}</div>;
}

export function Field({
  label,
  hint,
  children,
  className
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={clsx('block', className)}>
      <span className="field-label">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-xs text-slate-500">{hint}</span> : null}
    </label>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer
}: {
  open: boolean;
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  footer?: React.ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-ink-950/80 backdrop-blur-sm"
      />
      <div className="panel relative z-10 w-full max-w-lg overflow-hidden">
        <div className="flex items-center justify-between border-b border-white/[0.06] px-5 py-4">
          <h2 className="text-base font-semibold text-slate-100">{title}</h2>
          <button type="button" onClick={onClose} className="btn-ghost !p-1.5" aria-label="Close">
            <X size={16} />
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-5">{children}</div>
        {footer ? <div className="border-t border-white/[0.06] px-5 py-4">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Spinner({ size = 16 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin rounded-full border-2 border-white/20 border-t-cyan-400"
      style={{ width: size, height: size }}
    />
  );
}

export function InlineError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-rose-500/20 bg-rose-500/[0.06] px-4 py-3 text-sm text-rose-200">
      <span>{message}</span>
      {onRetry ? (
        <button type="button" onClick={onRetry} className="btn-secondary !px-3 !py-1.5 text-xs">
          Retry
        </button>
      ) : null}
    </div>
  );
}

export function EmptyState({ title, description }: { title: string; description?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 px-6 py-14 text-center">
      <div className="h-10 w-10 rounded-full border border-white/10 bg-white/[0.03]" />
      <p className="text-base font-medium text-slate-300">{title}</p>
      {description ? <p className="max-w-sm text-sm text-slate-500">{description}</p> : null}
    </div>
  );
}

export function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-base font-semibold tracking-tight text-slate-200">{children}</h2>
      {action}
    </div>
  );
}