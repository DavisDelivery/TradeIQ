// FABLE dossier header — "my stuff at top" (Chad, 2026-07-14).
//
// Rendered as the first section of StockDetailPanel when board === 'fable':
// composite + percentile, the five pillar bars each with a plain-language
// one-liner, the entry-discipline grid with its legend, and the standing
// NO_EDGE screener disclosure. The full investor profile (chart,
// financials, key metrics, catalysts, risk) follows below via the shared
// detail sections.

import React, { useState } from 'react';

export const FABLE_LEGEND = {
  ascent: {
    label: 'Ascent',
    short: 'weighted relative strength',
    plain:
      'How strongly the stock has outrun the market over the last 3-12 months, with the most weight on the last 3. 100 = among the strongest climbers.',
  },
  smoothPath: {
    label: 'Smooth Path',
    short: 'quality of the advance',
    plain:
      'Whether the rise came as steady daily gains (good — big money accumulating gradually) or a few violent jumps (fragile). Also checks the stock is beating the market on its own merits, not just riding it.',
  },
  highGround: {
    label: 'High Ground',
    short: '52-week-high proximity',
    plain:
      'How close price sits to its 52-week high. Stocks near highs tend to keep working because investors anchor on the old high and sell too early, delaying the full repricing.',
  },
  coiledSpring: {
    label: 'Coiled Spring',
    short: 'tight consolidation',
    plain:
      'Volatility and volume drying up while price holds near highs — the quiet, tight base that often precedes the next leg up. Scores low when the stock is extended or still thrashing.',
  },
  insiderEdge: {
    label: 'Insider Edge',
    short: 'executive open-market buying',
    plain:
      'Company insiders buying their own stock with their own money in the last 6 months. Rare for stocks near highs, so it is usually 0 — when present it is a strong extra signal, and a big sell cluster is a red flag.',
  },
};

export const FABLE_ENTRY_LEGEND = [
  {
    key: 'pivot',
    label: 'Entry pivot',
    plain: 'The buy trigger: a push above this price (just over the recent tight range) confirms the breakout you would buy.',
  },
  {
    key: 'stop',
    label: 'Stop',
    plain: 'The mechanical exit: if the stock closes below this (12% under entry), the position is cut — no debate, losses stay small.',
  },
  {
    key: 'proximity52w',
    label: '52w proximity',
    plain: 'How close price is to its 52-week high (100% = at the high). The gate requires at least 75%.',
  },
  {
    key: 'extension',
    label: 'Extension vs 50d',
    plain: 'How far price is stretched above its 50-day average. Small = buyable base; large = chasing, wait for a rest.',
  },
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

export function FablePillarsSection({ row }) {
  const [showLegend, setShowLegend] = useState(false);
  if (!row) return null;
  const d = row.diagnostics || {};
  const entryValues = {
    pivot: row.entry?.pivot != null ? `$${row.entry.pivot}` : '—',
    stop: row.entry?.stop != null ? `$${row.entry.stop}` : '—',
    proximity52w: d.proximity52w != null ? `${(d.proximity52w * 100).toFixed(1)}%` : '—',
    extension: d.extensionPct != null ? `${(d.extensionPct * 100).toFixed(1)}%` : '—',
  };

  return (
    <section
      className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 space-y-3"
      data-testid="fable-pillars-section"
    >
      <div className="flex items-baseline justify-between">
        <div>
          <div className="text-xs uppercase tracking-wide text-neutral-500">FABLE score</div>
          <div className="text-2xl font-bold text-neutral-100">
            {row.percentile?.toFixed(0)}
            <span className="ml-1 text-xs font-normal text-neutral-500">pctile</span>
            <span className="ml-3 text-sm font-semibold text-neutral-300">{row.composite}</span>
            <span className="ml-1 text-xs font-normal text-neutral-500">composite</span>
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
        {Object.entries(FABLE_LEGEND).map(([key, meta]) => (
          <div key={key}>
            <div className="mb-0.5 flex justify-between text-[11px]">
              <span className="text-neutral-300">
                {meta.label} <span className="text-neutral-600">· {meta.short}</span>
              </span>
              <span className="text-neutral-200">{row.pillars?.[key]?.toFixed(0) ?? '—'}</span>
            </div>
            <Bar value={row.pillars?.[key]} />
            {showLegend && <p className="mt-1 text-[11px] leading-relaxed text-neutral-500">{meta.plain}</p>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-2 border-t border-neutral-800 pt-3">
        {FABLE_ENTRY_LEGEND.map((item) => (
          <div key={item.key} className="text-[11px]">
            <span className="text-neutral-500">{item.label} </span>
            <span className="text-neutral-200 font-medium">{entryValues[item.key]}</span>
            {showLegend && <p className="mt-0.5 leading-relaxed text-neutral-600">{item.plain}</p>}
          </div>
        ))}
      </div>

      <p className="border-t border-neutral-800 pt-2 text-[10px] leading-relaxed text-neutral-600">
        Screener rank, not validated alpha: the pre-committed 2018–2024 backtest of this board
        measured NO_EDGE vs SPY. Discipline: book entry ≥90th pctile, exit &lt;60th, max hold 126
        trading days, stop at the level above.
      </p>
    </section>
  );
}
