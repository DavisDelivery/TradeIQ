// QS-1 — Quiet Strength (residual momentum).
//
// THE BANNER IS UNCONDITIONAL AND IT IS NOT COMPUTED HERE.
//
// The kickoff makes the expectation-setting sentence non-negotiable, so it
// renders in every state — loading, empty, error, stale — and the numbers in
// it come from `data.banner`, which the SCAN wrote into the snapshot after
// putting the gross figure through research-policy.haircutExcess. Computing
// "0.5–1.5pp" in this component would mean a front-end constant claiming a
// haircut it never applied, and would drift the moment the policy changed.

import React, { useMemo, useState } from 'react';
import { useQuietStrength } from './hooks/useQuietStrength.js';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

const BOARD = 'quiet-strength';

/** Fixed 1dp, with an explicit dash for "not measured". */
export function fmt1(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(1) : '—';
}

/** Score carries two decimals — ranks are close together near the cut. */
export function fmt2(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : '—';
}

export function fmtPct(v) {
  return typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
}

/** Exposure as a percentage of full size. */
export function fmtExposure(e) {
  if (!e || typeof e.exposure !== 'number' || !Number.isFinite(e.exposure)) return '—';
  return `${Math.round(e.exposure * 100)}%`;
}

export function EvidenceBanner({ banner, exposure, returnBasis }) {
  if (!banner) return null;
  return (
    <div className="mb-4 rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3">
      <p className="text-sm font-medium text-amber-200">{banner.headline}</p>
      <p className="mt-1 text-xs text-amber-200/80">
        Evidence: {banner.grade} · {banner.discovery} · policy {banner.policyVersion}
      </p>
      <p className="mt-1 text-xs text-amber-200/80">
        Sleeve exposure {fmtExposure(exposure)}
        {exposure?.bearDimmed ? ' (bear-dimmed)' : ''} · returns are{' '}
        {returnBasis === 'price' ? 'price-only (dividends not reinvested)' : returnBasis}
      </p>
    </div>
  );
}

export function QuietStrengthView() {
  const { data, isLoading, error } = useQuietStrength(40);
  const [selected, setSelected] = useState(null);

  const rows = useMemo(() => data?.rows ?? [], [data]);
  const selectedRow = useMemo(
    () => rows.find((r) => r.ticker === selected) ?? null,
    [rows, selected],
  );

  const list = (
    <div>
      <header className="mb-3">
        <h1 className="text-lg font-semibold text-neutral-100">Quiet Strength</h1>
        <p className="text-sm text-neutral-400">
          Residual momentum — the part of a 12-1 move that factor exposure does not explain.
        </p>
      </header>

      {/* Always rendered, in every state. */}
      <EvidenceBanner
        banner={data?.banner}
        exposure={data?.exposure}
        returnBasis={data?.returnBasis}
      />

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

      {isLoading && <p className="text-sm text-neutral-400">Loading…</p>}

      {!isLoading && rows.length === 0 && (
        <p className="text-sm text-neutral-400">
          {/* The server's note is preferred because it distinguishes states
              this component cannot: never-run, ran-and-refused-publication,
              and ran-and-found-nothing all render an empty table, and only
              the first is "has not completed yet". Saying that about a run
              that failed for a stated reason is how the QS-1 defect stayed
              invisible for a day. */}
          {data?.note
            ?? (data?.source === 'snapshot-missing'
              ? 'The first Quiet Strength scan has not completed yet.'
              : 'No names cleared the screen.')}
        </p>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 text-left text-xs uppercase text-neutral-500">
                <th className="py-2 pr-3">#</th>
                <th className="py-2 pr-3">Ticker</th>
                <th className="py-2 pr-3 text-right">Resid. score</th>
                <th className="py-2 pr-3 text-right">Plain 12-1</th>
                <th className="py-2 pr-3 text-right">β mkt</th>
                <th className="py-2 pr-3">Band</th>
                <th className="py-2 pr-3">Tranche</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.ticker}
                  onClick={() => setSelected(r.ticker)}
                  className={`cursor-pointer border-b border-neutral-900 hover:bg-neutral-800/40 ${
                    selected === r.ticker ? 'bg-neutral-800/60' : ''
                  }`}
                >
                  <td className="py-2 pr-3 text-neutral-500">{r.rank}</td>
                  <td className="py-2 pr-3 font-medium text-neutral-100">{r.ticker}</td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-200">
                    {fmt2(r.score)}
                  </td>
                  <td
                    className={`py-2 pr-3 text-right tabular-nums ${
                      r.plain12_1Pct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {fmtPct(r.plain12_1Pct)}
                  </td>
                  <td className="py-2 pr-3 text-right tabular-nums text-neutral-400">
                    {fmt1(r.betaMkt)}
                  </td>
                  <td className="py-2 pr-3">
                    <span
                      className={
                        r.band === 'enter'
                          ? 'rounded bg-emerald-500/15 px-1.5 py-0.5 text-xs text-emerald-300'
                          : 'rounded bg-neutral-700/40 px-1.5 py-0.5 text-xs text-neutral-300'
                      }
                    >
                      {r.band}
                    </span>
                  </td>
                  <td className="py-2 pr-3 text-neutral-400">{r.tranche}</td>
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

export default QuietStrengthView;
