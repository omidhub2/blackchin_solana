'use client';

import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useMemo, useState } from 'react';

import { useI18n } from '@/lib/i18n';
import { EmptyState, InlineError } from '@/components/ui';

export type Column<T> = {
  key: string;
  header: string;
  render: (row: T) => React.ReactNode;
  className?: string;
  searchable?: boolean;
};

export function DataTable<T>({
  columns,
  rows,
  loading = false,
  error = null,
  onRetry,
  emptyTitle,
  pageSize = 10,
  searchable = true,
  toolbar
}: {
  columns: Column<T>[];
  rows: T[];
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
  emptyTitle?: string;
  pageSize?: number;
  searchable?: boolean;
  toolbar?: React.ReactNode;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);

  const filtered = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return rows;
    return rows.filter((row) => {
      const haystack = columns
        .filter((column) => column.searchable !== false)
        .map((column) => {
          const rendered = column.render(row);
          return typeof rendered === 'string' || typeof rendered === 'number' ? String(rendered) : '';
        })
        .join(' ')
        .toLowerCase();
      return haystack.includes(normalized);
    });
  }, [columns, query, rows]);

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize));
  const safePage = Math.min(page, pageCount - 1);
  const visible = filtered.slice(safePage * pageSize, safePage * pageSize + pageSize);

  if (error) {
    return <InlineError message={error} onRetry={onRetry} />;
  }

  return (
    <div className="panel overflow-hidden">
      {(searchable || toolbar) ? (
        <div className="flex flex-col gap-3 border-b border-white/[0.06] px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
          {searchable ? (
            <div className="relative w-full sm:max-w-xs">
              <Search size={14} className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-slate-500" />
              <input
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setPage(0);
                }}
                placeholder={t('common.search')}
                className="input !py-2 ps-9 text-xs"
              />
            </div>
          ) : <span />}
          {toolbar}
        </div>
      ) : null}

      {loading ? (
        <div className="space-y-2 p-4">
          {Array.from({ length: 6 }).map((_, index) => (
            <div key={index} className="skeleton h-10 w-full" />
          ))}
        </div>
      ) : visible.length === 0 ? (
        <EmptyState title={emptyTitle ?? t('common.noData')} />
      ) : (
        <div className="table-shell">
          <table className="table">
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.key} className={column.className}>{column.header}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((row, index) => (
                <tr key={index}>
                  {columns.map((column) => (
                    <td key={column.key} className={column.className}>{column.render(row)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex items-center justify-between gap-3 border-t border-white/[0.06] px-4 py-3 text-xs text-slate-500">
        <span>
          {filtered.length === 0 ? 0 : safePage * pageSize + 1}–{Math.min(filtered.length, (safePage + 1) * pageSize)} / {filtered.length}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="btn-secondary !px-2.5 !py-1.5"
            disabled={safePage === 0}
            onClick={() => setPage((current) => Math.max(0, current - 1))}
            aria-label={t('common.previous')}
          >
            <ChevronLeft size={14} className="rtl:rotate-180" />
          </button>
          <span>{t('common.page')} {safePage + 1} / {pageCount}</span>
          <button
            type="button"
            className="btn-secondary !px-2.5 !py-1.5"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((current) => Math.min(pageCount - 1, current + 1))}
            aria-label={t('common.next')}
          >
            <ChevronRight size={14} className="rtl:rotate-180" />
          </button>
        </div>
      </div>
    </div>
  );
}