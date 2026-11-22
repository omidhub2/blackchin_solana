'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  Cell,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis
} from 'recharts';

import type { OverviewResponse, SeriesPoint } from '@/lib/types';

const palette = {
  cyan: '#22d3ee',
  blue: '#38bdf8',
  violet: '#a78bfa',
  emerald: '#34d399',
  amber: '#fbbf24',
  rose: '#fb7185'
};

function mergeSeries(series: OverviewResponse['series']) {
  const buckets = new Map<string, { bucket: string; wallets: number; addresses: number; deposits: number; withdrawals: number }>();

  const add = (points: SeriesPoint[], key: 'wallets' | 'addresses' | 'deposits' | 'withdrawals') => {
    for (const point of points) {
      const existing = buckets.get(point.bucket) ?? {
        bucket: point.bucket, wallets: 0, addresses: 0, deposits: 0, withdrawals: 0
      };
      existing[key] = point.count;
      buckets.set(point.bucket, existing);
    }
  };

  add(series.wallets, 'wallets');
  add(series.addresses, 'addresses');
  add(series.deposits, 'deposits');
  add(series.withdrawals, 'withdrawals');

  return [...buckets.values()].sort((a, b) => new Date(a.bucket).getTime() - new Date(b.bucket).getTime());
}

function labelFor(bucket: string, hourly: boolean) {
  const date = new Date(bucket);
  if (Number.isNaN(date.getTime())) return bucket;
  return hourly
    ? date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString([], { month: 'short', day: '2-digit' });
}

function ChartTooltip({ active, payload, label }: {
  active?: boolean;
  payload?: Array<{ name?: string; value?: number; color?: string }>;
  label?: string;
}) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-xl border border-white/10 bg-ink-900/95 px-3 py-2 text-xs shadow-panel">
      <p className="mb-1 text-slate-400">{label}</p>
      {payload.map((entry) => (
        <p key={entry.name} className="flex items-center gap-2 text-slate-200">
          <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.color }} />
          {entry.name}: <span className="font-medium">{entry.value}</span>
        </p>
      ))}
    </div>
  );
}

export function ActivityCharts({ series }: { series: OverviewResponse['series'] }) {
  const data = mergeSeries(series);
  const hourly = series.bucket === 'hour';

  const charts = [
    { key: 'wallets', title: 'Wallet Creation', color: palette.cyan },
    { key: 'addresses', title: 'Address Generation', color: palette.blue },
    { key: 'deposits', title: 'Deposit Activity', color: palette.emerald },
    { key: 'withdrawals', title: 'Withdrawal Activity', color: palette.violet }
  ] as const;

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {charts.map((chart) => (
        <div key={chart.key} className="panel p-5">
          <div className="mb-4 flex items-center justify-between">
            <h3 className="text-sm font-medium text-slate-200">{chart.title}</h3>
            <span className="h-2 w-2 rounded-full" style={{ background: chart.color }} />
          </div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={data} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <defs>
                  <linearGradient id={`grad-${chart.key}`} x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor={chart.color} stopOpacity={0.35} />
                    <stop offset="100%" stopColor={chart.color} stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="rgba(255,255,255,0.05)" vertical={false} />
                <XAxis
                  dataKey="bucket"
                  tickFormatter={(value) => labelFor(String(value), hourly)}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  minTickGap={24}
                />
                <YAxis
                  allowDecimals={false}
                  tick={{ fill: '#64748b', fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  width={36}
                />
                <Tooltip content={<ChartTooltip />} labelFormatter={(value) => labelFor(String(value), hourly)} />
                <Area
                  type="monotone"
                  dataKey={chart.key}
                  name={chart.title}
                  stroke={chart.color}
                  strokeWidth={2}
                  fill={`url(#grad-${chart.key})`}
                />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      ))}
    </div>
  );
}

export function StatusDistribution({
  confirmed,
  pending,
  failed,
  underReview
}: {
  confirmed: number;
  pending: number;
  failed: number;
  underReview: number;
}) {
  const data = [
    { name: 'Confirmed', value: confirmed, color: palette.emerald },
    { name: 'Pending', value: pending, color: palette.amber },
    { name: 'Failed', value: failed, color: palette.rose },
    { name: 'Under review', value: underReview, color: palette.violet }
  ].filter((entry) => entry.value > 0);

  if (data.length === 0) {
    return (
      <div className="panel flex h-full min-h-[220px] items-center justify-center p-5 text-sm text-slate-500">
        No transaction data
      </div>
    );
  }

  return (
    <div className="panel p-5">
      <h3 className="mb-2 text-sm font-medium text-slate-200">Transaction Status</h3>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={data} dataKey="value" nameKey="name" innerRadius={44} outerRadius={66} paddingAngle={3}>
              {data.map((entry) => <Cell key={entry.name} fill={entry.color} stroke="transparent" />)}
            </Pie>
            <Tooltip content={<ChartTooltip />} />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2 text-[11px]">
        {data.map((entry) => (
          <div key={entry.name} className="flex items-center gap-2 text-slate-400">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: entry.color }} />
            {entry.name}: <span className="text-slate-200">{entry.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}