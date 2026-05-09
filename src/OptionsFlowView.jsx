import React, { useState } from 'react';
import { CircleX, Info, AlertTriangle } from 'lucide-react';
import { useOptionsFlow } from './hooks/useOptionsFlow.js';

export const OptionsFlowView = () => {
  const [filter, setFilter] = useState('all');
  const { data, error, isLoading: loading, refetch } = useOptionsFlow();

  const candidates = data?.candidates || [];
  const filtered = candidates
    .filter(o => filter === 'all'
      || (filter === 'bullish' && o.direction === 'bullish')
      || (filter === 'bearish' && o.direction === 'bearish'))
    .sort((a, b) => b.score - a.score);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Unusual Activity</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className="text-emerald-400">{filtered.length}</span> <span className="text-neutral-500 italic font-light">tickers flagged</span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Volume surges, price breakouts, and realized-vol spikes that typically precede
            unusual options flow. True options chain data requires TradeStation (pending).
          </p>
        </div>
        <button onClick={() => refetch()} disabled={loading}
          className="h-8 px-3 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200 disabled:opacity-50 flex-shrink-0">
          {loading ? '…' : '↻ Refresh'}
        </button>
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">
            <CircleX className="h-4 w-4" /> Error
          </div>
          <div className="text-[12px] text-neutral-300">{error?.message ?? String(error)}</div>
        </div>
      )}

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Scanning watchlist for volume surges and vol-regime changes…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">10-15 seconds</div>
        </div>
      )}

      {data?.proxyNote && (
        <div className="border border-amber-500/20 bg-amber-500/5 px-3 py-2 mb-4 flex items-start gap-2">
          <Info className="h-4 w-4 text-amber-400 flex-shrink-0 mt-0.5" />
          <div className="text-[11px] text-neutral-400 leading-relaxed">
            <span className="text-amber-400 font-mono uppercase tracking-widest mr-2">Proxy mode</span>
            {data.proxyNote}
          </div>
        </div>
      )}

      {data && (
        <div className="flex items-center gap-1 text-[11px] font-mono mb-5">
          <span className="text-neutral-500 mr-2 uppercase tracking-widest">Bias</span>
          {[
            ['all', 'ALL'],
            ['bullish', 'BULLISH'],
            ['bearish', 'BEARISH'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-2 h-7 ${filter === key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500'}`}>
              {label}
            </button>
          ))}
          <span className="ml-auto text-neutral-600 text-[10px]">
            {data.universeChecked} checked · {(() => { const d = data.generatedAt ? new Date(data.generatedAt) : null; return d && !isNaN(d.getTime()) ? d.toLocaleTimeString() : '—'; })()}
          </span>
        </div>
      )}

      {filtered.length === 0 && data && !loading && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No qualifying flow candidates right now. Watchlist scanned but nothing scored high enough — could be a quiet tape.
        </div>
      )}

      <div className="space-y-3">
        {filtered.map((o) => {
          const color = o.direction === 'bullish' ? '#14e89a'
            : o.direction === 'bearish' ? '#ff5577'
            : '#b0b4c0';
          return (
            <div key={o.ticker} className="border border-neutral-800 hover:border-neutral-700 p-4 sm:p-5">
              <div className="flex items-start justify-between mb-3 gap-3">
                <div>
                  <div className="flex items-baseline gap-3 flex-wrap">
                    <span className="font-serif font-bold text-xl">{o.ticker}</span>
                    <span className="text-[12px] font-mono text-neutral-400">${o.underlyingPrice?.toFixed(2)}</span>
                    <span className={`text-[12px] font-mono ${o.intradayChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                      {o.intradayChangePct >= 0 ? '+' : ''}{o.intradayChangePct?.toFixed(2)}%
                    </span>
                  </div>
                  <div className="mt-2">
                    <span className="inline-flex items-center px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest border"
                      style={{ color, borderColor: color + '55', background: color + '15' }}>
                      {o.direction} flow likely
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="font-mono tabular-nums text-2xl font-bold" style={{ color }}>
                    {o.score}
                  </div>
                  <div className="text-[9px] text-neutral-500 uppercase tracking-widest">score</div>
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3 text-[11px] font-mono">
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Volume Ratio</div>
                  <div className={`text-sm ${o.volumeRatio >= 3 ? 'text-emerald-400' : o.volumeRatio >= 2 ? 'text-neutral-100' : 'text-neutral-300'}`}>
                    {o.volumeRatio?.toFixed(2)}x
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">Vol Regime</div>
                  <div className={`text-sm ${o.volRegime >= 1.5 ? 'text-amber-400' : 'text-neutral-200'}`}>
                    {o.volRegime?.toFixed(2)}
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">vs MA20</div>
                  <div className={`text-sm ${o.distFromMa20Pct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                    {o.distFromMa20Pct >= 0 ? '+' : ''}{o.distFromMa20Pct?.toFixed(1)}%
                  </div>
                </div>
                <div>
                  <div className="text-neutral-500 uppercase tracking-widest text-[9px]">ATM Strike</div>
                  <div className="text-neutral-200 text-sm">${o.approxAtmStrike}</div>
                </div>
              </div>

              <p className="text-[12px] text-neutral-400 leading-relaxed">{o.rationale}</p>
            </div>
          );
        })}
      </div>

      <div className="mt-6 border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">Underlying-based proxy, not true chain flow</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            These signals often precede unusual options activity but don't confirm strike-level positioning.
            The direction is inferred from price action, not option buyer intent. When TradeStation OAuth is wired
            up, this will upgrade to true strike/volume/premium analysis.
          </p>
        </div>
      </div>
    </div>
  );
};
