// Phase 6 PR-D — fundamental charts for the StockDetailPanel.
//
// Series:
//   Revenue       — quarterly bar with YoY growth labels
//   EPS           — quarterly bar (basic EPS)
//   Margins       — gross / operating / net margin overlay (lines)
//   Free Cash Flow — quarterly bar (OCF − |capex|)
//   Debt / Equity — quarterly line (long-term debt incl. capital leases / parent equity)
//
// Data: `/api/stock-detail`.fundamentalsHistory.quarterly — a flat oldest-
// first array of `QuarterlyFundamental` rows (4w fundamentals → pure
// transform → no second fetch). After Phase 4w landed, this can reach 5y+
// (Stocks Financials add-on goes back to 2009-03-29).
//
// Default window: trailing 5 years (20 quarters). Toggle to ALL history.
// Honest no-data: per-series null values are dropped from the rendered
// dataset rather than zeroed, and the chart shows an explicit "no data"
// placeholder when every value in the active window is null. The whole
// section surfaces the bundle's `_reason` if the quarterly array is empty.

import React, { useMemo, useState } from 'react';
import {
  BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

const TABS = [
  { id: 'revenue',  label: 'Revenue',  kind: 'bar',     accessor: (q) => q.revenue,      unit: 'usd',  color: '#14e89a' },
  { id: 'eps',      label: 'EPS',      kind: 'bar',     accessor: (q) => q.eps,          unit: 'eps',  color: '#1e5b92' },
  { id: 'margins',  label: 'Margins',  kind: 'lines',   accessors: [
    { key: 'grossMargin', label: 'Gross', color: '#14e89a', accessor: (q) => q.grossMargin },
    { key: 'opMargin',    label: 'Op',    color: '#1e5b92', accessor: (q) => q.opMargin },
    { key: 'netMargin',   label: 'Net',   color: '#a78bfa', accessor: (q) => q.netMargin },
  ], unit: 'pct' },
  { id: 'fcf',      label: 'FCF',      kind: 'bar',     accessor: (q) => q.freeCashFlow, unit: 'usd',  color: '#14e89a' },
  { id: 'leverage', label: 'D/E',      kind: 'line',    accessor: (q) => q.debtToEquity, unit: 'ratio', color: '#ff5577' },
];

const RANGES = [
  { id: '5Y', label: '5Y', keep: 20 },
  { id: 'ALL', label: 'All', keep: Infinity },
];

function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return '';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}%`;
}

function fmtEps(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return `$${v.toFixed(2)}`;
}

function fmtRatio(v) {
  if (v == null || !Number.isFinite(v)) return '';
  return v.toFixed(2);
}

function tickFmt(unit) {
  return unit === 'usd' ? fmtUSD : unit === 'pct' ? (v) => `${v}%` : unit === 'eps' ? fmtEps : fmtRatio;
}

function tooltipFmt(unit, label) {
  return (v) => {
    const f = unit === 'usd' ? fmtUSD : unit === 'pct' ? (x) => `${x.toFixed(1)}%` : unit === 'eps' ? fmtEps : fmtRatio;
    return [f(v), label];
  };
}

/** Add a YoY growth field to every row (4 quarters back). */
function withYoYGrowth(rows, accessor) {
  return rows.map((r, i, all) => {
    const ago = all[i - 4];
    const cur = accessor(r);
    const prev = ago ? accessor(ago) : null;
    const yoy = cur != null && prev != null && prev !== 0 ? ((cur - prev) / Math.abs(prev)) * 100 : null;
    return { ...r, _yoy: yoy };
  });
}

function CustomTooltip({ active, payload, label, unit }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-neutral-950/95 border border-neutral-800 px-3 py-2 text-[11px] font-mono">
      <div className="text-neutral-500 mb-1">{label}</div>
      {payload.map((p) => (
        <div key={p.dataKey} className="flex items-center justify-between gap-3" style={{ color: p.color }}>
          <span>{p.name}</span>
          <span>{
            unit === 'usd' ? fmtUSD(p.value)
            : unit === 'pct' ? `${p.value > 0 ? '+' : ''}${Number(p.value).toFixed(1)}%`
            : unit === 'eps' ? fmtEps(p.value)
            : fmtRatio(p.value)
          }</span>
        </div>
      ))}
      {payload[0].payload?._yoy != null && Number.isFinite(payload[0].payload._yoy) && (
        <div className="text-neutral-600 mt-1">YoY {payload[0].payload._yoy > 0 ? '+' : ''}{payload[0].payload._yoy.toFixed(1)}%</div>
      )}
    </div>
  );
}

export function FundamentalsChart({ ticker }) {
  const { data, isLoading, isError, error, refetch } = useStockDetail(ticker);
  const [tabId, setTabId] = useState('revenue');
  const [rangeId, setRangeId] = useState('5Y');

  const tab = TABS.find((t) => t.id === tabId);
  const range = RANGES.find((r) => r.id === rangeId);

  // Defensive ascending sort by endDate. The component assumes oldest→newest
  // (slice(-keep) = most recent window, [0]=oldest label, [last]=latest), but
  // the API sometimes returns quarters newest-first — which inverted the
  // oldest/latest footer AND made the 5Y window select the OLDEST quarters
  // instead of the recent ones (user-reported: "oldest 2026-03-31 · latest
  // 2024-06-30"). Sorting here fixes both regardless of upstream order.
  const allQuarters = useMemo(() => {
    const raw = Array.isArray(data?.fundamentalsHistory?.quarterly) ? data.fundamentalsHistory.quarterly : [];
    return [...raw].sort((a, b) => String(a.endDate ?? '').localeCompare(String(b.endDate ?? '')));
  }, [data]);
  const _reason = data?.fundamentalsHistory?._reason;

  const rows = useMemo(() => {
    const slice = range.keep === Infinity ? allQuarters : allQuarters.slice(-range.keep);
    if (tab.kind === 'bar' && tab.unit === 'usd') return withYoYGrowth(slice, tab.accessor);
    return slice;
  }, [allQuarters, range, tab]);

  // Honest emptiness check: is every value in the active series null?
  const seriesAllNull = useMemo(() => {
    if (rows.length === 0) return true;
    if (tab.kind === 'lines') return rows.every((r) => tab.accessors.every((a) => a.accessor(r) == null));
    return rows.every((r) => tab.accessor(r) == null);
  }, [rows, tab]);

  return (
    <section
      data-testid="fundamentals-chart"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Fundamentals
        </div>
        <div className="flex items-center gap-2">
          <div role="tablist" aria-label="Series" className="flex gap-1">
            {TABS.map((t) => {
              const active = t.id === tabId;
              return (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setTabId(t.id)}
                  className={
                    'px-2 h-7 text-[10px] font-mono uppercase tracking-widest border transition-colors ' +
                    (active
                      ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10'
                      : 'border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600')
                  }
                >
                  {t.label}
                </button>
              );
            })}
          </div>
          <div role="tablist" aria-label="Window" className="flex gap-1 ml-2">
            {RANGES.map((r) => {
              const active = r.id === rangeId;
              return (
                <button
                  key={r.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  onClick={() => setRangeId(r.id)}
                  className={
                    'px-2 h-7 text-[10px] font-mono uppercase tracking-widest border transition-colors ' +
                    (active
                      ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10'
                      : 'border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600')
                  }
                >
                  {r.label}
                </button>
              );
            })}
          </div>
        </div>
      </header>

      <div className="h-56 sm:h-64 w-full">
        {isLoading && (
          <div className="h-full flex items-center justify-center text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            loading fundamentals…
          </div>
        )}
        {!isLoading && isError && (
          <div className="h-full flex flex-col items-center justify-center gap-2 text-center px-3">
            <AlertTriangle className="h-4 w-4 text-rose-400" />
            <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">
              couldn't load detail bundle
            </div>
            <div className="text-[10px] text-neutral-500 font-mono break-all max-w-md">
              {String(error?.message || 'unknown error')}
            </div>
            <button
              type="button"
              onClick={() => refetch()}
              className="mt-1 px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500"
            >
              ↻ retry
            </button>
          </div>
        )}
        {!isLoading && !isError && allQuarters.length === 0 && (
          <div className="h-full flex items-center justify-center text-center px-3 text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            no quarterly history{_reason ? ` — ${_reason}` : ''}
          </div>
        )}
        {!isLoading && !isError && allQuarters.length > 0 && seriesAllNull && (
          <div className="h-full flex items-center justify-center text-center px-3 text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            no {tab.label.toLowerCase()} data in this window
          </div>
        )}
        {!isLoading && !isError && allQuarters.length > 0 && !seriesAllNull && (
          <ResponsiveContainer width="100%" height="100%">
            <FundamentalsBody tab={tab} rows={rows} />
          </ResponsiveContainer>
        )}
      </div>

      {!isLoading && !isError && allQuarters.length > 0 && (
        <div className="mt-2 text-[9px] uppercase tracking-widest font-mono text-neutral-600 text-right">
          {allQuarters.length} quarters · oldest {allQuarters[0]?.endDate} · latest {allQuarters[allQuarters.length - 1]?.endDate}
        </div>
      )}
    </section>
  );
}

function FundamentalsBody({ tab, rows }) {
  const yTickFmt = tickFmt(tab.unit);
  if (tab.kind === 'bar') {
    return (
      <ComposedChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#1f1f23" />
        <XAxis dataKey="period" stroke="#525252" fontSize={9} minTickGap={20} />
        <YAxis stroke="#525252" fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} />
        <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ fill: '#ffffff08' }} />
        <Bar dataKey={tab.id} name={tab.label} fill={tab.color} isAnimationActive={false}>
          {/* compute key inline to keep React happy */}
        </Bar>
      </ComposedChart>
    );
  }
  if (tab.kind === 'line') {
    return (
      <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke="#1f1f23" />
        <XAxis dataKey="period" stroke="#525252" fontSize={9} minTickGap={20} />
        <YAxis stroke="#525252" fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} />
        <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ stroke: '#1e5b92' }} />
        <Line type="monotone" dataKey={tab.id} name={tab.label} stroke={tab.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    );
  }
  // 'lines' (margins overlay)
  return (
    <LineChart data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="2 2" stroke="#1f1f23" />
      <XAxis dataKey="period" stroke="#525252" fontSize={9} minTickGap={20} />
      <YAxis stroke="#525252" fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} domain={['auto', 'auto']} />
      <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ stroke: '#1e5b92' }} />
      <Legend
        verticalAlign="bottom"
        height={20}
        wrapperStyle={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: '#737373' }}
        iconType="plainline"
      />
      <ReferenceLine y={0} stroke="#525252" strokeDasharray="3 3" />
      {tab.accessors.map((a) => (
        <Line key={a.key} type="monotone" dataKey={a.key} name={a.label} stroke={a.color} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
      ))}
    </LineChart>
  );
}

// avoid unused-import lint
export const _unused = { tooltipFmt };
