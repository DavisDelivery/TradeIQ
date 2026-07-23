import React, { useState } from 'react';
import { Trophy, ChevronLeft, TrendingUp, TrendingDown } from 'lucide-react';
import { useForwardLeague, useForwardPicks } from './hooks/useForwardTest.js';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

// FORWARD TEST — the boards' live track record. Every night, each board's
// top-20 entrants are logged at that day's official close; returns freeze at
// 1w/1m/3m/6m/1y horizons, each vs SPY. The league ranks boards on what their
// picks actually did — forward-tested, never backfilled.

const HORIZON_LABELS = [
  ['d7', '1W'], ['d30', '1M'], ['d90', '3M'], ['d180', '6M'], ['d365', '1Y'],
];

const fmtPct = (v, signed = true) =>
  Number.isFinite(v) ? `${signed && v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';

const pctTone = (v) => (!Number.isFinite(v) ? 'text-neutral-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-rose-400' : 'text-neutral-400');

const fmtDate = (s) => {
  if (!s) return '—';
  const [y, m, d] = s.split('-').map(Number);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[(m ?? 1) - 1]} ${d}, ${y}`;
};

export const ForwardTestView = () => {
  const [board, setBoard] = useState(null); // null = league; string = pick log
  const [selected, setSelected] = useState(null); // ticker → detail panel
  const league = useForwardLeague();
  const picks = useForwardPicks(board);

  const list = (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-5">
        <div className="flex items-baseline gap-3 mb-2">
          <Trophy className="h-4 w-4 text-amber-300" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Forward Test</h1>
          {league.data?.evalDate && (
            <span className="ml-auto text-[10px] font-mono uppercase tracking-wider text-neutral-500">
              through {league.data.evalDate}
            </span>
          )}
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Every name that cracks a board's top 20 is logged at that day's close, then
          measured at 1W/1M/3M/6M/1Y against SPY. Boards are ranked by what their picks
          actually did — entries are written the night they happen and never edited.
        </p>
      </header>

      {board === null ? (
        <LeagueTable league={league} onOpenBoard={setBoard} />
      ) : (
        <PickLog board={board} picks={picks} onBack={() => setBoard(null)} onOpenTicker={setSelected} />
      )}
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="forward" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close detail"
    />
  );
};

const LeagueTable = ({ league, onOpenBoard }) => {
  const { data, isLoading, error } = league;
  if (isLoading) {
    return (
      <div className="border border-neutral-800 overflow-hidden">
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-16 border-b border-neutral-900/60 bg-neutral-900/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
        ))}
      </div>
    );
  }
  if (error) {
    return <div className="border border-rose-800/50 bg-rose-950/20 p-3 text-rose-300 font-mono text-[11px]">load failed: {error.message}</div>;
  }
  const rows = data?.league ?? [];
  if (rows.length === 0) {
    return (
      <div className="border border-neutral-800 p-8 text-center text-neutral-500 text-sm">
        The first nightly run hasn't landed yet. The league builds itself from tonight —
        every board's top 20 gets logged after the close.
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {rows.map((r, i) => (
        <button
          key={`${r.board}-${r.universe}`}
          type="button"
          onClick={() => onOpenBoard(r.board)}
          className="w-full text-left border border-neutral-800 bg-neutral-950/40 hover:border-neutral-600 transition-colors p-3 sm:p-4"
        >
          <div className="flex items-center gap-3 mb-1.5">
            <span className={`w-7 text-lg font-bold font-mono ${i === 0 ? 'text-amber-300' : 'text-neutral-500'}`}>{i + 1}</span>
            <span className="font-serif font-bold text-[15px] text-neutral-100 capitalize">{r.board}</span>
            <span className="text-[10px] font-mono uppercase tracking-wider text-neutral-600">{r.universe}</span>
            <span className={`ml-auto text-[15px] font-mono font-semibold ${pctTone(r.rankScore)}`}>
              {fmtPct(r.rankScore)}
            </span>
          </div>
          <div className="ml-10 flex items-center gap-3 flex-wrap text-[10px] font-mono text-neutral-500">
            <span>{r.totalPicks} picks</span>
            <span>{r.openPicks} open</span>
            {Number.isFinite(r.openAvgPct) && (
              <span className={pctTone(r.openAvgPct)}>open avg {fmtPct(r.openAvgPct)}</span>
            )}
            <span className="text-neutral-600">
              {r.provisional ? 'provisional · ' : ''}{r.rankBasis}
            </span>
          </div>
          <div className="ml-10 mt-1.5 flex items-center gap-2 flex-wrap">
            {HORIZON_LABELS.map(([key, label]) => {
              const h = r.horizons?.[key];
              return (
                <span key={key} className={`px-1.5 py-0.5 text-[9px] font-mono border ${h ? 'border-neutral-700 text-neutral-300' : 'border-neutral-800/60 text-neutral-700'}`}>
                  {label} {h ? `${fmtPct(h.avgAlpha)}α · ${h.winRate.toFixed(0)}%w` : '—'}
                </span>
              );
            })}
          </div>
        </button>
      ))}
      <div className="border border-neutral-800/60 bg-neutral-950/40 p-3 text-[11px] text-neutral-500 leading-relaxed">
        α = average excess return vs SPY over the same window; %w = share of picks that
        finished positive. A board's rank uses its longest horizon with ≥5 matured picks;
        until 3-month cohorts mature, rankings are provisional.
      </div>
    </div>
  );
};

const PickLog = ({ board, picks, onBack, onOpenTicker }) => {
  const { data, isLoading, error } = picks;
  const rows = data?.picks ?? [];
  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-3 inline-flex items-center gap-1 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-100"
      >
        <ChevronLeft className="h-3.5 w-3.5" /> League
      </button>
      <h2 className="font-serif text-lg font-bold text-neutral-100 capitalize mb-3">{board} — pick log</h2>
      {isLoading && <div className="text-neutral-500 text-sm font-mono">loading…</div>}
      {error && <div className="text-rose-300 text-[11px] font-mono">load failed: {error.message}</div>}
      {!isLoading && rows.length === 0 && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No picks logged for this board yet.
        </div>
      )}
      <div className="space-y-2">
        {rows.map((p) => (
          <div key={`${p.ticker}-${p.entryDate}`} className="border border-neutral-800 bg-neutral-950/40 p-3">
            <div className="flex items-baseline gap-2 flex-wrap">
              <button
                type="button"
                onClick={() => onOpenTicker(p)}
                className="font-serif font-bold text-[14px] text-neutral-100 hover:text-emerald-300 transition-colors"
                title="Open full detail"
              >
                {p.ticker}
              </button>
              <span className="text-[10px] font-mono text-neutral-500">
                in {fmtDate(p.entryDate)} @ ${p.entryPrice?.toFixed(2)} · rank #{p.rankAtEntry} · {p.daysOnBoard}d on board
              </span>
              <span className={`ml-auto inline-flex items-center gap-1 text-[13px] font-mono font-semibold ${pctTone(p.currentPct)}`}>
                {p.currentPct > 0 ? <TrendingUp className="h-3.5 w-3.5" /> : p.currentPct < 0 ? <TrendingDown className="h-3.5 w-3.5" /> : null}
                {fmtPct(p.currentPct)}
              </span>
            </div>
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <span className={`text-[10px] font-mono ${pctTone(p.currentAlpha)}`}>α {fmtPct(p.currentAlpha)}</span>
              {HORIZON_LABELS.map(([key, label]) => {
                const h = p.returns?.[key];
                return h ? (
                  <span key={key} className={`px-1.5 py-0.5 text-[9px] font-mono border border-neutral-700 ${pctTone(h.pct)}`}>
                    {label} {fmtPct(h.pct)} ({fmtPct(h.alpha)}α)
                  </span>
                ) : null;
              })}
              {p.status === 'matured' && (
                <span className="px-1.5 py-0.5 text-[9px] font-mono border border-sky-500/40 text-sky-300">matured</span>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default ForwardTestView;
