'use client';

export function PageHeader({
  title,
  subtitle,
  actions
}: {
  title: string;
  subtitle?: string;
  actions?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4 border-b border-white/[0.08] pb-5 md:flex-row md:items-end md:justify-between">
      <div className="min-w-0">
        <h1 className="flex items-center text-2xl font-bold tracking-tight text-white md:text-[30px]">
          <span aria-hidden="true" className="me-3 inline-block h-7 w-1 shrink-0 rounded-full bg-gradient-to-b from-cyan-300 to-violet-500 shadow-[0_0_18px_rgba(34,211,238,0.25)]" />
          <span>{title}</span>
        </h1>
        {subtitle ? <p className="mt-2 max-w-2xl text-[15px] leading-6 text-slate-400">{subtitle}</p> : null}
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2 rounded-xl border border-white/[0.07] bg-white/[0.025] p-1.5">{actions}</div> : null}
    </div>
  );
}