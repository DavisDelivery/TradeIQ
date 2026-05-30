// Phase 6 PR-E — KeyMetricsPanel for the StockDetailPanel.
//
// Grid layout grouped by category:
//   Valuation    — P/E, P/B, P/S, EV/EBITDA, EV/Sales, Enterprise Value, Market Cap
//   Profitability — Gross / Op / Net margin, ROE, ROA, EPS
//   Liquidity     — Current / Quick / Cash ratio
//   Leverage     — Debt / Equity, Long-term Debt
//   Market       — Beta, Dividend Yield, Free Cash Flow, 52-week range position
//
// Sector-median context: where /api/stock-detail.sectorMedians provides a
// value for the same metric, it renders next to the stock value with a
// directional dot (lower-is-better metrics get a flipped favorability
// check). Where the median is null, the field is omitted rather than
// printed as "sector: —".
//
// Honest no-data: per-metric `null` → "no data" pill (with the bundle's
// `_reason` surfaced once at the top if the whole metrics block is
// unavailable). Never a fabricated zero.

import React from 'react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

// ---------------------------------------------------------------------------
// Metric definitions — keyed by path in /api/stock-detail.metrics
// ---------------------------------------------------------------------------

// `dir: 'lower'` → lower-is-better (P/E, debt ratios); 'higher' → higher-
// is-better (margins, ROE); 'none' → no obvious good/bad direction (beta).
const GROUPS = [
  {
    title: 'Valuation',
    items: [
      { label: 'P/E',           path: 'valuation.pe',              fmt: 'num1',  dir: 'lower'  },
      { label: 'P/B',           path: 'valuation.pb',              fmt: 'num1',  dir: 'lower'  },
      { label: 'P/S',           path: 'valuation.ps',              fmt: 'num1',  dir: 'lower'  },
      { label: 'EV/EBITDA',     path: 'valuation.evEbitda',        fmt: 'num1',  dir: 'lower'  },
      { label: 'EV/Sales',      path: 'valuation.evToSales',       fmt: 'num1',  dir: 'lower'  },
      { label: 'P/FCF',         path: 'valuation.pfcf',            fmt: 'num1',  dir: 'lower'  },
      { label: 'Enterprise Val', path: 'valuation.enterpriseValue', fmt: 'usd',   dir: 'none'   },
      { label: 'Market Cap',    path: 'valuation.marketCap',       fmt: 'usd',   dir: 'none'   },
    ],
  },
  {
    title: 'Profitability',
    items: [
      { label: 'Gross Margin',   path: 'profitability.grossMargin', fmt: 'pct1',  dir: 'higher' },
      { label: 'Op Margin',      path: 'profitability.opMargin',    fmt: 'pct1',  dir: 'higher' },
      { label: 'Net Margin',     path: 'profitability.netMargin',   fmt: 'pct1',  dir: 'higher' },
      { label: 'ROE',            path: 'profitability.roe',         fmt: 'pct1',  dir: 'higher' },
      { label: 'ROA',            path: 'profitability.roa',         fmt: 'pct1',  dir: 'higher' },
      { label: 'EPS (basic)',    path: 'profitability.eps',         fmt: 'eps',   dir: 'higher' },
    ],
  },
  {
    title: 'Liquidity',
    items: [
      { label: 'Current Ratio',  path: 'health.currentRatio',       fmt: 'num2',  dir: 'higher' },
      { label: 'Quick Ratio',    path: 'health.quickRatio',         fmt: 'num2',  dir: 'higher' },
      { label: 'Cash Ratio',     path: 'health.cashRatio',          fmt: 'num2',  dir: 'higher' },
    ],
  },
  {
    title: 'Leverage',
    items: [
      { label: 'Debt / Equity',  path: 'health.debtEquity',         fmt: 'num2',  dir: 'lower'  },
      { label: 'Long-Term Debt', path: 'health.longTermDebt',       fmt: 'usd',   dir: 'lower'  },
    ],
  },
  {
    title: 'Market',
    items: [
      { label: 'Beta',           path: 'market.beta',               fmt: 'num2',  dir: 'none'   },
      { label: 'Dividend Yield', path: 'market.dividendYield',      fmt: 'pctRaw',dir: 'higher' },
      { label: 'Free Cash Flow', path: 'market.freeCashFlow',       fmt: 'usd',   dir: 'higher' },
      { label: '52w Position',   path: 'market.range52w.currentPctile', fmt: 'pct0', dir: 'none' },
    ],
  },
];

// Sector medians keys we actually compute (sector-medians.ts). Others fall
// through as "no median" and the dot/comparison hides.
const MEDIAN_PATH_MAP = {
  'valuation.pe':            'valuation.pe',
  'profitability.grossMargin': 'profitability.grossMargin',
  'profitability.opMargin':  'profitability.opMargin',
  'health.debtEquity':       'health.debtEquity',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pluck(obj, path) {
  if (!obj || !path) return undefined;
  const parts = path.split('.');
  let v = obj;
  for (const k of parts) { if (v == null) return undefined; v = v[k]; }
  return v;
}

function fmtValue(v, kind) {
  if (v == null || !Number.isFinite(v)) return null;
  if (kind === 'num1') return v.toFixed(1);
  if (kind === 'num2') return v.toFixed(2);
  if (kind === 'pct0') return `${v.toFixed(0)}%`;
  if (kind === 'pct1') return `${v.toFixed(1)}%`;
  if (kind === 'pctRaw') return `${(v * 100).toFixed(2)}%`; // dividend yield is decimal (0.0043)
  if (kind === 'eps') return `$${v.toFixed(2)}`;
  if (kind === 'usd') {
    const a = Math.abs(v);
    if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
    if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
    if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
    if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
    return `$${v.toFixed(0)}`;
  }
  return String(v);
}

function favorability(value, median, dir) {
  if (value == null || median == null || !Number.isFinite(value) || !Number.isFinite(median) || median === 0) return 'none';
  if (dir === 'none') return 'none';
  const diffPct = ((value - median) / Math.abs(median)) * 100;
  const better = dir === 'higher' ? diffPct > 0 : diffPct < 0;
  const abs = Math.abs(diffPct);
  if (abs < 5) return 'neutral';
  return better ? 'favorable' : 'unfavorable';
}

const DOT_CLASS = {
  favorable: 'bg-emerald-400',
  neutral:   'bg-neutral-500',
  unfavorable: 'bg-rose-400',
  none:      'bg-transparent',
};

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeyMetricsPanel({ ticker }) {
  const { data, isLoading, isError, error, refetch } = useStockDetail(ticker);
  const metrics = data?.metrics ?? null;
  const sectorMedians = data?.sectorMedians ?? null;

  return (
    <section
      data-testid="key-metrics-panel"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Key Metrics
        </div>
        {sectorMedians?.sampleSize > 0 && (
          <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600">
            sector median · n={sectorMedians.sampleSize}
          </div>
        )}
      </header>

      {isLoading && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">loading metrics…</div>
      )}

      {!isLoading && isError && (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">couldn't load metrics</div>
          <div className="text-[10px] text-neutral-500 font-mono break-all">{String(error?.message || 'unknown')}</div>
          <button
            type="button"
            onClick={() => refetch()}
            className="px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500"
          >
            ↻ retry
          </button>
        </div>
      )}

      {!isLoading && !isError && !metrics && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">no metrics available</div>
      )}

      {!isLoading && !isError && metrics && (
        <>
          {metrics._reason && (
            <div className="mb-3 text-[10px] font-mono uppercase tracking-widest text-amber-400/80">
              {metrics._reason}
            </div>
          )}
          <div className="space-y-4">
            {GROUPS.map((g) => (
              <MetricGroup key={g.title} group={g} metrics={metrics} medians={sectorMedians} />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function MetricGroup({ group, metrics, medians }) {
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600 mb-2">{group.title}</div>
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {group.items.map((m) => (
          <MetricCell key={m.label} def={m} metrics={metrics} medians={medians} />
        ))}
      </div>
    </div>
  );
}

function MetricCell({ def, metrics, medians }) {
  const value = pluck(metrics, def.path);
  const median = pluck(medians, MEDIAN_PATH_MAP[def.path] ?? '');
  const displayValue = fmtValue(value, def.fmt);
  const displayMedian = fmtValue(median, def.fmt);
  const fav = favorability(value, median, def.dir);

  return (
    <div data-testid={`metric-${def.path}`} className="bg-neutral-900/40 px-3 py-2 border border-neutral-800/60">
      <div className="flex items-center justify-between gap-2">
        <div className="text-[10px] uppercase tracking-widest text-neutral-500 font-mono">{def.label}</div>
        {fav !== 'none' && (
          <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[fav]}`} />
        )}
      </div>
      <div className={`mt-1 font-mono text-[14px] ${displayValue == null ? 'text-neutral-600' : 'text-neutral-100'}`}>
        {displayValue ?? 'no data'}
      </div>
      {displayMedian != null && (
        <div className="text-[10px] font-mono text-neutral-500">sector: {displayMedian}</div>
      )}
    </div>
  );
}
