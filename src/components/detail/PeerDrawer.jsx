// PROFILE-1 W3 — the peer drawer.
//
// NOT A SHEET, NOT A MODAL. Tapping a metric row unfolds the detail directly
// beneath it and pushes the rows below down. The profile already renders
// inside TickerDetailModal, so a sheet would be an overlay over an overlay —
// exactly the arrangement #196 records going wrong against the sticky header.
// A drawer has no overlay at all: nothing to stack, no focus to trap, no
// Escape key to arbitrate between two owners.
//
// THE SLIDE uses the grid-rows 0fr -> 1fr technique. It animates to the
// content's NATURAL height with no measurement, no ResizeObserver, and no
// hardcoded max-height that silently clips a longer peer list. Honoured only
// when the reader has not asked for reduced motion.
//
// LAZY BY CONSTRUCTION. Nothing is fetched until a drawer opens. Reading the
// sharded universe is a manifest plus every shard — affordable once per
// curiosity, not once per page load — which is the reason this is a drawer
// and not a column of pre-computed percentiles.

import React from 'react';
import { usePeerStat } from '../../hooks/usePeerStat.js';

/** Where the subject sits inside the winsorized display window, 0..1. */
export function markerPosition(value, low, high) {
  if (![value, low, high].every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  if (high <= low) return 0.5;
  return Math.min(1, Math.max(0, (value - low) / (high - low)));
}

export function fmtStat(v) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1000) return v.toFixed(0);
  if (a >= 10) return v.toFixed(1);
  return v.toFixed(2);
}

function DistributionStrip({ stat }) {
  const pos = markerPosition(stat.subjectValue, stat.displayLow, stat.displayHigh);
  const medPos = markerPosition(stat.median, stat.displayLow, stat.displayHigh);
  if (pos === null) return null;

  return (
    <div className="mt-3" data-testid="peer-strip">
      <div className="relative h-6">
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded bg-neutral-800" />
        {medPos !== null && (
          <div
            data-testid="peer-median-tick"
            className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-neutral-500"
            style={{ left: `${medPos * 100}%` }}
            aria-hidden
          />
        )}
        <div
          data-testid="peer-marker"
          className="absolute top-1/2 h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-neutral-100"
          style={{ left: `${pos * 100}%` }}
          aria-hidden
        />
      </div>
      <div className="flex justify-between text-[9px] tabular-nums text-neutral-600">
        <span>{fmtStat(stat.displayLow)}</span>
        <span>median {fmtStat(stat.median)}</span>
        <span>{fmtStat(stat.displayHigh)}</span>
      </div>
    </div>
  );
}

/**
 * What the metric IS, before anything about where it sits.
 *
 * W3.2 — this is the half that made every row worth tapping. It comes from
 * the direction table, so a metric cannot be defined one way here and
 * phrased another way in the stat row.
 */
function Explainer({ policy }) {
  if (!policy) return null;
  return (
    <div data-testid="peer-explainer">
      <p className="text-[11px] leading-relaxed text-neutral-300">{policy.meaning}</p>
      {policy.caveat && (
        <p className="mt-1.5 text-[10px] leading-relaxed text-neutral-500" data-testid="peer-caveat">
          {policy.caveat}
        </p>
      )}
    </div>
  );
}

function PeerBody({ ticker, metricKey, open }) {
  // `enabled: open` is what makes this lazy — a closed drawer costs nothing.
  const { data, isLoading, isError, error } = usePeerStat(ticker, metricKey, { enabled: open });

  if (isLoading) {
    return <p className="text-[11px] text-neutral-500">Loading peers…</p>;
  }
  if (isError) {
    return (
      <p className="text-[11px] text-rose-300">
        Couldn't load peers: {String(error?.message ?? 'unknown')}
      </p>
    );
  }

  const stat = data?.stat ?? null;
  const policy = data?.policy ?? null;

  // A refusal is an ANSWER, so it renders as prose rather than as an error —
  // and the definition still leads, because that is why the row was tapped.
  if (!stat) {
    return (
      <div>
        <Explainer policy={policy} />
        <p className={`text-[10px] leading-relaxed text-neutral-500 ${policy ? 'mt-2' : ''}`}>
          {data?.note ?? 'No peer comparison available.'}
        </p>
      </div>
    );
  }

  return (
    <div>
      <Explainer policy={policy} />

      <p className={`text-[11px] leading-relaxed text-neutral-300 ${policy ? 'mt-2.5' : ''}`} data-testid="peer-phrase">
        {stat.phrase}
      </p>

      {stat.percentile !== null && <DistributionStrip stat={stat} />}

      {/* Provenance, always — level and N, never just a percentile. */}
      <p className="mt-2 text-[10px] text-neutral-600" data-testid="peer-provenance">
        Pool: {stat.poolLabel} · n={stat.n}
        {stat.exclusionNote ? ` · ${stat.exclusionNote}` : ''}
      </p>

      {stat.percentile !== null && (
        <p className="mt-1 text-[10px] text-neutral-600">{stat.winsorNote}</p>
      )}

      {/* Small pool: the names ARE the answer. */}
      {Array.isArray(stat.peers) && stat.peers.length > 0 && (
        <div className="mt-2" data-testid="peer-list">
          <div className="text-[9px] uppercase tracking-widest text-neutral-600 mb-1">Peers</div>
          <ul className="flex flex-wrap gap-x-3 gap-y-1">
            {stat.peers.map((p) => (
              <li key={p.ticker} className="text-[10px] tabular-nums text-neutral-400">
                {p.ticker} {fmtStat(p.value)}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PeerDrawer({ ticker, metricKey, open }) {
  return (
    <div
      data-testid="peer-drawer"
      data-open={open ? 'true' : 'false'}
      // 0fr -> 1fr animates to natural height with no measurement.
      className={`grid overflow-hidden transition-[grid-template-rows] duration-200 ease-out motion-reduce:transition-none ${
        open ? 'grid-rows-[1fr]' : 'grid-rows-[0fr]'
      }`}
    >
      <div className="min-h-0">
        <div className="pb-3 pl-1 pr-1">
          {open && <PeerBody ticker={ticker} metricKey={metricKey} open={open} />}
        </div>
      </div>
    </div>
  );
}
