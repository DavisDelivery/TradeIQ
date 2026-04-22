import React, { useState, useEffect } from 'react';
import {
  FlaskConical, Users, Sparkles, TrendingUp, TrendingDown, Zap,
  Filter, RefreshCw, AlertCircle, ExternalLink,
} from 'lucide-react';
import { CatalystBadges, ConvictionChip, CatalystChip } from './components/CatalystBadges.jsx';

const INDEX_OPTIONS = [
  { id: 'all', label: 'All' },
  { id: 'sp500', label: 'S&P 500' },
  { id: 'ndx', label: 'Nasdaq 100' },
  { id: 'russell2k', label: 'Russell 2K' },
];

const FILTER_OPTIONS = [
  { id: 'all', label: 'Any catalyst', desc: 'Any signal active' },
  { id: 'cluster', label: 'Cluster buys', desc: '2+ insiders in 14d' },
  { id: 'patents', label: 'Patent bursts', desc: 'Grant velocity +30%' },
  { id: 'setup', label: 'Stacked setups', desc: '2+ technicals aligned' },
];

const CONVICTION_OPTIONS = [
  { id: 'low', label: 'All' },
  { id: 'medium', label: 'Medium+' },
  { id: 'high', label: 'High only' },
];

export const CatalystView = () => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [data, setData] = useState(null);
  const [index, setIndex] = useState('sp500');
  const [filter, setFilter] = useState('all');
  const [minConviction, setMinConviction] = useState('medium');
  const [expandedTicker, setExpandedTicker] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const url = `/api/catalyst-board?index=${index}&filter=${filter}&minConviction=${minConviction}&limit=40`;
      const r = await fetch(url);
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [index, filter, minConviction]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-5 sm:mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <Zap className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">
            Catalyst Board
          </h1>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Where insider buying, patent momentum, and advanced technical setups align.
          The &ldquo;why now&rdquo; view — a catalyst says the stock should move, a setup
          says when to act.
        </p>
      </header>

      {/* Filter rows */}
      <div className="space-y-2 mb-4">
        <FilterRow label="Universe" options={INDEX_OPTIONS} value={index} onChange={setIndex} />
        <FilterRow label="Signal" options={FILTER_OPTIONS} value={filter} onChange={setFilter} />
        <FilterRow label="Conviction" options={CONVICTION_OPTIONS} value={minConviction} onChange={setMinConviction} />
      </div>

      {/* Meta line */}
      {data && !loading && (
        <div className="flex items-center justify-between mb-3 text-[11px] text-neutral-500 font-mono">
          <span>{data.matched} matched / {data.universeChecked} scanned</span>
          <button
            onClick={load}
            className="flex items-center gap-1 hover:text-neutral-300 transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            refresh
          </button>
        </div>
      )}

      {loading && !data && <LoadingSkeleton />}
      {error && <ErrorBanner message={error} onRetry={load} />}

      {data && data.picks && (
        <div className="space-y-2">
          {data.picks.length === 0 ? (
            <div className="text-center text-neutral-500 py-12 text-sm">
              No tickers match these filters. Try widening conviction or signal.
            </div>
          ) : (
            data.picks.map((p) => (
              <CatalystRow
                key={p.ticker}
                pick={p}
                expanded={expandedTicker === p.ticker}
                onToggle={() => setExpandedTicker(expandedTicker === p.ticker ? null : p.ticker)}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
};

const FilterRow = ({ label, options, value, onChange }) => (
  <div className="flex items-center gap-2 flex-wrap">
    <span className="text-[10px] text-neutral-500 uppercase tracking-wider w-20 shrink-0">{label}</span>
    <div className="flex flex-wrap gap-1">
      {options.map(opt => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          title={opt.desc}
          className={`px-2.5 py-1 text-[11px] font-medium border transition-colors ${
            value === opt.id
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
              : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
          }`}
        >
          {opt.label}
        </button>
      ))}
    </div>
  </div>
);

const CatalystRow = ({ pick, expanded, onToggle }) => {
  const dirColor =
    pick.direction === 'long' ? 'text-emerald-400' :
    pick.direction === 'short' ? 'text-rose-400' : 'text-neutral-400';
  const changeColor = pick.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400';

  return (
    <div className="border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-colors">
      <button
        onClick={onToggle}
        className="w-full text-left p-3 sm:p-4 flex items-start gap-3"
      >
        {/* Score block */}
        <div className="flex-shrink-0 w-12 flex flex-col items-center">
          <div className={`text-xl font-bold ${dirColor}`}>{pick.composite}</div>
          <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">
            {pick.conviction}
          </div>
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline justify-between gap-3 mb-1">
            <div className="flex items-baseline gap-2 min-w-0">
              <span className="text-[15px] font-bold text-neutral-100">{pick.ticker}</span>
              <span className="text-[11px] text-neutral-500 truncate">{pick.name}</span>
            </div>
            <div className="text-right flex-shrink-0">
              <div className="text-[13px] text-neutral-200 font-mono">${pick.price?.toFixed(2)}</div>
              <div className={`text-[10px] font-mono ${changeColor}`}>
                {pick.priceChangePct >= 0 ? '+' : ''}{pick.priceChangePct?.toFixed(2)}%
              </div>
            </div>
          </div>

          {/* Badges */}
          <div className="mb-1.5">
            <CatalystBadges catalyst={pick} max={5} />
          </div>

          {/* Rationale */}
          <p className="text-[11px] text-neutral-400 leading-relaxed line-clamp-2">
            {pick.rationale}
          </p>
        </div>
      </button>

      {expanded && <CatalystDetail pick={pick} />}
    </div>
  );
};

const CatalystDetail = ({ pick }) => {
  const comp = pick.components || {};
  return (
    <div className="border-t border-neutral-800 p-3 sm:p-4 bg-black/40 space-y-3">
      <ComponentBreakdown
        icon={Users}
        title="Insider"
        score={comp.insider?.score}
        confidence={comp.insider?.confidence}
        rationale={comp.insider?.rationale}
        tone="bull"
      />
      <ComponentBreakdown
        icon={FlaskConical}
        title="Patents"
        score={comp.patent?.score}
        confidence={comp.patent?.confidence}
        rationale={comp.patent?.rationale}
        tone="info"
      />
      <ComponentBreakdown
        icon={Sparkles}
        title="Setup"
        score={comp.setup?.score}
        rationale={pick.setupLabels?.length ? pick.setupLabels.join(' · ') : 'no active setups'}
        tone="warn"
      />
      <div className="pt-2 flex items-center gap-3 text-[11px] text-neutral-500">
        <span className="uppercase tracking-wider">{pick.sector}</span>
        <span className="opacity-40">·</span>
        <ConvictionChip conviction={pick.conviction} direction={pick.direction} />
      </div>
    </div>
  );
};

const ComponentBreakdown = ({ icon: Icon, title, score, confidence, rationale, tone }) => {
  const toneColor = {
    bull: 'text-emerald-400',
    info: 'text-sky-400',
    warn: 'text-amber-400',
  }[tone] || 'text-neutral-400';

  return (
    <div className="flex items-start gap-3">
      <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${toneColor}`} />
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <span className="text-[11px] font-semibold text-neutral-200 uppercase tracking-wider">{title}</span>
          {typeof score === 'number' && (
            <span className={`text-[11px] font-mono ${toneColor}`}>{score}/100</span>
          )}
          {typeof confidence === 'number' && confidence > 0 && (
            <span className="text-[10px] text-neutral-500 font-mono">
              conf {(confidence * 100).toFixed(0)}%
            </span>
          )}
        </div>
        <p className="text-[11px] text-neutral-400 leading-relaxed">{rationale || '—'}</p>
      </div>
    </div>
  );
};

const LoadingSkeleton = () => (
  <div className="space-y-2">
    {[0, 1, 2, 3, 4].map(i => (
      <div key={i} className="h-20 border border-neutral-800 bg-neutral-950/40 animate-pulse" />
    ))}
  </div>
);

const ErrorBanner = ({ message, onRetry }) => (
  <div className="border border-rose-500/30 bg-rose-500/10 p-3 flex items-start gap-2">
    <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
    <div className="flex-1">
      <div className="text-[12px] text-rose-300 font-medium">Failed to load catalyst board</div>
      <div className="text-[11px] text-rose-400/70 mt-0.5">{message}</div>
      <button onClick={onRetry} className="text-[11px] text-rose-300 underline mt-1 hover:text-rose-200">
        try again
      </button>
    </div>
  </div>
);
