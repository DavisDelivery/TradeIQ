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
import { chartTheme } from '../../lib/chartTheme.js';
import {
  BarChart, Bar, LineChart, Line, ComposedChart,
  XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend, ReferenceLine,
} from 'recharts';
import { AlertTriangle } from 'lucide-react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

// `field` is the row key Recharts reads via dataKey — it MUST match the
// QuarterlyFundamental field name, which is not always the tab id (fcf →
// freeCashFlow, leverage → debtToEquity). A mismatch silently plots nothing.
// THEME-1: `color` is a SEMANTIC KEY resolved against the active theme at
// render (see chartTheme). It used to be a literal hex, which meant every
// series was dark-mode-only — #14e89a measures 1.49:1 on the light page.
const TABS = [
  { id: 'revenue',  label: 'Revenue',  kind: 'bar',     field: 'revenue',      accessor: (q) => q.revenue,      unit: 'usd',  color: 'up' },
  { id: 'eps',      label: 'EPS',      kind: 'bar',     field: 'eps',          accessor: (q) => q.eps,          unit: 'eps',  color: 'accent' },
  { id: 'margins',  label: 'Margins',  kind: 'lines',   accessors: [
    { key: 'grossMargin', label: 'Gross', color: 'up', accessor: (q) => q.grossMargin },
    { key: 'opMargin',    label: 'Op',    color: 'accent', accessor: (q) => q.opMargin },
    { key: 'netMargin',   label: 'Net',   color: 'violet', accessor: (q) => q.netMargin },
  ], unit: 'pct' },
  { id: 'fcf',      label: 'FCF',      kind: 'bar',     field: 'freeCashFlow', accessor: (q) => q.freeCashFlow, unit: 'usd',  color: 'up' },
  { id: 'leverage', label: 'D/E',      kind: 'line',    field: 'debtToEquity', accessor: (q) => q.debtToEquity, unit: 'ratio', color: 'down' },
];

// Windows are expressed in YEARS so the same choice means the same span in
// either period mode: 5Y is 20 quarterly bars or 5 annual ones.
const RANGES = [
  { id: '5Y', label: '5Y', years: 5 },
  { id: 'ALL', label: 'All', years: Infinity },
];

const PERIODS = [
  { id: 'Q', label: 'Qtr' },
  { id: 'FY', label: 'Annual' },
];

/**
 * Roll quarters into fiscal years. EVERY METRIC AGGREGATES DIFFERENTLY, and
 * getting that wrong is the whole risk here — a plain mean would be wrong for
 * all five series.
 *
 *   revenue / eps / freeCashFlow  SUM. They are flows.
 *   margins                       REVENUE-WEIGHTED mean, which is not an
 *                                 approximation of the annual margin — it is
 *                                 exactly equal to it, because
 *                                 Σ(margin_q × rev_q) / Σ(rev_q) is
 *                                 Σ(profit_q) / Σ(rev_q). A plain mean would
 *                                 let a tiny quarter's 80% margin outvote a
 *                                 huge quarter's 20%.
 *   debtToEquity                  LAST quarter of the year. It is a balance
 *                                 sheet reading — a stock, not a flow — so
 *                                 summing is meaningless and averaging blurs
 *                                 a year-end position into a year-long one.
 *
 * INCOMPLETE YEARS ARE DROPPED. A fiscal year with three quarters in it
 * renders as a collapse next to full years, which is a lie told by a bar
 * chart. The current year is therefore absent from the annual view until it
 * closes; the quarterly view still shows it, and the footer says how many
 * were dropped so the absence is stated rather than silently applied.
 *
 * A flow with ANY null quarter yields null rather than a short sum, for the
 * same reason: three quarters of revenue labelled as a year is understated
 * by a quarter and looks like a decline.
 */
export function toFiscalYears(quarters) {
  const byYear = new Map();
  for (const q of quarters) {
    const fy = q?.fiscalYear;
    if (typeof fy !== 'number' || !Number.isFinite(fy)) continue;
    if (!byYear.has(fy)) byYear.set(fy, []);
    byYear.get(fy).push(q);
  }

  const sumOrNull = (rows, get) => {
    const vals = rows.map(get);
    if (vals.some((v) => v == null || !Number.isFinite(v))) return null;
    return vals.reduce((a, b) => a + b, 0);
  };

  const weighted = (rows, get) => {
    let num = 0;
    let den = 0;
    for (const r of rows) {
      const m = get(r);
      const w = r.revenue;
      if (m == null || !Number.isFinite(m)) continue;
      if (w == null || !Number.isFinite(w) || w <= 0) continue;
      num += m * w;
      den += w;
    }
    return den > 0 ? num / den : null;
  };

  const out = [];
  for (const [fy, rowsRaw] of [...byYear.entries()].sort((a, b) => a[0] - b[0])) {
    if (rowsRaw.length !== 4) continue; // incomplete fiscal year
    const rows = [...rowsRaw].sort((a, b) =>
      String(a.endDate ?? '').localeCompare(String(b.endDate ?? '')));
    const last = rows[rows.length - 1];
    out.push({
      period: `FY ${fy}`,
      endDate: last.endDate,
      fiscalYear: fy,
      fiscalQuarter: null,
      filingDate: last.filingDate ?? null,
      revenue: sumOrNull(rows, (r) => r.revenue),
      eps: sumOrNull(rows, (r) => r.eps),
      freeCashFlow: sumOrNull(rows, (r) => r.freeCashFlow),
      grossMargin: weighted(rows, (r) => r.grossMargin),
      opMargin: weighted(rows, (r) => r.opMargin),
      netMargin: weighted(rows, (r) => r.netMargin),
      debtToEquity: last.debtToEquity ?? null,
    });
  }
  return out;
}

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

/**
 * Add a YoY growth field to every row.
 *
 * `back` is how many rows ago "a year ago" is: 4 for quarters, 1 for fiscal
 * years. Leaving it at 4 in the annual view would have compared each year to
 * four years earlier and labelled the result YoY.
 */
function withYoYGrowth(rows, accessor, back = 4) {
  return rows.map((r, i, all) => {
    const ago = all[i - back];
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
        <div key={p.dataKey} className="flex items-center justify-between gap-3" style={{ color: chartTheme()[p.color] ?? p.color }}>
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
  const [periodId, setPeriodId] = useState('Q');

  const tab = TABS.find((t) => t.id === tabId);
  const range = RANGES.find((r) => r.id === rangeId);
  const annual = periodId === 'FY';

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
  // Server-side tripwire: the provider silently served a window ending in 2021
  // once, and the chart drew it as though it were current. A normal-looking
  // chart of five-year-old revenue is worse than an empty one.
  const _stale = data?.fundamentalsHistory?._stale ?? null;

  // The full series in the ACTIVE period, before the window is applied — the
  // footer describes this, so it reports what exists rather than what is shown.
  const allPeriods = useMemo(
    () => (annual ? toFiscalYears(allQuarters) : allQuarters),
    [allQuarters, annual],
  );

  // Fiscal years present in the raw quarters but dropped as incomplete. Stated
  // in the footer so "where is this year?" has an answer on the screen.
  const droppedYears = useMemo(() => {
    if (!annual) return 0;
    const seen = new Set(
      allQuarters.map((q) => q?.fiscalYear).filter((y) => typeof y === 'number'),
    );
    return seen.size - allPeriods.length;
  }, [annual, allQuarters, allPeriods]);

  const rows = useMemo(() => {
    const keep = range.years === Infinity ? Infinity : range.years * (annual ? 1 : 4);
    const slice = keep === Infinity ? allPeriods : allPeriods.slice(-keep);
    // YoY on annual rows compares to the PRIOR ROW, not four rows back.
    if (tab.kind === 'bar' && tab.unit === 'usd') {
      return withYoYGrowth(slice, tab.accessor, annual ? 1 : 4);
    }
    return slice;
  }, [allPeriods, range, tab, annual]);

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
          <div role="tablist" aria-label="Period" className="flex gap-1 ml-2">
            {PERIODS.map((p) => {
              const active = p.id === periodId;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`period-${p.id}`}
                  onClick={() => setPeriodId(p.id)}
                  className={
                    'px-2 h-7 text-[10px] font-mono uppercase tracking-widest border transition-colors ' +
                    (active
                      ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10'
                      : 'border-neutral-800 text-neutral-500 hover:text-neutral-200 hover:border-neutral-600')
                  }
                >
                  {p.label}
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

      {_stale && (
        <div
          data-testid="fundamentals-stale"
          className="mb-3 flex items-start gap-2 border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] leading-relaxed text-amber-200"
        >
          <AlertTriangle className="h-3.5 w-3.5 shrink-0 mt-0.5" />
          <span>Out of date — {_stale.reason}</span>
        </div>
      )}

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
        {!isLoading && !isError && allPeriods.length === 0 && (
          <div className="h-full flex items-center justify-center text-center px-3 text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            {annual && allQuarters.length > 0
              ? 'no complete fiscal year yet — switch to Qtr'
              : `no quarterly history${_reason ? ` — ${_reason}` : ''}`}
          </div>
        )}
        {!isLoading && !isError && allPeriods.length > 0 && seriesAllNull && (
          <div className="h-full flex items-center justify-center text-center px-3 text-[11px] font-mono uppercase tracking-widest text-neutral-600">
            no {tab.label.toLowerCase()} data in this window
          </div>
        )}
        {!isLoading && !isError && allPeriods.length > 0 && !seriesAllNull && (
          <ResponsiveContainer width="100%" height="100%">
            <FundamentalsBody tab={tab} rows={rows} />
          </ResponsiveContainer>
        )}
      </div>

      {!isLoading && !isError && allPeriods.length > 0 && (
        <div className="mt-2 text-[9px] uppercase tracking-widest font-mono text-neutral-600 text-right" data-testid="fundamentals-footer">
          {allPeriods.length} {annual ? 'fiscal years' : 'quarters'} · oldest{' '}
          {allPeriods[0]?.endDate} · latest {allPeriods[allPeriods.length - 1]?.endDate}
          {annual && droppedYears > 0 && ` · ${droppedYears} incomplete year${droppedYears === 1 ? '' : 's'} omitted`}
        </div>
      )}
    </section>
  );
}

// NB: ResponsiveContainer measures its DIRECT child and injects width/height
// via cloneElement. This body is that child, so it must forward those dims to
// the real Recharts chart — otherwise the chart renders at 0×0 (blank). That
// was the "fundamentals window isn't working" bug: the chart had data but no
// size. `...dims` captures the injected width/height and spreads them on.
function FundamentalsBody({ tab, rows, ...dims }) {
  // Resolved per render so a theme flip is picked up without remounting.
  const pal = chartTheme();
  const yTickFmt = tickFmt(tab.unit);
  if (tab.kind === 'bar') {
    return (
      <ComposedChart {...dims} data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke={pal.grid} />
        <XAxis dataKey="period" stroke={pal.axis} fontSize={9} minTickGap={20} />
        <YAxis stroke={pal.axis} fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} />
        <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ fill: pal.cursor + '14' }} />
        <Bar dataKey={tab.field} name={tab.label} fill={pal[tab.color] ?? tab.color} isAnimationActive={false} />
      </ComposedChart>
    );
  }
  if (tab.kind === 'line') {
    return (
      <LineChart {...dims} data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
        <CartesianGrid strokeDasharray="2 2" stroke={pal.grid} />
        <XAxis dataKey="period" stroke={pal.axis} fontSize={9} minTickGap={20} />
        <YAxis stroke={pal.axis} fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} />
        <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ stroke: pal.accent }} />
        <Line type="monotone" dataKey={tab.field} name={tab.label} stroke={pal[tab.color] ?? tab.color} strokeWidth={1.5} dot={false} isAnimationActive={false} />
      </LineChart>
    );
  }
  // 'lines' (margins overlay)
  return (
    <LineChart {...dims} data={rows} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
      <CartesianGrid strokeDasharray="2 2" stroke={pal.grid} />
      <XAxis dataKey="period" stroke={pal.axis} fontSize={9} minTickGap={20} />
      <YAxis stroke={pal.axis} fontSize={10} width={56} orientation="right" tickFormatter={yTickFmt} domain={['auto', 'auto']} />
      <Tooltip content={<CustomTooltip unit={tab.unit} />} cursor={{ stroke: pal.accent }} />
      <Legend
        verticalAlign="bottom"
        height={20}
        wrapperStyle={{ fontFamily: 'IBM Plex Mono, monospace', fontSize: 10, color: pal.tick }}
        iconType="plainline"
      />
      <ReferenceLine y={0} stroke={pal.axis} strokeDasharray="3 3" />
      {tab.accessors.map((a) => (
        <Line key={a.key} type="monotone" dataKey={a.key} name={a.label} stroke={pal[a.color] ?? a.color} strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
      ))}
    </LineChart>
  );
}

// avoid unused-import lint
export const _unused = { tooltipFmt };
