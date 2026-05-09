import React, { useState } from 'react';
import { Brain } from 'lucide-react';

export const ResearchPanel = ({ ticker }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [brief, setBrief] = useState(null);
  const [requested, setRequested] = useState(false);

  const load = async (force = false) => {
    setLoading(true); setError(null); setRequested(true);
    try {
      const r = await fetch(`/api/research?ticker=${ticker}${force ? '&force=1' : ''}`);
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setBrief(json);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  if (!requested) {
    return (
      <div className="border border-dashed border-neutral-800 p-5 text-center">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">AI Research Brief</div>
        <button
          onClick={() => load()}
          className="inline-flex items-center gap-2 px-4 py-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 hover:bg-emerald-500/20 transition-colors text-[12px] font-medium"
        >
          <Brain className="h-4 w-4" />
          Generate brief with Claude
        </button>
        <div className="text-[10px] text-neutral-600 font-mono mt-3">
          Reads last 7 days of news + current price + board context · ~3s
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="border border-neutral-800 p-5 text-center text-neutral-500 font-mono text-sm">
        Claude is reading the news on {ticker}…
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 text-sm">
        Research failed: {error}
        <button onClick={() => load()} className="ml-3 underline text-xs">retry</button>
      </div>
    );
  }

  const b = brief?.brief || {};
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 p-4 sm:p-5 space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">AI Research Brief</div>
        <div className="flex items-center gap-3 text-[10px] font-mono text-neutral-600">
          {brief?.cached && <span>cached {Math.round(brief.cacheAgeMs / 60000)}m ago</span>}
          <button onClick={() => load(true)} className="text-neutral-400 hover:text-neutral-200 underline">refresh</button>
        </div>
      </div>

      {b.summary && (
        <div className="border-l-2 border-emerald-500/40 pl-3">
          <div className="text-[9px] uppercase tracking-widest text-neutral-500 mb-1">Net Thesis</div>
          <p className="text-neutral-100 text-sm leading-relaxed">{b.summary}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {b.bull_case && (
          <div className="border border-emerald-800/30 bg-emerald-950/10 p-3">
            <div className="text-[9px] uppercase tracking-widest text-emerald-500 mb-1.5">Bull Case</div>
            <p className="text-sm text-neutral-200 leading-relaxed">{b.bull_case}</p>
          </div>
        )}
        {b.bear_case && (
          <div className="border border-rose-800/30 bg-rose-950/10 p-3">
            <div className="text-[9px] uppercase tracking-widest text-rose-500 mb-1.5">Bear Case</div>
            <p className="text-sm text-neutral-200 leading-relaxed">{b.bear_case}</p>
          </div>
        )}
      </div>

      {b.key_catalyst && (
        <div className="border border-neutral-800 p-3">
          <div className="text-[9px] uppercase tracking-widest text-amber-500 mb-1.5">Key Catalyst</div>
          <p className="text-sm text-neutral-200">{b.key_catalyst}</p>
        </div>
      )}

      <div className="flex flex-wrap gap-3 text-[10px] font-mono">
        {b.confidence && <span className="text-neutral-500">Confidence: <span className="text-neutral-300 uppercase">{b.confidence}</span></span>}
        {b.time_horizon && <span className="text-neutral-500">Horizon: <span className="text-neutral-300">{b.time_horizon}</span></span>}
        {brief?.newsCount != null && <span className="text-neutral-500">News: <span className="text-neutral-300">{brief.newsCount} articles</span></span>}
      </div>

      {b.citations?.length > 0 && (
        <details className="text-[11px] text-neutral-500">
          <summary className="cursor-pointer hover:text-neutral-300">Citations ({b.citations.length})</summary>
          <ul className="mt-2 space-y-1 pl-4">
            {b.citations.map((c, i) => (
              <li key={i} className="text-neutral-400 leading-relaxed">· {c}</li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
};
