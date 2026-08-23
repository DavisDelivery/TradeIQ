// COMP-1 — Compounders (quality-led, momentum-confirmed).
//
// THE BANNER IS UNCONDITIONAL AND IT IS NOT COMPUTED HERE.
//
// Same discipline as QuietStrengthView, and it binds harder on this board.
// Quiet Strength borrows a replicated external measurement of its own signal;
// this board has none — the two INPUTS replicate, the 0.6/0.4 blend of them
// has never been measured anywhere, and an unlabelled ranking of famous
// mega-caps reads as a recommendation. So the banner renders in every state
// (loading, empty, stale, error) and every word of it comes from
// `data.banner`, which the scan built by putting a null through
// research-policy.haircutExcess. A headline assembled in this component would
// be a front-end constant claiming a haircut it never applied.
//
// The verdict chip beside the title is the registry speaking
// (netlify/functions/shared/verdicts.ts → 'compounders' = UNMEASURED). Two
// independent surfaces state the same absence on purpose: the banner travels
// with the payload and the chip survives the payload being missing entirely.

import React, { useMemo, useState } from 'react';
import { useCompounders } from './hooks/useCompounders.js';
import { VerdictChip } from './components/VerdictChip.jsx';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

const BOARD = 'compounders';

/** The one basis Novy-Marx's replication actually rests on. */
export const EXACT_BASIS = 'gross-profits-to-assets';

/**
 * Anything that is not the exact ratio is a PROXY and must look like one.
 *
 * The fallback is ROE, whose denominator is equity — so a company can
 * manufacture the number by borrowing, which is exactly the failure gross
 * profits over ASSETS does not have (compounders.qualityOf documents it).
 * Written as `!== EXACT` rather than `=== 'roe-proxy'` so a basis added to
 * QualityBasis later is treated as unproven until someone decides otherwise,
 * rather than silently rendering as exact.
 */
export function isProxyBasis(basis) {
  return basis !== EXACT_BASIS;
}

/**
 * The composite carries THREE decimals.
 *
 * It is a 0..1 blend of two percentile ranks, and the top 40 of several
 * hundred finalists crowd into the last few hundredths of it. At 2dp the
 * board would print ranks 6 through 14 as the same "0.96" — ties that are
 * not ties, on the only column a reader uses to judge how close the cut was.
 */
export function fmtScore(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—';
}

/** A 0..1 percentile as whole points. `null` means the axis was unscorable. */
export function fmtPctile(v) {
  return typeof v === 'number' && Number.isFinite(v) ? String(Math.round(v * 100)) : '—';
}

/** Signed percent, 1dp, with an explicit dash for "not measured". */
export function fmtPct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
}

/**
 * The per-row proxy tag.
 *
 * Rendered on the row rather than only in a footnote because the two bases
 * are not two flavours of the same number — a proxied name is ranked on a
 * ratio leverage can inflate, and a reader comparing row 3 against row 4 has
 * to be able to see that from the row.
 */
export function QualityBasisTag({ basis }) {
  if (!isProxyBasis(basis)) return null;
  return (
    <span
      data-testid="quality-basis-proxy"
      title={
        'Ranked on the ROE proxy, not gross profits / total assets. ROE has equity in the ' +
        'denominator, so leverage can inflate it; the exact ratio cannot be gamed that way.'
      }
      className="ml-1.5 rounded bg-amber-500/15 px-1 py-0.5 text-[9px] font-mono uppercase tracking-wider text-amber-300 align-middle"
    >
      ROE proxy
    </span>
  );
}

export function EvidenceBanner({ banner }) {
  if (!banner) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <p className="text-sm font-medium text-amber-200">{banner.headline}</p>
      <p className="mt-1 text-xs text-amber-200/80">
        Evidence: {banner.grade} · {banner.discovery} · policy {banner.policyVersion}
      </p>
      {/* The missing value axis is a stated departure from the house
          construction, and the payload carries the sentence so the reason
          travels with the board rather than living in a component someone
          can refactor away. */}
      {banner.departure && (
        <p className="mt-1 text-xs text-amber-200/80">{banner.departure}</p>
      )}
    </div>
  );
}

/**
 * How much of the board is ranked on the proxy, stated for the WHOLE run.
 *
 * The row tags cover what is on screen; this covers what was scored. "38 of
 * 40 exact" and "2 of 40 exact" are the same board by every other number in
 * the payload and only one of them is ranked on the definition that
 * replicated, so the count gets its own line instead of being inferable by
 * counting badges.
 */
export function BasisSummary({ scored, exactBasisCount }) {
  if (typeof scored !== 'number' || typeof exactBasisCount !== 'number') return null;
  if (scored <= 0) return null;
  const proxied = Math.max(0, scored - exactBasisCount);
  if (proxied === 0) {
    return (
      <p className="mb-3 text-xs text-neutral-400">
        All {scored} ranked names use the exact quality ratio (gross profits / total assets).
      </p>
    );
  }
  return (
    <p data-testid="basis-summary" className="mb-3 text-xs text-amber-300">
      {proxied} of {scored} ranked names fell back to the ROE proxy — a ratio a levered
      balance sheet can inflate. Only {exactBasisCount} are ranked on gross profits / total
      assets, the basis that survived replication.
    </p>
  );
}

export function CompoundersView() {
  const { data, isLoading, error } = useCompounders(40);
  const [selected, setSelected] = useState(null);
  const [sector, setSector] = useState('all');

  const rows = useMemo(() => data?.rows ?? [], [data]);

  // Server order is the ranking. The filter narrows it; it never re-sorts.
  const sectors = useMemo(() => {
    const seen = [];
    for (const r of rows) {
      if (r.sector && !seen.includes(r.sector)) seen.push(r.sector);
    }
    return seen.sort();
  }, [rows]);

  const visible = useMemo(
    () => (sector === 'all' ? rows : rows.filter((r) => r.sector === sector)),
    [rows, sector],
  );

  const selectedRow = useMemo(
    () => rows.find((r) => r.ticker === selected) ?? null,
    [rows, selected],
  );

  const list = (
    <div>
      <header className="mb-3">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold text-neutral-100">Compounders</h1>
          <VerdictChip board={BOARD} />
        </div>
        <p className="text-sm text-neutral-400">
          Quality first — gross profits over assets — with 12-1 momentum only confirming,
          integrated into one score. No value axis.
        </p>
      </header>

      {/* Always rendered, in every state. */}
      <EvidenceBanner banner={data?.banner} />

      {data?.stale && (
        <p className="mb-3 text-xs text-amber-300">
          Snapshot is stale — showing the last completed scan.
        </p>
      )}

      {/* An error must not blank rows we already have. */}
      {error && (
        <p className="mb-3 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          {String(error.message ?? error)}
        </p>
      )}

      {Array.isArray(data?.warnings) && data.warnings.length > 0 && (
        <ul className="mb-3 space-y-1">
          {data.warnings.map((w) => (
            <li key={w} className="text-xs text-neutral-400">· {w}</li>
          ))}
        </ul>
      )}

      <BasisSummary scored={data?.scored} exactBasisCount={data?.exactBasisCount} />

      {/* CONTROL ROW — flex-wrap is not cosmetic here.
          A non-wrapping control row has already shipped a bug in this app:
          on a phone the buttons ran past the right edge with nothing to
          scroll them back, so the filters at the end were unreachable. Wrap
          means a narrow screen gets three rows of chips instead of a row of
          chips it cannot reach. */}
      {sectors.length > 1 && (
        <div data-testid="sector-filter" className="mb-4 flex flex-wrap items-center gap-2">
          {['all', ...sectors].map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setSector(s)}
              aria-pressed={sector === s}
              className={`rounded border px-2 py-1 text-xs ${
                sector === s
                  ? 'border-neutral-500 bg-neutral-700/60 text-neutral-100'
                  : 'border-neutral-800 bg-neutral-900/60 text-neutral-400 hover:text-neutral-200'
              }`}
            >
              {s === 'all' ? 'All sectors' : s}
            </button>
          ))}
        </div>
      )}

      {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-neutral-400">
          {/* QS-1 POST-MORTEM, inherited: never-run, ran-and-refused-publication
              and ran-and-found-nothing all render an empty table, and only the
              first is "has not completed yet". The server's note distinguishes
              them; this component cannot. */}
          {data?.note
            ?? (data?.source === 'snapshot-missing'
              ? 'The first Compounders scan has not completed yet.'
              : 'No names cleared the screen.')}
        </p>
      )}

      {rows.length > 0 && visible.length === 0 && (
        <p className="text-sm text-neutral-400">No ranked names in {sector}.</p>
      )}

      {visible.length > 0 && (
        // The table scrolls INSIDE this container. Without it the widest
        // column pushes the whole page sideways on a phone, which drags the
        // nav and the banner off-screen with it.
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Ticker</th>
                <th className="py-2 pr-3 text-right">Score</th>
                <th className="py-2 pr-3 text-right">Quality %ile</th>
                <th className="py-2 pr-3 text-right">Mom %ile</th>
                <th className="py-2 pr-3 text-right">12-1</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((r) => (
                <tr
                  key={r.ticker}
                  onClick={() => setSelected(r.ticker)}
                  className={`cursor-pointer border-b border-neutral-900 hover:bg-neutral-800/40 ${
                    selected === r.ticker ? 'bg-neutral-800/60' : ''
                  }`}
                >
                  <td className="py-2 pr-3 text-neutral-500">{r.rank}</td>
                  <td className="py-2 pr-3">
                    <span className="font-medium text-neutral-100">{r.ticker}</span>
                    <QualityBasisTag basis={r.qualityBasis} />
                    {/* Sector rides under the ticker rather than taking a
                        column of its own: the sector names are long, and a
                        seventh column is what makes a phone scroll. */}
                    {r.sector && (
                      <span className="block text-[10px] text-neutral-500">{r.sector}</span>
                    )}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-200">
                    {fmtScore(r.composite)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                    {fmtPctile(r.qualityPct)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                    {fmtPctile(r.momentumPct)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${
                      r.momentum12_1Pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {fmtPct(r.momentum12_1Pct)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {data?.disclosure && (
        <p className="mt-4 text-xs leading-relaxed text-neutral-500">{data.disclosure}</p>
      )}
    </div>
  );

  return (
    <MasterDetail
      list={list}
      selected={selected}
      onClose={() => setSelected(null)}
      detail={
        selectedRow ? (
          <StockDetailPanel board={BOARD} ticker={selectedRow.ticker} row={selectedRow} />
        ) : null
      }
    />
  );
}

export default CompoundersView;
