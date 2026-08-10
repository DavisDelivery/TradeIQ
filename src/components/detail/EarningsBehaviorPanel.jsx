// PROFILE-1 W1.2 — how this name trades around earnings.
//
// The profile already fetched eight quarters and rendered one. The aggregate
// is the point: a single surprise is an anecdote, whereas "the average
// absolute move is 7.4% and the worst was −19%" is a position-sizing fact —
// it tells you what holding through a print actually costs.
//
// TWO HONESTY RULES THIS PANEL KEEPS:
//
// 1. THE WORST MOVE IS SIGNED. Showing |worst| would report a −19% quarter
//    as "19%", which inverts the direction of the risk being described.
//
// 2. UNMEASURABLE QUARTERS STAY VISIBLE AS UNMEASURABLE. A quarter whose
//    announcement date never resolved keeps its EPS and shows no move,
//    rather than being dropped — a panel that silently omits the quarters it
//    could not anchor understates how often the measurement fails. The
//    header prints measured/total for the same reason.

import React from 'react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

export const fmtPct1 = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';

export const fmtEps = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? `$${v.toFixed(2)}` : '—';

/** Quarter label from a fiscal period-end date: 2026-03-31 -> Q1 '26. */
export function quarterLabel(period) {
  if (typeof period !== 'string' || !/^\d{4}-\d{2}/.test(period)) return period ?? '—';
  const y = period.slice(2, 4);
  const m = Number(period.slice(5, 7));
  return `Q${Math.min(4, Math.max(1, Math.ceil(m / 3)))} '${y}`;
}

/**
 * Beat / miss / in-line from the surprise.
 *
 * Direction is genuine here and not a valuation judgement: beating an
 * estimate is a fact about the print, not a claim about the price. The
 * in-line band exists because a 0.4% surprise is rounding, not news.
 */
export function surpriseClass(surprisePct) {
  if (typeof surprisePct !== 'number' || !Number.isFinite(surprisePct)) return 'none';
  if (Math.abs(surprisePct) < 1) return 'inline';
  return surprisePct > 0 ? 'beat' : 'miss';
}

const DOT = {
  beat: 'bg-emerald-400',
  miss: 'bg-rose-400',
  inline: 'bg-neutral-500',
  none: 'bg-neutral-700',
};

export function EarningsBehaviorPanel({ ticker }) {
  const { data, isLoading } = useStockDetail(ticker);
  const behavior = data?.catalysts?.earningsBehavior ?? null;

  if (isLoading) {
    return (
      <section data-testid="earnings-behavior" className="border border-neutral-800/80 bg-neutral-950/30 p-4">
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">loading earnings…</div>
      </section>
    );
  }

  if (!behavior || !behavior.quarters?.length) return null;

  const { quarters, avgAbsMovePct, worstMovePct, measured, total } = behavior;

  return (
    <section data-testid="earnings-behavior" className="border border-neutral-800/80 bg-neutral-950/30 p-4">
      <header className="flex flex-wrap items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Around earnings
        </div>
        <div className="text-[9px] uppercase tracking-widest font-mono text-neutral-600">
          {measured} of {total} measured
        </div>
      </header>

      {/* The two facts that change position size, before the detail. */}
      <div className="flex flex-wrap gap-6 mb-4">
        <div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Avg move</div>
          <div className="text-[18px] tabular-nums text-neutral-100" data-testid="eb-avg">
            {typeof avgAbsMovePct === 'number' ? `${avgAbsMovePct.toFixed(1)}%` : '—'}
          </div>
        </div>
        <div>
          <div className="text-[10px] uppercase tracking-widest text-neutral-500">Worst move</div>
          <div className="text-[18px] tabular-nums text-neutral-100" data-testid="eb-worst">
            {fmtPct1(worstMovePct)}
          </div>
        </div>
      </div>

      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[9px] uppercase tracking-widest text-neutral-600">
            <th className="pb-1 font-normal">Quarter</th>
            <th className="pb-1 font-normal text-right">EPS</th>
            <th className="pb-1 font-normal text-right">Est.</th>
            <th className="pb-1 font-normal text-right">Surprise</th>
            <th className="pb-1 font-normal text-right">Move</th>
          </tr>
        </thead>
        <tbody>
          {quarters.map((q) => {
            const cls = surpriseClass(q.surprisePct);
            return (
              <tr key={q.period} data-testid={`eb-row-${q.period}`} className="border-t border-neutral-900">
                <td className="py-1.5 text-neutral-300">
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden className={`w-1.5 h-1.5 rounded-full ${DOT[cls]}`} />
                    {quarterLabel(q.period)}
                  </span>
                </td>
                <td className="py-1.5 text-right tabular-nums text-neutral-200">{fmtEps(q.epsActual)}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-500">{fmtEps(q.epsEstimate)}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-300">{fmtPct1(q.surprisePct)}</td>
                <td className="py-1.5 text-right tabular-nums text-neutral-100">{fmtPct1(q.reactionPct)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>

      {measured < total && (
        <p className="mt-2 text-[10px] text-neutral-600">
          {total - measured} quarter{total - measured === 1 ? '' : 's'} could not be anchored to an
          announcement date, so no move is shown for {total - measured === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/* The measurement's own limitation, stated where the numbers are. */}
      <p className="mt-2 text-[10px] text-neutral-600">
        Move spans the session before to the session after the report, so it holds whether the
        company reported before the open or after the close — the session is not available for
        past quarters.
      </p>
    </section>
  );
}
