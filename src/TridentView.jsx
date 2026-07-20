// TRIDENT — near-term picker: fundamentals × technicals × institutional
// flow, with the NQ/SPX regime panel Chad asked for up top.
// Design + binding validation rule: reports/trident/design.md.

import React, { useEffect, useMemo, useState } from 'react';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';
import { AdvancedPriceChart } from './components/detail/AdvancedPriceChart.jsx';
import { TRIDENT_LEGEND } from './components/detail/TridentPillarsSection.jsx';
import { useLiveRows, useLiveQuotes } from './hooks/useLiveQuotes.js';

const UNIVERSES = [
  { id: 'sp500', label: 'S&P 500' },
  { id: 'russell2k', label: 'Russell 2000' },
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

const TREND_STYLE = {
  UP: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
  DOWN: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
  FLAT: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
};

const STRETCH_COPY = {
  'deeply oversold': 'deeply oversold within an uptrend — historically a pullback-entry window',
  oversold: 'oversold',
  neutral: 'neutral',
  strong: 'strong tape',
  overbought: 'overbought — usually trend STRENGTH, not a sell signal; shown as context only',
};

function RegimeCard({ title, symbol, r, quote }) {
  const [open, setOpen] = useState(false);
  if (!r) {
    return (
      <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3 text-xs text-neutral-500">
        {title}: no regime data yet
      </div>
    );
  }
  const nearest = (r.levels || []).slice(0, 3);
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
      <button className="flex w-full items-center justify-between gap-2 text-left" onClick={() => setOpen(!open)}>
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-neutral-100">{title}</span>
          <span className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${TREND_STYLE[r.trend?.state] ?? ''}`}>
            {r.trend?.state}
          </span>
          <span className="text-[11px] text-neutral-400">RSI14 {r.stretch?.rsi14?.toFixed(0)}</span>
          <span className="text-[11px] text-neutral-500">· {r.stretch?.label}</span>
        </div>
        <span className="text-xs text-neutral-500">
          <span className="text-neutral-300">${(quote?.price ?? r.lastClose)?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
          {quote?.changePct != null && (
            <span className={quote.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
              {' '}{quote.changePct >= 0 ? '+' : ''}{quote.changePct.toFixed(2)}%
            </span>
          )}
          {' '}{open ? '▾' : '▸'}
        </span>
      </button>
      {open && (
        <div className="mt-2 space-y-2 border-t border-neutral-800 pt-2 text-[11px] leading-relaxed">
          {symbol && <AdvancedPriceChart ticker={symbol} />}
          <p className="text-neutral-400">{STRETCH_COPY[r.stretch?.label] ?? r.stretch?.label}</p>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-neutral-400">
            <span>RSI(2): <span className="text-neutral-200">{r.stretch?.rsi2?.toFixed(0)}</span></span>
            <span>20d channel: <span className="text-neutral-200">{r.stretch?.donchian20Pos?.toFixed(0)}%</span></span>
            <span>Realized vol: <span className="text-neutral-200">{r.stretch?.realizedVol21Ann?.toFixed(0)}% ({r.stretch?.volPctile2y}th pctile)</span></span>
            <span>Off 52w high: <span className="text-neutral-200">{r.drawdown?.fromHigh252Pct}%</span></span>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-500">Nearest levels (reference, not prediction)</div>
            {nearest.map((l) => (
              <div key={`${l.kind}-${l.price}`} className="flex justify-between text-neutral-400">
                <span>{l.kind.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase())}</span>
                <span className="text-neutral-200">
                  ${l.price} <span className={l.distancePct >= 0 ? 'text-sky-300' : 'text-emerald-300'}>({l.distancePct > 0 ? '+' : ''}{l.distancePct}%)</span>
                </span>
              </div>
            ))}
          </div>
          {(r.modulation?.reasons?.length ?? 0) > 0 && (
            <div className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-amber-300/90">
              {r.modulation.reasons.map((x) => <p key={x}>{x}</p>)}
            </div>
          )}
          {r.modulation?.entriesAllowed === false && (
            <p className="font-medium text-rose-300">New entries gated for this universe.</p>
          )}
        </div>
      )}
    </div>
  );
}

function TridentCard({ row, rank, onOpen }) {
  const [open, setOpen] = useState(false);
  const p = row.pillars || {};
  const warming = row.institutionalState === 'warming';
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
      <button className="flex w-full items-center gap-3 text-left" onClick={() => setOpen(!open)}>
        <span className="w-6 shrink-0 text-xs text-neutral-500">#{rank}</span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="font-semibold text-neutral-100">{row.ticker}</span>
            <span className="truncate text-xs text-neutral-500">{row.name}</span>
            {row.entry?.kind && row.entry.kind !== 'NONE' && (
              <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${row.entry.kind === 'BREAKOUT' ? 'bg-sky-500/15 text-sky-300' : 'bg-emerald-500/15 text-emerald-300'}`}>
                {row.entry.kind}
              </span>
            )}
          </div>
          <div className="mt-0.5 text-[11px] text-neutral-500">
            {row.sector} · <span className="text-neutral-300">${row.price?.toFixed(2)}</span>
            {row.priceChangePct != null && (
              <span className={`ml-1.5 ${row.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {row.priceChangePct >= 0 ? '+' : ''}{row.priceChangePct.toFixed(2)}%
              </span>
            )}
            {row.regimeAdjusted && <span className="ml-2 text-amber-400">regime-adjusted</span>}
          </div>
        </div>
        <div className="shrink-0 text-right">
          <div className="text-lg font-bold text-neutral-100">{row.percentile?.toFixed(0)}</div>
          <div className="text-[10px] uppercase tracking-wide text-neutral-500">pctile</div>
        </div>
      </button>
      {open && (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          {Object.entries(TRIDENT_LEGEND).map(([key, meta]) => {
            const val = key === 'I' && warming ? null : p[key];
            return (
              <div key={key} title={meta.plain}>
                <div className="mb-0.5 flex justify-between text-[11px]">
                  <span className="text-neutral-400">{meta.label}</span>
                  <span className="text-neutral-300">{val != null ? val.toFixed(0) : 'warming'}</span>
                </div>
                <Bar value={val} />
              </div>
            );
          })}
          <div className="grid grid-cols-3 gap-2 pt-1 text-[11px] text-neutral-400">
            <div>Pivot <span className="text-neutral-200">{row.entry?.pivot != null ? `$${row.entry.pivot}` : '—'}</span></div>
            <div>Stop <span className="text-neutral-200">{row.entry?.stop != null ? `$${row.entry.stop}` : '—'}</span></div>
            <div>Composite <span className="text-neutral-200">{row.composite}</span></div>
          </div>
          <button
            onClick={() => onOpen?.(row)}
            className="mt-1 w-full rounded-lg border border-sky-500/40 bg-sky-500/10 px-3 py-2 text-xs font-medium text-sky-300 hover:bg-sky-500/20"
          >
            Full investor profile — chart · financials · smart money →
          </button>
        </div>
      )}
    </div>
  );
}

function TridentLegend() {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-4 space-y-3 text-[12px] leading-relaxed">
      <div className="text-xs uppercase tracking-wide text-neutral-400">How to read this board</div>
      {Object.values(TRIDENT_LEGEND).map((m) => (
        <p key={m.label} className="text-neutral-400">
          <span className="font-semibold text-neutral-200">{m.label}</span> — {m.plain}
        </p>
      ))}
      <p className="border-t border-neutral-800 pt-2 text-neutral-500">
        A stock only appears if it passed the gate: liquid, above $3, in a REAL uptrend (above a
        rising 200-day average), and — for small caps — not a junk balance sheet. The index panel
        above modulates entries: downtrend gates them, high volatility shrinks them, choppy tape
        favors pullback setups over breakouts. Horizon: 21–63 trading days. This board is a
        labelled screener until its pre-committed backtest stamps a verdict.
      </p>
    </div>
  );
}

export function TridentView() {
  const [universe, setUniverse] = useState('sp500');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [showLegend, setShowLegend] = useState(false);
  const [selected, setSelected] = useState(null);

  useEffect(() => {
    let dead = false;
    setLoading(true);
    setError(null);
    fetch(`/api/trident-board?universe=${universe}&limit=60`)
      .then((r) => r.json())
      .then((d) => { if (!dead) { setData(d); setLoading(false); } })
      .catch((e) => { if (!dead) { setError(String(e)); setLoading(false); } });
    return () => { dead = true; };
  }, [universe]);

  const rows = data?.rows ?? [];
  const regime = data?.regime;
  // Live prices + intraday %-change overlaid on the (older) snapshot — same
  // shared quotes poll every other board uses. Rows fall back to the scored
  // price when a live quote is missing; the index ETFs feed the regime cards.
  const liveRows = useLiveRows(rows);
  const { quotesByTicker: idxQuotes } = useLiveQuotes(['QQQ', 'SPY', 'IWM']);

  const list = (
      <div className="space-y-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-lg font-bold text-neutral-100">TRIDENT</h2>
            <p className="text-[11px] text-neutral-500">
              fundamentals × technicals × smart money · 1–3 month horizon · labelled screener
            </p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex rounded-lg border border-neutral-700 p-0.5">
              {UNIVERSES.map((u) => (
                <button
                  key={u.id}
                  onClick={() => setUniverse(u.id)}
                  className={`rounded-md px-2.5 py-1 text-xs ${universe === u.id ? 'bg-neutral-700 text-neutral-100' : 'text-neutral-400 hover:text-neutral-200'}`}
                >
                  {u.label}
                </button>
              ))}
            </div>
            <button
              onClick={() => setShowLegend(!showLegend)}
              className="rounded-lg border border-neutral-700 px-2.5 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
            >
              {showLegend ? 'Hide legend' : 'Legend'}
            </button>
          </div>
        </div>

        {/* Regime panel — Chad's NQ/SPX overbought-oversold + S/R ask */}
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3" data-testid="trident-regime-panel">
          <RegimeCard title="NQ (QQQ)" symbol="QQQ" r={regime?.nq} quote={idxQuotes.QQQ} />
          <RegimeCard title="SPX (SPY)" symbol="SPY" r={regime?.spx} quote={idxQuotes.SPY} />
          <RegimeCard title="R2K (IWM)" symbol="IWM" r={regime?.r2k} quote={idxQuotes.IWM} />
        </div>

        {showLegend && <TridentLegend />}

        {data?.stale && (
          <p className="rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-[11px] text-amber-300/90">
            Snapshot is older than its freshness budget (generated {data.generatedAt}); the next
            scheduled scan refreshes it.
          </p>
        )}
        {loading && <p className="p-4 text-sm text-neutral-500">Loading TRIDENT board…</p>}
        {error && <p className="p-4 text-sm text-rose-400">Failed to load: {error}</p>}
        {!loading && !error && rows.length === 0 && (
          <p className="p-4 text-sm text-neutral-500">
            {data?.source === 'snapshot-missing'
              ? 'First TRIDENT scan has not completed yet — it runs nightly after the close.'
              : 'No names pass the gate right now (uptrend + liquidity + quality). That is information too.'}
          </p>
        )}
        <div className="space-y-2">
          {liveRows.map((row, i) => (
            <TridentCard key={row.ticker} row={row} rank={i + 1} onOpen={setSelected} />
          ))}
        </div>
      </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="trident" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close TRIDENT detail"
    />
  );
}
