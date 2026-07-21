// FABLE — Claude's own board. Design: reports/fable/design.md.
//
// Five pillars over a hard trend-template gate, 30-170 trading-day
// horizon, sp500. VERDICT (2026-07-14, bt_20260713215334_w80rb8): the
// pre-committed sp500 2018-2024 backtest measured NO_EDGE — net +34.5%
// vs SPY +107.9%, IC −0.017, active t −1.29; all three criteria failed.
// Per the binding rule FABLE ships as a LABELLED SCREENER: the gate and
// pillars describe trend quality, they do not claim validated alpha.
// Narrative never outranks measurement — including mine.

import React, { useEffect, useMemo, useState } from 'react';
import { VerdictChip } from './components/VerdictChip.jsx';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';
import { FABLE_LEGEND, FABLE_ENTRY_LEGEND } from './components/detail/FablePillarsSection.jsx';
import { useLiveRows } from './hooks/useLiveQuotes.js';

const PILLARS = Object.entries(FABLE_LEGEND).map(([key, m]) => [key, m.label, m.short]);

const REGIME_STYLES = {
  offense: 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300',
  defense: 'border-amber-500/40 bg-amber-500/10 text-amber-300',
  panic: 'border-rose-500/40 bg-rose-500/10 text-rose-300',
};

const REGIME_COPY = {
  offense: 'OFFENSE — SPY above its 200-day. New entries allowed.',
  defense: 'DEFENSE — SPY below its 200-day. Standing rule: no new entries; let exits work.',
  panic: 'PANIC — bear tape + vol spike (Daniel-Moskowitz momentum-hostile). Sit out.',
};

function PillarBar({ value }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full rounded bg-neutral-800">
      <div
        className={`h-1.5 rounded ${v >= 70 ? 'bg-emerald-400' : v >= 40 ? 'bg-sky-400' : 'bg-neutral-600'}`}
        style={{ width: `${v}%` }}
      />
    </div>
  );
}

function FableCard({ row, rank, onOpen }) {
  const [open, setOpen] = useState(false);
  const d = row.diagnostics || {};
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(!open)}>
        <span className="w-6 shrink-0 text-xs text-neutral-500">#{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-neutral-100">{row.ticker}</span>
            <span className="truncate text-xs text-neutral-500">{row.name}</span>
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-500">
            {row.sector} · <span className="text-neutral-300">${row.price?.toFixed(2)}</span>
            {row.priceChangePct != null && (
              <span className={`ml-1.5 ${row.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {row.priceChangePct >= 0 ? '+' : ''}{row.priceChangePct.toFixed(2)}%
              </span>
            )}
            {d.insiderBuyers90d > 0 && (
              <span className="ml-2 text-emerald-400">
                {d.insiderBuyers90d} insider buyer{d.insiderBuyers90d > 1 ? 's' : ''} 90d
              </span>
            )}
            {d.insiderSellVeto && <span className="ml-2 text-rose-400">sell cluster</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-bold text-neutral-100">{row.percentile?.toFixed(0)}</div>
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">pctile</div>
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          {PILLARS.map(([key, label, help]) => (
            <div key={key} title={help}>
              <div className="mb-0.5 flex justify-between text-[11px]">
                <span className="text-neutral-400">{label}</span>
                <span className="text-neutral-300">{row.pillars?.[key]?.toFixed(0)}</span>
              </div>
              <PillarBar value={row.pillars?.[key] ?? 0} />
            </div>
          ))}
          <div className="grid grid-cols-2 gap-2 pt-1 text-[11px] text-neutral-400">
            <div>
              Entry pivot <span className="text-neutral-200">${row.entry?.pivot}</span>
            </div>
            <div>
              Stop <span className="text-neutral-200">${row.entry?.stop}</span>
            </div>
            <div>
              52w proximity <span className="text-neutral-200">{(d.proximity52w * 100)?.toFixed(1)}%</span>
            </div>
            <div>
              Extension vs 50d <span className="text-neutral-200">{(d.extensionPct * 100)?.toFixed(1)}%</span>
            </div>
          </div>
          <p className="pt-1 text-[10px] leading-relaxed text-neutral-600">
            Discipline: book entry ≥90th pctile, exit &lt;60th (banding); max hold 126 trading
            days without re-qualifying; composite {row.composite}. Screener rank only — the
            pre-committed backtest measured NO_EDGE vs SPY (see board note).
          </p>
          <button
            onClick={() => onOpen?.(row)}
            className="mt-1 w-full rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
          >
            Full investor profile — chart · financials · company info →
          </button>
        </div>
      )}
    </div>
  );
}

/** Board-level legend: what every pillar and entry stat means, in plain language. */
function FableLegend() {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 space-y-3 text-[12px] leading-relaxed">
      <div className="text-xs uppercase tracking-wide text-neutral-400">How to read this board</div>
      {Object.values(FABLE_LEGEND).map((m) => (
        <p key={m.label} className="text-neutral-400">
          <span className="font-semibold text-neutral-200">{m.label}</span> — {m.plain}
        </p>
      ))}
      <div className="border-t border-neutral-800 pt-2 space-y-2">
        {FABLE_ENTRY_LEGEND.map((m) => (
          <p key={m.key} className="text-neutral-400">
            <span className="font-semibold text-neutral-200">{m.label}</span> — {m.plain}
          </p>
        ))}
      </div>
      <p className="border-t border-neutral-800 pt-2 text-neutral-500">
        A stock only appears here at all if it passed the FOUNDATION gate: price above its rising
        50/150/200-day averages, at least 30% off its 52-week low, within 25% of its 52-week high,
        and positive 12-month momentum. The percentile ranks gate-passers against each other.
      </p>
    </div>
  );
}

export function FableView() {
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null);
  const [showLegend, setShowLegend] = useState(false);

  const load = async (force = false) => {
    setLoading(true);
    setErr(null);
    try {
      const r = await fetch(`/api/fable-board?limit=30${force ? '&force=1' : ''}`);
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'load failed');
      setData(j);
    } catch (e) {
      setErr(String(e.message || e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const rawPicks = useMemo(() => data?.picks ?? [], [data]);
  // Overlay live price + intraday %-change (shared quotes poll) so the board
  // shows a current quote, not just the frozen snapshot price.
  const picks = useLiveRows(rawPicks);
  const regime = data?.regime ?? null;

  const list = (
    <div className="mx-auto max-w-3xl space-y-4 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <h1 className="text-xl font-bold text-neutral-100">FABLE</h1>
        <VerdictChip board="fable" />
        <button
          onClick={() => setShowLegend(!showLegend)}
          className="ml-auto rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
          aria-expanded={showLegend}
        >
          {showLegend ? 'Hide legend' : 'Legend'}
        </button>
        <button
          onClick={() => load(true)}
          className="rounded-lg border border-neutral-700 px-3 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Rescan
        </button>
      </div>

      {showLegend && <FableLegend />}

      <p className="text-xs leading-relaxed text-neutral-500">
        My board — designed from a blank slate for 30–170 day holds. A hard trend-template
        gate (50&gt;150&gt;200 rising, ≥30% off lows, within 25% of highs), then five pillars:
        Ascent, Smooth Path, High Ground, Coiled Spring, Insider Edge. Equal-weight, fixed
        constants, pre-committed validation (reports/fable/design.md).
      </p>

      <div className="rounded-lg border border-neutral-700 bg-neutral-900 px-3 py-2 text-[11px] leading-relaxed text-neutral-400">
        <span className="font-semibold text-neutral-300">Screener, not edge.</span> The
        pre-committed 2018–2024 sp500 backtest measured NO_EDGE: net +34.5% vs SPY +107.9%,
        IC −0.017, active-return t −1.29 — all three validation criteria failed
        (run bt_20260713215334_w80rb8). Per the binding rule, FABLE ranks trend quality;
        it does not claim to beat buy-and-hold. I designed it, I tested it honestly, and
        this is what the measurement said.
      </div>

      {regime && (
        <div className={`rounded-lg border px-3 py-2 text-xs ${REGIME_STYLES[regime] ?? ''}`}>
          {REGIME_COPY[regime] ?? regime}
        </div>
      )}

      {data && (
        <div className="flex flex-wrap gap-3 text-[11px] text-neutral-500">
          <span>
            Gate passers: <span className="text-neutral-300">{data.gatePassers ?? '—'}</span> /{' '}
            {data.universeChecked ?? '—'}
          </span>
          {data.generatedAt && (
            <span>
              Scanned {new Date(data.generatedAt).toLocaleString()}
              {data.stale && <span className="ml-1 text-amber-400">(stale)</span>}
              {data.degraded && <span className="ml-1 text-rose-400">(degraded)</span>}
            </span>
          )}
        </div>
      )}

      {loading && <div className="py-10 text-center text-sm text-neutral-500">Loading FABLE…</div>}
      {err && <div className="py-6 text-center text-sm text-rose-400">{err}</div>}
      {!loading && !err && picks.length === 0 && (
        <div className="py-10 text-center text-sm text-neutral-500">
          {data?.note ?? 'No names pass the Foundation gate right now — that is a position, not a bug.'}
        </div>
      )}

      <div className="space-y-2">
        {picks.map((row, i) => (
          <FableCard key={row.ticker} row={row} rank={i + 1} onOpen={setSelected} />
        ))}
      </div>
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="fable" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close FABLE detail"
    />
  );
}
