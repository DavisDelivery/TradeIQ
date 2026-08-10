// PROFILE-1 W2.2 + W2.3 — KeyMetricsPanel, rebuilt as scannable rows.
//
// WAS: a 23-tile grid (5 groups), every value in monospace, every null
// printed as a literal "no data", and a favourability dot that painted a low
// P/E emerald.
//
// NOW: two-column label/value rows chunked under real headings, numbers in
// proportional sans with tabular-nums, null rows hidden behind one footnote,
// and NO good/bad treatment on any metric the direction table calls neutral.
//
// THREE THINGS THIS FIXES, EACH FOR A STATED REASON:
//
// 1. TILES -> ROWS. A grid of equal-weight tiles has no reading order, so
//    every value competes and the eye lands nowhere. Label-left/value-right
//    rows give a single scan column; right-aligning with tabular-nums makes
//    the digits line up so magnitudes are comparable at a glance, which is
//    the entire job of a stats block.
//
// 2. NULLS DISAPPEAR. "no data" repeated fifteen times is fifteen rows of
//    visual noise carrying no information. The old test asserted more than
//    ten of them on a degraded payload, which is a good description of the
//    problem. Missing rows are hidden and named once, quietly, at the end —
//    the fact stays available and stops shouting.
//
// 3. NO VERDICT ON VALUATION. The old `favorability()` gave P/E dir:'lower'
//    and rendered a cheap stock emerald. That is a claim about the future
//    from a cross-sectional rank, and it is how a value trap looks like a
//    bargain. Direction now comes from shared/metric-direction.ts, where
//    P/E is neutral and only margins/returns/bands may carry a treatment.

import React, { useMemo, useState } from 'react';
import { useStockDetail } from '../../hooks/useStockDetail.js';
import {
  mayRenderVerdict,
  policyFor,
} from '../../../netlify/functions/shared/metric-direction.ts';

// ---------------------------------------------------------------------------
// Chunks. 4-6 rows each, in the kickoff's order.
// `key` maps the row onto the direction table; rows without one are
// descriptive by default (mayRenderVerdict returns false for unknown keys).
// ---------------------------------------------------------------------------

const CHUNKS = [
  {
    title: 'Valuation',
    items: [
      { label: 'P/E', path: 'valuation.pe', fmt: 'num1', key: 'pe' },
      { label: 'P/S', path: 'valuation.ps', fmt: 'num1', key: 'ps' },
      { label: 'P/B', path: 'valuation.pb', fmt: 'num1', key: 'pb' },
      { label: 'EV/EBITDA', path: 'valuation.evEbitda', fmt: 'num1', key: 'evEbitda' },
      { label: 'P/FCF', path: 'valuation.pfcf', fmt: 'num1', key: 'pfcf' },
      { label: 'Market cap', path: 'valuation.marketCap', fmt: 'usd' },
    ],
  },
  {
    title: 'Profitability',
    items: [
      { label: 'Gross margin', path: 'profitability.grossMargin', fmt: 'pct1', key: 'grossMargin' },
      { label: 'Operating margin', path: 'profitability.opMargin', fmt: 'pct1', key: 'opMargin' },
      { label: 'Net margin', path: 'profitability.netMargin', fmt: 'pct1', key: 'netMargin' },
      { label: 'ROE', path: 'profitability.roe', fmt: 'pct1', key: 'roe' },
      { label: 'ROA', path: 'profitability.roa', fmt: 'pct1', key: 'roa' },
      { label: 'EPS', path: 'profitability.eps', fmt: 'eps' },
    ],
  },
  {
    title: 'Balance sheet',
    items: [
      { label: 'Current ratio', path: 'health.currentRatio', fmt: 'num2', key: 'currentRatio' },
      { label: 'Quick ratio', path: 'health.quickRatio', fmt: 'num2', key: 'quickRatio' },
      { label: 'Debt / equity', path: 'health.debtEquity', fmt: 'num2', key: 'debtEquity' },
      { label: 'Long-term debt', path: 'health.longTermDebt', fmt: 'usd' },
      { label: 'Free cash flow', path: 'market.freeCashFlow', fmt: 'usd' },
    ],
  },
  {
    title: 'Trading',
    items: [
      { label: 'Beta', path: 'market.beta', fmt: 'num2', key: 'beta' },
      { label: '52w position', path: 'market.range52w.currentPctile', fmt: 'pct0' },
      { label: 'Enterprise value', path: 'valuation.enterpriseValue', fmt: 'usd' },
    ],
  },
  {
    title: 'Dividend',
    // Payers only — the whole chunk hides when the yield is null, rather than
    // printing a dividend section for a company that does not pay one.
    payersOnly: 'market.dividendYield',
    items: [
      { label: 'Dividend yield', path: 'market.dividendYield', fmt: 'pctRaw', key: 'dividendYield' },
    ],
  },
];

const MEDIAN_PATH_MAP = {
  'valuation.pe': 'valuation.pe',
  'profitability.grossMargin': 'profitability.grossMargin',
  'profitability.opMargin': 'profitability.opMargin',
  'health.debtEquity': 'health.debtEquity',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function pluck(obj, path) {
  if (!obj || !path) return undefined;
  let v = obj;
  for (const k of path.split('.')) { if (v == null) return undefined; v = v[k]; }
  return v;
}

export function fmtValue(v, kind) {
  if (v == null || !Number.isFinite(v)) return null;
  if (kind === 'num1') return v.toFixed(1);
  if (kind === 'num2') return v.toFixed(2);
  if (kind === 'pct0') return `${v.toFixed(0)}%`;
  if (kind === 'pct1') return `${v.toFixed(1)}%`;
  if (kind === 'pctRaw') return `${(v * 100).toFixed(2)}%`; // yield arrives as a decimal
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

/**
 * Favourability, but ONLY where the direction table permits one.
 *
 * Returns 'none' for every neutral and flag metric, which is what stops a
 * cheap P/E rendering as good news.
 */
export function favorability(metricKey, value, median) {
  if (!metricKey || !mayRenderVerdict(metricKey)) return 'none';
  if (!Number.isFinite(value) || !Number.isFinite(median) || median === 0) return 'none';
  const p = policyFor(metricKey);
  if (!p) return 'none';

  if (p.direction === 'band') {
    if (!p.band) return 'none';
    return value >= p.band.low && value <= p.band.high ? 'favorable' : 'unfavorable';
  }
  // higher-in-industry
  const diffPct = ((value - median) / Math.abs(median)) * 100;
  if (Math.abs(diffPct) < 5) return 'neutral';
  return diffPct > 0 ? 'favorable' : 'unfavorable';
}

const DOT_CLASS = {
  favorable: 'bg-emerald-400',
  neutral: 'bg-neutral-500',
  unfavorable: 'bg-rose-400',
  none: 'bg-transparent',
};

/**
 * Normalise `_degraded` into a display list.
 *
 * The server sends `Record<string, string>` (dep -> reason). An array is
 * accepted too, purely so an older cached payload or a hand-written fixture
 * cannot blank the banner — but the object form is the real contract.
 */
export function degradedList(degraded) {
  if (!degraded) return [];
  if (Array.isArray(degraded)) return degraded.filter(Boolean).map(String);
  if (typeof degraded === 'object') {
    return Object.entries(degraded).map(([dep, reason]) =>
      reason ? `${dep} (${reason})` : dep,
    );
  }
  return [];
}

/** Rows with a value, and the labels of those without. */
export function partitionRows(items, metrics) {
  const present = [];
  const missing = [];
  for (const it of items) {
    const v = pluck(metrics, it.path);
    if (v == null || !Number.isFinite(v)) missing.push(it.label);
    else present.push({ ...it, value: v });
  }
  return { present, missing };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function KeyMetricsPanel({ ticker }) {
  const { data, isLoading, isError, error, refetch } = useStockDetail(ticker);
  const [expanded, setExpanded] = useState(false);

  const metrics = data?.metrics ?? null;
  const sectorMedians = data?.sectorMedians ?? null;

  const chunks = useMemo(() => {
    if (!metrics) return [];
    return CHUNKS
      .filter((c) => {
        if (!c.payersOnly) return true;
        const v = pluck(metrics, c.payersOnly);
        return v != null && Number.isFinite(v) && v > 0;
      })
      .map((c) => ({ ...c, ...partitionRows(c.items, metrics) }))
      .filter((c) => c.present.length > 0 || c.missing.length > 0);
  }, [metrics]);

  const allMissing = useMemo(
    () => chunks.flatMap((c) => c.missing),
    [chunks],
  );

  const visible = expanded ? chunks : chunks.slice(0, 1);
  const hiddenCount = chunks.length - visible.length;

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
          {/* Whole-group failure still gets a banner — that is a different
              fact from an individual metric being unreported. */}
          {metrics._reason && (
            <div className="mb-3 text-[10px] font-mono uppercase tracking-widest text-amber-400/80">
              {metrics._reason}
            </div>
          )}

          <div className="space-y-4">
            {visible.map((c) => (
              <MetricChunk key={c.title} chunk={c} medians={sectorMedians} />
            ))}
          </div>

          {hiddenCount > 0 && (
            <button
              type="button"
              onClick={() => setExpanded(true)}
              data-testid="key-metrics-show-all"
              className="mt-3 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 underline underline-offset-4"
            >
              Show all ({hiddenCount} more)
            </button>
          )}

          {/* One quiet line instead of a wall of "no data". */}
          {expanded && allMissing.length > 0 && (
            <p data-testid="key-metrics-missing" className="mt-3 text-[10px] text-neutral-600">
              Not reported: {allMissing.join(', ')}.
            </p>
          )}

          {/* _degraded last — it explains the whole payload, so it reads as a
              footer rather than competing with the numbers.

              IT IS AN OBJECT, NOT AN ARRAY. stock-detail.ts:122 types it
              `Record<string, string>` — dep name -> "<name>_timeout" |
              "<name>_error". The first cut of this banner array-checked it,
              so it silently never rendered against the real endpoint, and
              the test passed because its fixture invented an array. Reading
              the server's type instead of the fixture's is the whole lesson;
              degradedList() below is written against the declared shape. */}
          {degradedList(data?._degraded).length > 0 && (
            <p data-testid="key-metrics-degraded" className="mt-2 text-[10px] text-amber-400/80">
              Degraded sources: {degradedList(data._degraded).join(', ')}.
            </p>
          )}
        </>
      )}
    </section>
  );
}

function MetricChunk({ chunk, medians }) {
  if (!chunk.present.length) return null;
  return (
    <div>
      <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600 mb-1.5">
        {chunk.title}
      </div>
      <dl className="divide-y divide-neutral-900">
        {chunk.present.map((m) => (
          <MetricRow key={m.label} def={m} medians={medians} />
        ))}
      </dl>
    </div>
  );
}

function MetricRow({ def, medians }) {
  const median = pluck(medians, MEDIAN_PATH_MAP[def.path] ?? '');
  const displayValue = fmtValue(def.value, def.fmt);
  const displayMedian = fmtValue(median, def.fmt);
  const fav = favorability(def.key, def.value, median);

  return (
    <div
      data-testid={`metric-${def.path}`}
      className="flex items-baseline justify-between gap-3 py-1.5"
    >
      <dt className="text-[12px] text-neutral-400">{def.label}</dt>
      <dd className="flex items-baseline gap-2 text-right">
        {displayMedian != null && (
          <span className="text-[10px] text-neutral-600">sector: {displayMedian}</span>
        )}
        {fav !== 'none' && (
          <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${DOT_CLASS[fav]}`} />
        )}
        {/* tabular-nums: digits share a width, so the column aligns and
            magnitudes are comparable down the page. */}
        <span className="text-[13px] tabular-nums text-neutral-100">{displayValue}</span>
      </dd>
    </div>
  );
}
