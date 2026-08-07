// SECTOR-1 — sector context on every ticker profile.
//
// Answers three questions the profile could not answer before:
//   1. How is this stock's SECTOR doing, in absolute terms?
//   2. How is it doing relative to the market, and where does it rank?
//   3. Is this stock leading or lagging its own sector?
//
// (3) is the one with the best evidence behind it. Stock-versus-own-sector is
// closer to residual/idiosyncratic momentum (Blitz, Huij & Martens 2011) than
// raw sector strength is, and it is the number that separates "this stock is
// up because everything in its sector is up" from "this stock is doing
// something its peers are not".
//
// DESCRIPTIVE, NOT A SIGNAL. There is no score, no composite, no "sector is
// hot → buy". Industry momentum is real but contested — Grundy & Martin
// (2001) argued much of Moskowitz & Grinblatt's (1999) effect is individual
// stock momentum in disguise — and this app just retired six boards for
// presenting unvalidated rankings as guidance. Numbers and rank only; if a
// sector-conditioned screen gets built, the forward test measures it before
// the UI implies anything.

import React from 'react';
import { Layers } from 'lucide-react';
import { useSectorPerformance } from '../../hooks/useSectorPerformance.js';
import { useStockDetail } from '../../hooks/useStockDetail.js';
import { Ticker } from '../Ticker.jsx';

// 6M and 12M carry what evidence there is (Moskowitz & Grinblatt's IM(6,6)
// and IM(12,1)). 1M and 3M are recent-move context only: MG's own IM(1,1) is
// the strongest in-sample industry effect ever measured AND untradeable — it
// dies entirely on a one-month skip, and Grobys & Kolari (2019) measure it at
// 19bp/t=0.64 over 2001-2018. Shown as news, never as evidence.
const WINDOWS = [
  ['m1', '1M', 'context'],
  ['m3', '3M', 'context'],
  ['m6', '6M', 'evidenced'],
  ['m12', '12M', 'evidenced'],
];

const dash = <span className="text-neutral-600">—</span>;

function pct(v, digits = 1) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return dash;
  const cls = v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-neutral-300';
  return <span className={cls}>{v > 0 ? '+' : ''}{v.toFixed(digits)}%</span>;
}

export function SectorContextPanel({ ticker }) {
  const { bySector, sectors, asOf, unavailable, isLoading, error } = useSectorPerformance();
  const { data: detail } = useStockDetail(ticker);

  const sectorName = detail?.sector ?? null;
  const row = sectorName ? bySector[sectorName] : null;

  // Stock vs its OWN sector — the last point of the relative-strength series
  // stock-detail already computes. Absent is absent; never rendered as 0.
  const rs = detail?.relativeStrength;
  const vsSectorSeries = Array.isArray(rs?.vsSector) ? rs.vsSector : [];
  const vsSector = vsSectorSeries.length
    ? vsSectorSeries[vsSectorSeries.length - 1]?.cumulativeOutperformancePct
    : null;

  if (isLoading && !row) {
    return (
      <section data-testid="sector-context" className="border border-neutral-800/80 bg-neutral-950/30 p-4">
        <div className="text-[11px] font-mono text-neutral-500">Loading sector context…</div>
      </section>
    );
  }

  if (error || (!row && !isLoading)) {
    return (
      <section data-testid="sector-context" className="border border-neutral-800/80 bg-neutral-950/30 p-4">
        <div className="flex items-center gap-2 mb-1">
          <Layers className="h-3.5 w-3.5 text-neutral-500" aria-hidden="true" />
          <h3 className="text-[11px] font-mono uppercase tracking-widest text-neutral-500">Sector context</h3>
        </div>
        <div className="text-[11px] font-mono text-neutral-500">
          {error
            ? 'Sector table unavailable right now.'
            : sectorName
              ? `No sector performance data for ${sectorName}${unavailable.includes(sectorName) ? ' (ETF bars unavailable)' : ''}.`
              : 'Sector unknown for this ticker.'}
        </div>
      </section>
    );
  }

  return (
    <section data-testid="sector-context" className="border border-neutral-800/80 bg-neutral-950/30 p-4">
      <div className="flex items-baseline gap-2 mb-3 flex-wrap">
        <Layers className="h-3.5 w-3.5 text-neutral-500 self-center" aria-hidden="true" />
        <h3 className="text-[11px] font-mono uppercase tracking-widest text-neutral-500">Sector context</h3>
        <span className="text-[13px] font-semibold text-neutral-200">{row.sector}</span>
        <Ticker symbol={row.etf} board="sector" className="text-[11px] font-mono text-neutral-400" />
        {row.aboveSma200 != null && (
          <span
            className={`text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 border ${
              row.aboveSma200
                ? 'text-emerald-400 border-emerald-500/40'
                : 'text-rose-400 border-rose-500/40'
            }`}
          >
            {row.aboveSma200 ? 'above 200d' : 'below 200d'}
          </span>
        )}
        {asOf && <span className="ml-auto text-[9px] font-mono text-neutral-600">as of {asOf}</span>}
      </div>

      {/* STRONGEST ITEM ON THE PAGE, so it leads rather than trails.
          Stock-vs-own-sector is idiosyncratic/residual momentum in cheap
          form: Blitz, Huij & Martens (2011) measure ~2x the Sharpe of
          conventional momentum, replicated out-of-sample 2009-2015 (Huij &
          Lansdorp 2017) and across developed + emerging markets (Blitz,
          Hanauer & Vidojevic 2020). Blitz et al. (FAJ 2023) doubled a
          reversal factor's alpha (37bp -> 74bp, t 3.02 -> 9.24) purely by
          measuring the stock against its industry instead of the market. */}
      <div
        data-testid="stock-vs-sector"
        className="mb-3 pb-3 border-b border-neutral-800/80 flex items-baseline gap-2 flex-wrap"
      >
        <span className="text-[11px] font-mono text-neutral-400">{ticker} vs {row.etf}</span>
        <span className="text-[15px] font-mono tabular-nums font-semibold">
          {typeof vsSector === 'number' && Number.isFinite(vsSector)
            ? <span className={vsSector > 0 ? 'text-emerald-400' : vsSector < 0 ? 'text-rose-400' : 'text-neutral-300'}>
                {vsSector > 0 ? '+' : ''}{vsSector.toFixed(1)}%
              </span>
            : dash}
        </span>
        <span className="text-[10px] text-neutral-500">
          {typeof vsSector === 'number' && Number.isFinite(vsSector)
            ? vsSector > 0 ? 'leading its sector' : 'lagging its sector'
            : rs?._reason
              ? 'relative strength unavailable'
              : ''}
        </span>
        <span className="ml-auto text-[9px] font-mono uppercase tracking-wider text-neutral-600">
          cumulative, trailing window
        </span>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-[11px] font-mono" data-testid="sector-context-table">
          <thead>
            <tr className="text-neutral-500 border-b border-neutral-800/80">
              <th className="text-left font-normal py-1 pr-3" />
              {WINDOWS.map(([, label, weight]) => (
                <th
                  key={label}
                  className={`text-right font-normal py-1 px-2 ${weight === 'context' ? 'text-neutral-600' : ''}`}
                >
                  {label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 pr-3 text-neutral-400 whitespace-nowrap">Sector return</td>
              {WINDOWS.map(([key]) => (
                <td key={key} className="py-1.5 px-2 text-right tabular-nums">
                  {pct(row.windows?.[key]?.returnPct)}
                </td>
              ))}
            </tr>
            <tr className="border-b border-neutral-900">
              <td className="py-1.5 pr-3 text-neutral-400 whitespace-nowrap">vs SPY</td>
              {WINDOWS.map(([key]) => (
                <td key={key} className="py-1.5 px-2 text-right tabular-nums">
                  {typeof row.windows?.[key]?.vsSpyPp === 'number'
                    ? <span className={row.windows[key].vsSpyPp > 0 ? 'text-emerald-400' : row.windows[key].vsSpyPp < 0 ? 'text-rose-400' : 'text-neutral-300'}>
                        {row.windows[key].vsSpyPp > 0 ? '+' : ''}{row.windows[key].vsSpyPp.toFixed(1)}pp
                      </span>
                    : dash}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>

      <p className="mt-2 text-[10px] leading-relaxed text-neutral-600">
        Descriptive context, not a signal — nothing here is scored. Sector
        strength on its own stopped being measurable after 2001 (Grobys &amp;
        Kolari 2019: 6m t=0.37, 12m t=0.84). The stock-vs-sector line above is
        the part with real out-of-sample support, and no interaction between
        &ldquo;strong sector&rdquo; and &ldquo;good stock&rdquo; has ever been
        measured — so this page deliberately applies no multiplier.
      </p>
    </section>
  );
}
