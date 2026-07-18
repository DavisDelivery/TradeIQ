// TRIDENT dossier header — pillars + entry card + smart-money state.
// Mirrors FablePillarsSection (Chad's "my stuff at top" spec) for the
// TRIDENT board. Design: reports/trident/design.md §2.

import React, { useState } from 'react';

export const TRIDENT_LEGEND = {
  F: {
    label: 'Fundamental Thrust',
    short: 'growth getting stronger',
    plain:
      'Is the business itself speeding up? Earnings growth accelerating quarter over quarter, beating estimates, analysts raising their views, and profitability trending the right way.',
  },
  T: {
    label: 'Technical Setup',
    short: 'price ready to move',
    plain:
      'Is the chart in a position that historically precedes gains? Near 52-week highs, in a real uptrend, coiled in a tight base (or pulling back gently), with buying-pressure volume behind it.',
  },
  I: {
    label: 'Smart Money',
    short: 'institutions accumulating',
    plain:
      'Are professionals buying? Fresh activist (13D) stakes score highest, then high-conviction fund purchases from 13F filings, multiple funds piling in — minus a penalty when a name is crowded (high hedge-fund ownership plus high short interest).',
  },
};

export const TRIDENT_SUB_LEGEND = [
  ['f1Acceleration', 'Earnings acceleration', 'growth of the growth rate over the last 8 quarters'],
  ['f2Surprise', 'Surprise + streak', 'latest beat size and how many quarters in a row they beat'],
  ['f3Revisions', 'Analyst revisions', 'are analysts getting more bullish over the last 2 months'],
  ['f4Quality', 'Quality trend', 'return on equity and margin direction'],
  ['t1HighGround', '52-week-high proximity', 'stocks near highs tend to keep working (anchoring effect)'],
  ['t2TrendQuality', 'Trend quality', 'short MA vs 200-day distance + performance vs the index'],
  ['t3Coil', 'Coil / base', 'tight range with volume drying up — the setup before the move'],
  ['t4Volume', 'Volume evidence', 'unusual-volume days landing on up days, not down days'],
  ['i1Activist', 'Activist 13D', 'a live activist stake, freshest filings score highest'],
  ['i2Conviction', 'Fund conviction', 'curated funds adding big positions (13F)'],
  ['i3Cluster', 'Cluster', 'multiple tracked funds initiating the same quarter'],
  ['i4Crowding', 'Crowding penalty', 'high HF ownership + high short interest subtracts'],
  ['i5Insider', 'Insider buys', 'executives buying their own stock (90 days)'],
];

export const TRIDENT_ENTRY_LEGEND = [
  ['kind', 'Setup type', 'BREAKOUT = buy the push through the pivot; PULLBACK = buy the turn off an orderly dip in an uptrend'],
  ['pivot', 'Entry pivot', 'the price that confirms the setup — the trigger, not a prediction'],
  ['stop', 'Stop', 'the mechanical exit if it fails — cut it, no debate'],
];

function Bar({ value }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <div className="h-1.5 w-full rounded bg-neutral-800">
      <div
        className={`h-1.5 rounded ${v >= 70 ? 'bg-emerald-400' : v >= 40 ? 'bg-sky-400' : 'bg-neutral-600'}`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

export function TridentPillarsSection({ row }) {
  const [showLegend, setShowLegend] = useState(false);
  if (!row) return null;
  const p = row.pillars || {};
  const sub = p.sub || {};
  const warming = row.institutionalState === 'warming';

  return (
    <section
      className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 space-y-3"
      data-testid="trident-pillars-section"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">TRIDENT score</div>
          <div className="text-2xl font-bold text-neutral-100">
            {row.percentile?.toFixed(0)}
            <span className="ml-1 text-xs font-normal text-neutral-500">pctile</span>
            <span className="ml-3 text-sm font-semibold text-neutral-300">{row.composite}</span>
            <span className="ml-1 text-xs font-normal text-neutral-500">composite</span>
            {row.regimeAdjusted && (
              <span className="ml-3 rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-medium text-amber-300">
                regime-adjusted
              </span>
            )}
          </div>
        </div>
        <button
          onClick={() => setShowLegend(!showLegend)}
          className="rounded-lg border border-neutral-700 px-2.5 py-1 text-[11px] text-neutral-300 hover:bg-neutral-800"
          aria-expanded={showLegend}
        >
          {showLegend ? 'Hide legend' : 'What do these mean?'}
        </button>
      </div>

      <div className="space-y-2.5">
        {Object.entries(TRIDENT_LEGEND).map(([key, meta]) => {
          const val = key === 'I' && warming ? null : p[key];
          return (
            <div key={key}>
              <div className="mb-0.5 flex justify-between text-[11px]">
                <span className="text-neutral-300">
                  {meta.label} <span className="text-neutral-600">· {meta.short}</span>
                </span>
                <span className="text-neutral-200">
                  {val != null ? val.toFixed(0) : key === 'I' ? 'warming up' : '—'}
                </span>
              </div>
              <Bar value={val} />
              {showLegend && <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{meta.plain}</p>}
            </div>
          );
        })}
      </div>

      {showLegend && (
        <div className="grid grid-cols-1 gap-1 border-t border-neutral-800 pt-2 sm:grid-cols-2">
          {TRIDENT_SUB_LEGEND.map(([key, label, plain]) => (
            <p key={key} className="text-[10px] leading-relaxed text-neutral-500">
              <span className="text-neutral-300">{label}</span>
              {sub[key] != null && <span className="ml-1 text-neutral-200">{Number(sub[key]).toFixed(0)}</span>} — {plain}
            </p>
          ))}
        </div>
      )}

      <div className="grid grid-cols-3 gap-2 border-t border-neutral-800 pt-3">
        <div className="text-[11px]">
          <span className="text-neutral-500">Setup </span>
          <span className={`font-medium ${row.entry?.kind === 'BREAKOUT' ? 'text-sky-300' : row.entry?.kind === 'PULLBACK' ? 'text-emerald-300' : 'text-neutral-400'}`}>
            {row.entry?.kind ?? '—'}
          </span>
        </div>
        <div className="text-[11px]">
          <span className="text-neutral-500">Pivot </span>
          <span className="font-medium text-neutral-200">{row.entry?.pivot != null ? `$${row.entry.pivot}` : '—'}</span>
        </div>
        <div className="text-[11px]">
          <span className="text-neutral-500">Stop </span>
          <span className="font-medium text-neutral-200">{row.entry?.stop != null ? `$${row.entry.stop}` : '—'}</span>
        </div>
      </div>
      {row.entry?.note && <p className="text-[11px] text-neutral-500">{row.entry.note}</p>}
      {showLegend && (
        <div className="space-y-1 border-t border-neutral-800 pt-2">
          {TRIDENT_ENTRY_LEGEND.map(([k, label, plain]) => (
            <p key={k} className="text-[10px] leading-relaxed text-neutral-600">
              <span className="text-neutral-300">{label}</span> — {plain}
            </p>
          ))}
        </div>
      )}

      {warming && (
        <p className="rounded-lg border border-sky-500/20 bg-sky-500/5 p-2 text-[11px] leading-relaxed text-sky-300/90">
          Smart Money feeds (activist 13D + fund 13F) are still backfilling — this pillar joins the
          score automatically once populated. Until then the score is fundamentals + technicals,
          with insider buying shown for context.
        </p>
      )}

      <p className="border-t border-neutral-800 pt-2 text-[10px] leading-relaxed text-neutral-600">
        Labelled screener: the pre-committed backtest (reports/trident/design.md §5) has not yet
        stamped a verdict. Discipline: 21–63 trading-day horizon, stop at the level above, index
        regime gate applies to new entries.
      </p>
    </section>
  );
}
