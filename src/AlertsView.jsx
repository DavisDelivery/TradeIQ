import React, { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { DirectionPill } from './components/Badges.jsx';
import { useTargetBoard } from './hooks/useTargetBoard.js';
import { useCatalyst } from './hooks/useCatalyst.js';
import { useEarnings } from './hooks/useEarnings.js';
import { useRegime } from './hooks/useRegime.js';

export const AlertsView = () => {
  // AlertsView is a *derived* surface: it reads the four upstream boards
  // and emits a sorted alert feed. Each underlying query lives in shared
  // cache, so opening this view warms the same cache the dedicated
  // boards use — no duplicate network calls.
  const board = useTargetBoard('sp500');
  const cat = useCatalyst('sp500', 'all', 'low');
  const earn = useEarnings(7);
  const reg = useRegime();

  // Refresh = hand back to the underlying queries' refetch. Boards have
  // forceRescan; non-board hooks use refetch.
  const refreshAll = () => {
    board.refetch?.();
    cat.refetch?.();
    earn.refetch?.();
    reg.refetch?.();
  };
  const loading = board.isLoading || cat.isLoading || earn.isLoading || reg.isLoading;
  const error =
    board.error?.message ??
    cat.error?.message ??
    earn.error?.message ??
    reg.error?.message ??
    null;

  const { alerts, regimeAlert, lastRefresh } = useMemo(() => {
    const firedAt = new Date().toISOString();
    const fired = [];

    // Board alerts: top 5 by composite + anything ≥80
    const targets = board.data?.targets ?? [];
    if (targets.length) {
      const sorted = [...targets].sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));
      const keep = new Set([
        ...sorted.slice(0, 5).map((t) => t.ticker),
        ...targets.filter((t) => t.composite >= 80 || t.tier === 'A').map((t) => t.ticker),
      ]);
      for (const t of targets.filter((x) => keep.has(x.ticker))) {
        fired.push({
          id: `board-${t.ticker}`, source: 'Board', ticker: t.ticker,
          composite: t.composite, tier: t.tier, direction: t.direction,
          rationale: t.rationale || `${t.tier}-tier composite ${t.composite}`,
          firedAt,
        });
      }
    }

    // Catalyst alerts: high-conviction + anything composite ≥70
    const picks = cat.data?.picks ?? [];
    for (const p of picks.filter((x) => x.conviction === 'high' || x.composite >= 70).slice(0, 10)) {
      fired.push({
        id: `catalyst-${p.ticker}`, source: 'Catalyst', ticker: p.ticker,
        composite: p.composite, tier: p.conviction, direction: p.direction,
        rationale: p.rationale || 'catalyst convergence',
        firedAt,
      });
    }

    // Earnings alerts: composite ≥80 within 10 days
    const setups = earn.data?.setups ?? [];
    for (const e of setups.filter((x) => x.composite >= 80 && x.daysUntil <= 10).slice(0, 10)) {
      fired.push({
        id: `earn-${e.ticker}`, source: 'Earnings', ticker: e.ticker,
        composite: e.composite,
        tier: e.strategy === 'Iron Condor' ? 'sell' : e.strategy === 'Long Straddle' ? 'buy' : '-',
        direction: null,
        rationale: e.rationale || `${e.strategy} · ${e.daysUntil}d to print`,
        firedAt,
      });
    }

    // Regime "alert": not a row, a standalone status card
    const regimeData = reg.data;
    const regimeAlertData = regimeData?.regime
      ? {
          regime: regimeData.regime,
          conviction: regimeData.conviction,
          rationale: regimeData.rationale,
          vix: regimeData.vol?.level,
        }
      : null;

    // Dedupe by id, then sort by composite desc
    const byId = new Map();
    for (const f of fired) if (!byId.has(f.id)) byId.set(f.id, f);
    const deduped = Array.from(byId.values()).sort((a, b) => (b.composite ?? 0) - (a.composite ?? 0));

    return { alerts: deduped, regimeAlert: regimeAlertData, lastRefresh: firedAt };
  }, [board.data, cat.data, earn.data, reg.data]);

  const sourceColor = (s) => ({
    Board: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5',
    Catalyst: 'text-amber-400 border-amber-500/40 bg-amber-500/5',
    Earnings: 'text-sky-400 border-sky-500/40 bg-sky-500/5',
  }[s] || 'text-neutral-400 border-neutral-700 bg-neutral-900/40');

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Live Alert Feed</div>
          <h1 className="font-serif text-3xl font-bold tracking-tight">
            <span className="text-emerald-400">{alerts.length}</span>{' '}
            <span className="text-neutral-500 italic font-light">
              alert{alerts.length === 1 ? '' : 's'} firing
            </span>
          </h1>
          <p className="text-[11px] font-mono text-neutral-500 mt-2">
            Cross-surface scan: Board top picks, Catalyst convergences, near-term Earnings setups, Macro regime.
          </p>
        </div>
        <button
          onClick={refreshAll}
          disabled={loading}
          className="px-3 py-1.5 text-[11px] font-mono border border-neutral-800 text-neutral-400 hover:border-neutral-700 hover:text-neutral-200 disabled:opacity-50 transition-colors flex-shrink-0"
        >
          {loading ? 'refreshing…' : 'refresh'}
        </button>
      </div>

      {regimeAlert && (
        <div className={`border p-4 mb-4 ${regimeAlert.regime === 'risk_on' ? 'border-emerald-500/30 bg-emerald-500/5' : regimeAlert.regime === 'risk_off' ? 'border-rose-500/30 bg-rose-500/5' : 'border-neutral-700 bg-neutral-900/40'}`}>
          <div className="flex items-baseline gap-3 mb-1">
            <Activity className="h-4 w-4 text-neutral-400" />
            <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-500">Macro Regime</span>
            <span className={`text-[13px] font-bold uppercase tracking-wider ${regimeAlert.regime === 'risk_on' ? 'text-emerald-400' : regimeAlert.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'}`}>
              {regimeAlert.regime.replace('_', ' ')}
            </span>
            <span className="text-[11px] text-neutral-500">({regimeAlert.conviction} conviction)</span>
            {regimeAlert.vix !== undefined && (
              <span className="text-[11px] font-mono text-neutral-500 ml-auto">VIX {regimeAlert.vix?.toFixed(1)}</span>
            )}
          </div>
          <div className="text-[11px] text-neutral-400 leading-relaxed">{regimeAlert.rationale}</div>
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-[12px] mb-4">
          Alerts failed to load: {error?.message ?? String(error)}
        </div>
      )}

      {loading && !alerts.length && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Scanning Board + Catalyst + Earnings + Regime…
        </div>
      )}

      {!loading && !error && alerts.length === 0 && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-500 font-mono text-sm mb-2">No alerts firing right now.</div>
          <div className="text-neutral-600 text-[11px] font-mono">
            Nothing currently meets cross-surface alert thresholds.
          </div>
        </div>
      )}

      {alerts.length > 0 && (
        <div className="border border-neutral-800 overflow-x-auto">
          <table className="w-full min-w-[720px]">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-950/60">
                {['Source', 'Ticker', 'Composite', 'Tier', 'Side', 'Rationale'].map(h => (
                  <th key={h} className="px-4 py-3 text-left text-[10px] font-mono text-neutral-500 uppercase tracking-widest">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {alerts.map(a => (
                <tr key={a.id} className="border-b border-neutral-800/60 hover:bg-neutral-900/40">
                  <td className="px-4 py-3">
                    <span className={`inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${sourceColor(a.source)}`}>
                      {a.source}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-serif font-bold text-lg">{a.ticker}</td>
                  <td className="px-4 py-3 font-mono text-emerald-400 font-semibold">{a.composite}</td>
                  <td className="px-4 py-3 text-[11px] font-mono text-neutral-400 uppercase tracking-wider">{a.tier ?? '-'}</td>
                  <td className="px-4 py-3">{a.direction ? <DirectionPill direction={a.direction} /> : <span className="text-neutral-600 text-xs">—</span>}</td>
                  <td className="px-4 py-3 text-[11px] text-neutral-400 max-w-md">
                    <div className="line-clamp-2">{a.rationale}</div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {lastRefresh && alerts.length > 0 && (
        <div className="text-[10px] font-mono text-neutral-600 mt-3 text-right">
          Last scan: {new Date(lastRefresh).toLocaleTimeString()} · {alerts.length} alerts across {new Set(alerts.map((a) => a.source)).size} sources
        </div>
      )}
    </div>
  );
};
