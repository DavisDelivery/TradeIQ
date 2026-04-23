import React, { useState, useEffect } from 'react';
import {
  Sparkles, TrendingUp, TrendingDown, Minus, Brain, Zap, AlertCircle,
  RefreshCw, Layers, Activity, Volume2, Gauge, Scale, Briefcase, Target,
  ChevronDown, ChevronRight,
} from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';

const UNIVERSE_OPTIONS = [
  { id: 'largecap', label: 'Large Cap', desc: 'S&P 500 + NDX + Dow (~230)' },
  { id: 'russell', label: 'Russell 2K', desc: 'Small cap only (~168)' },
  { id: 'all', label: 'All Indices', desc: 'Full universe (~399)' },
];

const CONVICTION_OPTIONS = [
  { id: 'low', label: 'All' },
  { id: 'medium', label: 'Medium+' },
  { id: 'high', label: 'High only' },
];

const LAYER_META = {
  structure:        { label: 'Structure',         icon: Layers,    color: 'text-sky-400' },
  momentum:         { label: 'Momentum',          icon: TrendingUp, color: 'text-emerald-400' },
  volume:           { label: 'Volume & Flow',     icon: Volume2,   color: 'text-violet-400' },
  volatility:       { label: 'Volatility',        icon: Activity,  color: 'text-amber-400' },
  relativeStrength: { label: 'Relative Strength', icon: Gauge,     color: 'text-fuchsia-400' },
  fundamental:      { label: 'Fundamental',       icon: Scale,     color: 'text-cyan-400' },
  catalyst:         { label: 'Catalyst & Meta',   icon: Briefcase, color: 'text-rose-400' },
};

export const ProphetView = () => {
  const [universe, setUniverse] = useState('largecap');
  const [minConviction, setMinConviction] = useState('low');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [expandedTicker, setExpandedTicker] = useState(null);

  const load = async () => {
    setLoading(true); setError(null);
    try {
      const url = `/api/prophet-picks?universe=${universe}&minConviction=${minConviction}&limit=30`;
      const r = await fetch(url);
      const ctype = r.headers.get('content-type') ?? '';
      if (!ctype.includes('json')) {
        const text = await r.text();
        throw new Error(`Server ${r.status}: ${text.slice(0, 120)}`);
      }
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      setData(json);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); /* eslint-disable-next-line */ }, [universe, minConviction]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-4">
        <div className="flex items-baseline gap-3 mb-2">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Prophet</h1>
          <span className="text-[10px] font-mono text-neutral-600 uppercase tracking-wider">7-layer ensemble</span>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Convergence scanner. A stock earns a pick only when structure, momentum, volume, volatility,
          relative strength, fundamentals, and catalysts all align. ≥5/7 layers must pass.
        </p>
      </header>

      {/* Universe + conviction filters */}
      <div className="space-y-2 mb-4">
        <FilterRow label="Universe" options={UNIVERSE_OPTIONS} value={universe} onChange={setUniverse} />
        <FilterRow label="Conviction" options={CONVICTION_OPTIONS} value={minConviction} onChange={setMinConviction} />
      </div>

      {/* Regime header */}
      {data?.regime && (
        <div className={`border p-2.5 mb-3 flex items-baseline justify-between ${
          data.regime.regime === 'risk_on' ? 'border-emerald-500/30 bg-emerald-500/5' :
          data.regime.regime === 'risk_off' ? 'border-rose-500/30 bg-rose-500/5' :
          'border-neutral-700 bg-neutral-900/40'
        }`}>
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Regime</span>
            <span className={`text-[12px] font-bold uppercase tracking-wider ${
              data.regime.regime === 'risk_on' ? 'text-emerald-400' :
              data.regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
            }`}>{data.regime.regime?.replace('_', ' ')}</span>
            <span className="text-[10px] text-neutral-500">({data.regime.conviction})</span>
          </div>
          <span className="text-[10px] font-mono text-neutral-500">VIX {data.regime.vol?.level?.toFixed(1)}</span>
        </div>
      )}

      {/* Scan stats */}
      {data && !loading && (
        <div className="flex items-center justify-between mb-3 text-[11px] font-mono">
          <div className="flex items-center gap-2 text-neutral-500">
            <span>{data.qualified ?? data.picks?.length ?? 0} qualified / {data.tickersScanned ?? data.universeSize} scanned</span>
            {data.cached && !data.stale && <span className="text-neutral-600">· cached</span>}
            {data.partial && <span className="text-amber-500">· partial</span>}
            {data.stale && <span className="text-amber-500">· stale fallback</span>}
          </div>
          <button onClick={load} disabled={loading} className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'scanning…' : 'refresh'}
          </button>
        </div>
      )}

      {/* Warning banner for stale/partial */}
      {data?.warning && (
        <div className="border border-amber-500/30 bg-amber-500/5 p-2 mb-3 flex items-start gap-2 text-[11px] text-amber-400/90">
          <AlertCircle className="h-3.5 w-3.5 flex-shrink-0 mt-0.5" />
          <div>{data.warning}</div>
        </div>
      )}

      {/* Error */}
      {error && (
        <div className="border border-rose-500/30 bg-rose-500/10 p-3 flex items-start gap-2 mb-4">
          <AlertCircle className="h-4 w-4 text-rose-400 flex-shrink-0 mt-0.5" />
          <div>
            <div className="text-[12px] text-rose-300 font-medium">Prophet scan failed</div>
            <div className="text-[11px] text-rose-400/70 mt-0.5">{error}</div>
            <button onClick={load} className="text-[11px] text-rose-300 underline mt-1 hover:text-rose-200">retry</button>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">
            {universe === 'all' ? 'Scanning ~399 tickers across 7 layers + AI narratives for top 10…'
              : universe === 'russell' ? 'Scanning Russell 2000 small caps across 7 layers…'
              : 'Scanning S&P 500 + NDX + Dow across 7 layers…'}
          </div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">First scan 15-22s · cached 20 min after</div>
        </div>
      )}

      {/* Picks */}
      {data?.picks?.length === 0 && !loading && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-500 font-mono text-sm mb-2">No tickers qualified.</div>
          <div className="text-neutral-600 text-[11px] font-mono">
            Try lowering conviction to "All" or switching universe.
          </div>
        </div>
      )}

      {data?.picks && data.picks.length > 0 && (
        <div className="space-y-2">
          {data.picks.map((p) => (
            <ProphetRow
              key={p.ticker}
              pick={p}
              expanded={expandedTicker === p.ticker}
              onToggle={() => setExpandedTicker(expandedTicker === p.ticker ? null : p.ticker)}
            />
          ))}
        </div>
      )}
    </div>
  );
};

const FilterRow = ({ label, options, value, onChange }) => (
  <div className="flex items-center gap-2 flex-wrap">
    <span className="text-[10px] text-neutral-500 uppercase tracking-wider w-20 shrink-0">{label}</span>
    <div className="flex flex-wrap gap-1">
      {options.map((opt) => (
        <button
          key={opt.id}
          onClick={() => onChange(opt.id)}
          title={opt.desc}
          className={`px-2.5 py-1 text-[11px] font-medium border transition-colors ${
            value === opt.id
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
              : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
          }`}
        >{opt.label}</button>
      ))}
    </div>
  </div>
);

const ProphetRow = ({ pick, expanded, onToggle }) => {
  const convictionColor =
    pick.conviction === 'HIGH' ? 'text-emerald-400 border-emerald-500/50 bg-emerald-500/10' :
    pick.conviction === 'MEDIUM' ? 'text-amber-400 border-amber-500/40 bg-amber-500/5' :
    'text-sky-400 border-sky-500/40 bg-sky-500/5';
  const changeColor = pick.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400';

  return (
    <div className={`border bg-neutral-950/40 transition-colors ${expanded ? 'border-neutral-600' : 'border-neutral-800 hover:border-neutral-700'}`}>
      <button onClick={onToggle} className="w-full text-left p-3 sm:p-4">
        <div className="flex items-start gap-3">
          <div className="flex-shrink-0 w-14 flex flex-col items-center">
            <div className="text-2xl font-bold text-emerald-400">{pick.composite}</div>
            <div className="text-[9px] text-neutral-500 uppercase tracking-wider mt-0.5">{pick.conviction}</div>
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline justify-between gap-3 mb-1 flex-wrap">
              <div className="flex items-baseline gap-2 min-w-0">
                <span className="text-[16px] font-serif font-bold text-neutral-100">{pick.ticker}</span>
                <span className="text-[11px] text-neutral-500 truncate">{pick.name}</span>
                <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${convictionColor}`}>
                  <Zap className="h-2.5 w-2.5" />
                  {pick.signal}
                </span>
              </div>
              <div className="text-right flex-shrink-0">
                <div className="text-[13px] text-neutral-200 font-mono">${pick.price?.toFixed(2)}</div>
                <div className={`text-[10px] font-mono ${changeColor}`}>
                  {pick.priceChangePct >= 0 ? '+' : ''}{pick.priceChangePct?.toFixed(2)}%
                </div>
              </div>
            </div>

            {/* Layer pass/fail bar */}
            <div className="flex items-center gap-0.5 mb-2">
              {Object.entries(pick.layers).map(([name, r]) => {
                const M = LAYER_META[name];
                const Icon = M.icon;
                return (
                  <div
                    key={name}
                    title={`${M.label}: ${r.score}/100 ${r.pass ? 'passed' : 'failed'}`}
                    className={`flex-1 h-6 flex items-center justify-center border ${
                      r.pass ? 'border-emerald-500/40 bg-emerald-500/10' : 'border-rose-500/30 bg-rose-500/5'
                    }`}
                  >
                    <Icon className={`h-2.5 w-2.5 ${r.pass ? M.color : 'text-rose-500/40'}`} />
                  </div>
                );
              })}
              <span className="ml-2 text-[10px] font-mono text-neutral-500 flex-shrink-0">{pick.layersPassed}/7</span>
            </div>

            {/* Flags */}
            {pick.flags?.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {pick.flags.slice(0, 5).map((f) => (
                  <span key={f} className="text-[9px] font-mono text-neutral-500 bg-neutral-900 border border-neutral-800 px-1 py-0.5">
                    {f.replace(/_/g, ' ')}
                  </span>
                ))}
                {pick.flags.length > 5 && (
                  <span className="text-[9px] font-mono text-neutral-600">+{pick.flags.length - 5}</span>
                )}
              </div>
            )}
          </div>
        </div>
      </button>
      {expanded && <ProphetDetail pick={pick} />}
    </div>
  );
};

const ProphetDetail = ({ pick }) => (
  <div className="border-t border-neutral-800 p-3 sm:p-4 bg-black/40 space-y-3">
    {/* Entry/stop/targets */}
    {pick.entry && (
      <div className="grid grid-cols-4 gap-2 text-[11px]">
        <TradeStat label="Entry" value={`$${pick.entry}`} color="#e5e5e5" />
        <TradeStat label="Stop" value={`$${pick.stop}`} color="#f43f5e" />
        <TradeStat label="T1 / T2" value={pick.targets?.length >= 2 ? `$${pick.targets[0]} / $${pick.targets[1]}` : '—'} color="#10b981" />
        <TradeStat label="Invalidation" value={pick.invalidation ? `$${pick.invalidation}` : '—'} color="#737373" />
      </div>
    )}

    {/* AI narrative */}
    {pick.narrative && (
      <div className="border border-emerald-500/20 bg-emerald-500/5 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Brain className="h-3 w-3 text-emerald-400" />
          <span className="text-[9px] font-mono uppercase tracking-widest text-emerald-400">AI Thesis · Claude Sonnet</span>
        </div>
        <p className="text-[12px] text-neutral-200 leading-relaxed whitespace-pre-wrap">{pick.narrative}</p>
      </div>
    )}

    {/* Layer breakdowns */}
    <div className="space-y-1.5">
      {Object.entries(pick.layers).map(([name, r]) => {
        const M = LAYER_META[name];
        const Icon = M.icon;
        return (
          <div key={name} className="border border-neutral-800 bg-neutral-950/60 p-2">
            <div className="flex items-baseline gap-2 mb-1">
              <Icon className={`h-3 w-3 ${r.pass ? M.color : 'text-neutral-600'}`} />
              <span className="text-[11px] font-semibold text-neutral-200 uppercase tracking-wider">{M.label}</span>
              <span className={`text-[11px] font-mono ${r.pass ? M.color : 'text-rose-400'}`}>{r.score}/100</span>
              <span className={`text-[9px] font-mono uppercase tracking-wider ${r.pass ? 'text-emerald-500' : 'text-rose-500'}`}>
                {r.pass ? '✓ pass' : '✗ fail'}
              </span>
            </div>
            <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] font-mono text-neutral-500">
              {Object.entries(r.details).slice(0, 6).map(([k, v]) => (
                <span key={k}>
                  <span className="text-neutral-600">{k}</span>{' '}
                  <span className={typeof v === 'boolean' ? (v ? 'text-emerald-400' : 'text-neutral-600') : 'text-neutral-300'}>
                    {typeof v === 'boolean' ? (v ? 'yes' : 'no') : v ?? '—'}
                  </span>
                </span>
              ))}
            </div>
          </div>
        );
      })}
    </div>

    {/* Actions */}
    <div className="flex items-center justify-between gap-2 pt-2">
      <span className="text-[10px] font-mono text-neutral-600">{pick.sector}</span>
      <LogButton
        size="md"
        payload={{
          ticker: pick.ticker,
          source: 'prophet',
          loggedPrice: pick.price,
          composite: pick.composite,
          conviction: pick.conviction,
          direction: pick.direction,
          rationale: pick.narrative || `PROPHET ${pick.conviction}: ${pick.flags.slice(0, 4).join(', ')}`,
          entry: pick.entry, stop: pick.stop, targets: pick.targets,
          invalidation: pick.invalidation,
          flags: pick.flags,
          layersPassed: pick.layersPassed,
        }}
      />
    </div>
  </div>
);

const TradeStat = ({ label, value, color }) => (
  <div className="border border-neutral-800 bg-neutral-950/60 p-1.5 text-center">
    <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">{label}</div>
    <div className="font-mono text-[12px] tabular-nums" style={{ color }}>{value}</div>
  </div>
);
