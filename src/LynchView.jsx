import React, { useState, useEffect } from 'react';
import { TrendingUp, TrendingDown, Shield } from 'lucide-react';

const INDEX_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'sp500', label: 'S&P 500' },
  { id: 'ndx', label: 'Nasdaq 100' },
  { id: 'russell2k', label: 'Russell 2K' },
];

export const LynchView = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [index, setIndex] = useState('sp500');

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const r = await fetch(`/api/lynch-board?index=${index}&limit=30`);
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [index]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="mb-5 sm:mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <Shield className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">
            Peter Lynch Picks
          </h1>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          GARP (Growth At Reasonable Price) screen. PEG ratio under 1, consistent earnings,
          low debt, small-to-mid cap bias. For 6&ndash;24 month holding periods.
        </p>
      </header>

      <div className="flex flex-wrap gap-1 mb-4">
        {INDEX_OPTIONS.map(opt => (
          <button key={opt.id} onClick={() => setIndex(opt.id)}
            className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
              index === opt.id
                ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
            }`}
          >{opt.label}</button>
        ))}
      </div>

      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Pulling fundamentals for {index === 'all' ? 'full universe' : INDEX_OPTIONS.find(o => o.id === index)?.label}...
          <div className="text-[10px] text-neutral-600 mt-2">
            This scan hits Polygon financials + Finnhub earnings — slower than Williams.
          </div>
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-sm">
          Lynch scan failed: {error}
          <button onClick={load} className="ml-4 underline">retry</button>
        </div>
      )}

      {data && (
        <>
          <div className="text-[11px] text-neutral-500 font-mono mb-3">
            Scanned {data.scanned}/{data.universeSize} · {data.scored} with sufficient data · {data.count} returned
          </div>
          <div className="space-y-2">
            {data.candidates.map((c, i) => (
              <LynchCard key={c.ticker} c={c} rank={i + 1} />
            ))}
          </div>
          {data.candidates.length === 0 && (
            <div className="border border-neutral-800 p-6 text-neutral-500 font-mono text-sm text-center">
              No Lynch setups meeting the criteria. Try expanding the index filter.
            </div>
          )}
        </>
      )}
    </div>
  );
};

const LynchCard = ({ c, rank }) => {
  const isLong = c.score > 0;
  const peg = c.signals.peg;
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-3 sm:p-4 border-l-2 border-l-emerald-500/60">
      <div className="flex items-start justify-between gap-3 mb-2">
        <div className="flex items-baseline gap-3 min-w-0">
          <span className="font-mono text-[11px] text-neutral-600 tabular-nums">
            #{rank}
          </span>
          <span className="font-serif text-lg font-semibold text-neutral-100">
            {c.ticker}
          </span>
          <span className="text-[11px] text-neutral-500 truncate">{c.name}</span>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {isLong && <TrendingUp className="h-3.5 w-3.5 text-emerald-400" />}
          <span className={`font-mono font-semibold tabular-nums ${isLong ? 'text-emerald-400' : 'text-rose-400'}`}>
            {c.score > 0 ? '+' : ''}{c.score.toFixed(0)}
          </span>
        </div>
      </div>
      <p className="text-[12px] text-neutral-400 leading-relaxed mb-2">{c.rationale}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] font-mono text-neutral-500">
        {peg !== undefined && (
          <span className={peg < 1 ? 'text-emerald-400' : peg > 2 ? 'text-rose-400' : ''}>
            PEG {peg}
          </span>
        )}
        {c.signals.peRatio !== undefined && <span>PE {c.signals.peRatio}</span>}
        {c.signals.epsGrowthYoYPct !== undefined && (
          <span>EPS YoY {c.signals.epsGrowthYoYPct > 0 ? '+' : ''}{c.signals.epsGrowthYoYPct}%</span>
        )}
        {c.signals.revGrowthYoYPct !== undefined && (
          <span>Rev YoY {c.signals.revGrowthYoYPct > 0 ? '+' : ''}{c.signals.revGrowthYoYPct}%</span>
        )}
        {c.signals.debtToEquity !== undefined && (
          <span>D/E {c.signals.debtToEquity}</span>
        )}
        {c.signals.operatingMarginPct !== undefined && (
          <span>OM {c.signals.operatingMarginPct}%</span>
        )}
        <span className="ml-auto text-neutral-600">conf {(c.confidence * 100).toFixed(0)}%</span>
      </div>
    </div>
  );
};
