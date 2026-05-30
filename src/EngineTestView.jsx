import React, { useState } from 'react';
import { CircleX } from 'lucide-react';
import { tierColor } from './lib/formatters.jsx';
import { ConvictionBadge, DirectionPill } from './components/Badges.jsx';
import { useEngineTest } from './hooks/useEngineTest.js';
import { FundamentalsStrip } from './components/detail/FundamentalsStrip.jsx';

export const EngineTestView = () => {
  const [ticker, setTicker] = useState('NVDA');
  const { mutate, data: result, error, isPending: loading, reset } = useEngineTest();

  const runTest = () => {
    if (!ticker.trim()) return;
    reset();
    mutate(ticker);
  };

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Live Analyst Execution</div>
        <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
          Engine <span className="text-emerald-400 italic font-light">Test</span>
        </h1>
        <p className="text-neutral-400 text-sm mt-2">
          Runs the full analyst engine against a live ticker using real Polygon + Finnhub + FRED data.
          Takes 5-15 seconds. No Firestore required.
        </p>
      </div>

      <div className="flex items-center gap-3 mb-6">
        <input
          type="text"
          value={ticker}
          onChange={e => setTicker(e.target.value.toUpperCase())}
          onKeyDown={e => e.key === 'Enter' && runTest()}
          placeholder="NVDA"
          className="w-32 h-10 bg-neutral-900 border border-neutral-800 px-3 font-mono text-neutral-100 focus:outline-none focus:border-emerald-500/50"
        />
        <button
          onClick={runTest}
          disabled={loading}
          className="h-10 px-5 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 font-mono text-[12px] uppercase tracking-widest hover:bg-emerald-500/20 disabled:opacity-50"
        >
          {loading ? 'Running…' : 'Run Engine'}
        </button>
      </div>

      {error && (
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-6">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-2">
            <CircleX className="h-4 w-4" /> Error
          </div>
          <pre className="text-[12px] text-neutral-300 whitespace-pre-wrap">{error?.message ?? String(error)}</pre>
        </div>
      )}

      {loading && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Loading bars for {ticker}, 11 sector ETFs, SPY, macro data…</div>
        </div>
      )}

      {result && (
        <div className="space-y-4">
          <div className="border border-neutral-800 p-5">
            <div className="flex items-baseline gap-4 mb-3">
              <h2 className="font-serif font-bold text-2xl">{result.ticker}</h2>
              <span className="font-mono text-neutral-300">${result.price?.toFixed(2)}</span>
              <span className={`font-mono text-sm ${result.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {result.priceChangePct >= 0 ? '+' : ''}{result.priceChangePct?.toFixed(2)}%
              </span>
              <span className="ml-auto text-[11px] font-mono text-neutral-500">{result.durationMs}ms</span>
            </div>
            {/* Phase 6 PR-G — fundamentals strip beneath the ticker header.
                Same hook everywhere; lazy-fetched. */}
            <div className="mb-3 pt-2 border-t border-neutral-800/60">
              <FundamentalsStrip ticker={result.ticker} showExpandIcon={false} />
            </div>

            {result.target ? (
              <div className="border-l-2 pl-4 py-2" style={{ borderColor: tierColor(result.target.tier) }}>
                <div className="flex items-center gap-3 mb-2">
                  <span className="font-mono text-3xl font-bold" style={{ color: tierColor(result.target.tier) }}>
                    {result.target.composite}
                  </span>
                  <ConvictionBadge tier={result.target.tier} />
                  <DirectionPill direction={result.target.direction} />
                </div>
                <p className="text-neutral-300 text-sm leading-relaxed">{result.target.rationale}</p>
              </div>
            ) : (
              <div className="text-neutral-500 text-sm italic">No composite signal — analysts returned nothing actionable for this ticker right now.</div>
            )}
          </div>

          {result.regime && (
            <div className="border border-neutral-800 p-5">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Macro Regime</div>
              <div className="flex items-center gap-6 flex-wrap">
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">Regime</div>
                  <div className={`font-serif text-lg ${
                    result.regime.regime === 'risk_on' ? 'text-emerald-400' :
                    result.regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
                  }`}>{result.regime.regime?.replace('_', ' ')}</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">VIX</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.vol?.level?.toFixed(1)}</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">10Y</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.rates?.tenYear?.toFixed(2)}%</div>
                </div>
                <div>
                  <div className="text-[10px] text-neutral-500 uppercase tracking-widest">2Y10Y</div>
                  <div className="font-mono text-lg text-neutral-100">{result.regime.rates?.twoTenSpread}bp</div>
                </div>
              </div>
            </div>
          )}

          {result.sectorRanking && (
            <div className="border border-neutral-800 p-5">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Sector Ranking (live vs SPY)</div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                {result.sectorRanking.map(s => (
                  <div key={s.etf} className="flex items-center justify-between text-[12px] font-mono border border-neutral-800/60 px-2 py-1">
                    <span className="text-neutral-500">#{s.rank}</span>
                    <span className="text-neutral-200">{s.etf}</span>
                    <span className={(s.composite ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
                      {Number.isFinite(s.composite) ? `${s.composite >= 0 ? '+' : ''}${(s.composite * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {Object.entries(result.analysts || {}).map(([name, data]) => (
            <div key={name} className="border border-neutral-800 p-5">
              <div className="flex items-center justify-between mb-3">
                <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">{name}-analyst</div>
                <div className="text-[11px] font-mono text-neutral-400">{data.signalCount} signal{data.signalCount !== 1 ? 's' : ''}</div>
              </div>
              {data.indicators && (
                <div className="grid grid-cols-3 md:grid-cols-5 gap-3 mb-3 text-[11px] font-mono">
                  {Object.entries(data.indicators).filter(([, v]) => v !== undefined).map(([k, v]) => (
                    <div key={k}>
                      <div className="text-neutral-500 uppercase tracking-widest text-[9px]">{k}</div>
                      <div className="text-neutral-100">{v}</div>
                    </div>
                  ))}
                </div>
              )}
              {data.signals && data.signals.length > 0 && (
                <div className="space-y-2">
                  {data.signals.map((s, i) => (
                    <div key={i} className="border-l-2 border-neutral-700 pl-3 py-1">
                      <div className="flex items-center gap-2 text-[12px]">
                        <span className="font-mono text-neutral-200">{s.type}</span>
                        <span className="font-mono text-emerald-400">{s.score}</span>
                        <DirectionPill direction={s.direction} />
                      </div>
                      <div className="text-[11px] text-neutral-500 mt-0.5">{s.rationale}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}

          <div className="text-[10px] font-mono text-neutral-600 uppercase tracking-widest text-center py-3">
            Loaded {result.barsLoaded} bars · {result.totalSignals} total signals · {result.durationMs}ms
          </div>
        </div>
      )}
    </div>
  );
};
