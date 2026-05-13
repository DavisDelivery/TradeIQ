import React, { useState, useEffect } from 'react';
import {
  Sparkles, TrendingUp, TrendingDown, Minus, Brain, Zap, AlertCircle,
  RefreshCw, Layers, Activity, Volume2, Gauge, Scale, Briefcase, Target,
  ChevronDown, ChevronRight, LineChart as LineChartIcon,
} from 'lucide-react';
import {
  ComposedChart, Line, Bar, XAxis, YAxis, ResponsiveContainer,
  ReferenceLine, Tooltip, CartesianGrid,
} from 'recharts';
import { LogButton } from './components/LogButton.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { SieveCoverageStrip } from './components/SieveCoverageStrip.jsx';
import { useProphet } from './hooks/useProphet.js';
import { useGenerateNarrative } from './hooks/useGenerateNarrative.js';

const UNIVERSE_OPTIONS = [
  { id: 'largecap', label: 'Large Cap', desc: 'S&P 500 + NDX + Dow (~230)' },
  { id: 'russell', label: 'Russell 2K', desc: 'Small cap — full IWM (~1,930)' },
  { id: 'all', label: 'All Indices', desc: 'Full universe (~2,200)' },
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
  const [expandedTicker, setExpandedTicker] = useState(null);
  const { data, error, isLoading: loading, isFetching, forceRescan } =
    useProphet(universe, minConviction);
  const isRescanning = isFetching && !loading;

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-4">
        <div className="flex items-baseline gap-3 mb-2 flex-wrap">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Prophet</h1>
          <span className="text-[10px] font-mono text-neutral-600 uppercase tracking-wider">7-layer ensemble</span>
          <div className="ml-auto">
            <FreshnessPill
              meta={data}
              isRescanning={isRescanning}
              onForceRescan={() => forceRescan()}
            />
          </div>
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
            <span>
              <span className="text-neutral-300">{data.universe === 'largecap' ? 'Large Cap' : data.universe === 'russell' ? 'Russell 2K' : 'All Indices'}:</span>{' '}
              {data.qualified ?? data.picks?.length ?? 0} qualified / {data.tickersScanned ?? data.universeSize} scanned
            </span>
            {data.cached && !data.stale && <span className="text-neutral-600">· cached</span>}
            {data.partial && <span className="text-amber-500">· partial</span>}
            {data.stale && <span className="text-amber-500">· stale fallback</span>}
          </div>
          <button onClick={() => forceRescan()} disabled={loading} className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors">
            <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'scanning…' : 'refresh'}
          </button>
        </div>
      )}

      {/* 4c-2: Sieve coverage strip — only renders when sieve metadata is present
          (Russell snapshots produced by the 3-stage sieve). The ladder makes it
          clear that the system actually scored the full universe, not just the
          ~600 that the pre-4c-2 single-pass scan reached. */}
      {data?.sieve && (
        <SieveCoverageStrip sieve={data.sieve} universeSize={data.universeSize} />
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
            <div className="text-[11px] text-rose-400/70 mt-0.5">{error?.message ?? String(error)}</div>
            <button onClick={() => forceRescan()} className="text-[11px] text-rose-300 underline mt-1 hover:text-rose-200">retry</button>
          </div>
        </div>
      )}

      {/* Loading skeleton */}
      {loading && !data && (
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">
            {universe === 'all' ? 'Loading rankings (~2,200 tickers across 7 layers)…'
              : universe === 'russell' ? 'Loading Russell 2000 rankings (1,930 tickers across 7 layers)…'
              : 'Scanning S&P 500 + NDX + Dow (~230 tickers) across 7 layers…'}
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
              {Object.entries(pick.layers ?? {}).map(([name, r]) => {
                const M = LAYER_META[name];
                if (!M || !r) return null;
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

            {/* Earnings strip — key growth metrics + proximity warning */}
            {pick.earnings && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mb-2 text-[10px] font-mono">
                {pick.earnings.epsGrowthYoY !== undefined && (
                  <span className={`${pick.earnings.epsGrowthYoY > 0.25 ? 'text-emerald-400' : pick.earnings.epsGrowthYoY > 0 ? 'text-neutral-300' : 'text-rose-400'}`}>
                    EPS {pick.earnings.epsGrowthYoY >= 0 ? '+' : ''}{(pick.earnings.epsGrowthYoY * 100).toFixed(0)}%<span className="text-neutral-600"> YoY</span>
                  </span>
                )}
                {pick.earnings.revenueGrowthYoY !== undefined && (
                  <span className={`${pick.earnings.revenueGrowthYoY > 0.15 ? 'text-emerald-400/80' : 'text-neutral-400'}`}>
                    Rev {pick.earnings.revenueGrowthYoY >= 0 ? '+' : ''}{(pick.earnings.revenueGrowthYoY * 100).toFixed(0)}%
                  </span>
                )}
                {pick.earnings.epsAcceleration !== undefined && Math.abs(pick.earnings.epsAcceleration) > 0.05 && (
                  <span className={pick.earnings.epsAcceleration > 0 ? 'text-emerald-400' : 'text-amber-400'}>
                    {pick.earnings.epsAcceleration > 0 ? '▲' : '▼'} {Math.abs(pick.earnings.epsAcceleration * 100).toFixed(0)}pp accel
                  </span>
                )}
                {/* 4c-2: operating margin trend (YoY, pp). Chad's "margin improvement" signal. */}
                {pick.earnings.operatingMarginTrendPp !== undefined && Math.abs(pick.earnings.operatingMarginTrendPp) >= 0.5 && (
                  <span className={pick.earnings.operatingMarginTrendPp > 0 ? 'text-emerald-400/90' : 'text-rose-400/90'}>
                    {pick.earnings.operatingMarginTrendPp > 0 ? '▲' : '▼'} {Math.abs(pick.earnings.operatingMarginTrendPp).toFixed(1)}pp op marg
                  </span>
                )}
                {/* 4c-2: multiple expansion. Positive = market paying more per dollar of earnings. */}
                {pick.earnings.peExpansionPct !== undefined && Math.abs(pick.earnings.peExpansionPct) >= 5 && (
                  <span className={pick.earnings.peExpansionPct > 0 ? 'text-sky-400/90' : 'text-amber-500/90'}>
                    {pick.earnings.peExpansionPct > 0 ? '▲' : '▼'} {Math.abs(pick.earnings.peExpansionPct).toFixed(0)}% P/E
                  </span>
                )}
                {/* W5: distinguish null (Finnhub returned no surprises — "we don't know")
                    from a real 0/N count ("we know they missed"). null renders as a
                    muted em-dash chip so the user knows the system tried but couldn't
                    compute. A number renders with the actual quarter denominator. */}
                {pick.earnings.beatsLast4 === null && (
                  <span className="text-neutral-600">— / 4 beats</span>
                )}
                {typeof pick.earnings.beatsLast4 === 'number' && (
                  <span className={pick.earnings.beatsLast4 >= 3 ? 'text-emerald-400' : pick.earnings.beatsLast4 <= 1 ? 'text-amber-400' : 'text-neutral-400'}>
                    {pick.earnings.beatsLast4}/{pick.earnings.beatsLast4Quarters ?? 4} beats
                  </span>
                )}
                {pick.earnings.postEarningsDrift && (
                  <span className="text-violet-400">PEAD window</span>
                )}
                {pick.earnings.daysUntilEarnings !== undefined && pick.earnings.daysUntilEarnings >= 0 && pick.earnings.daysUntilEarnings <= 14 && (
                  <span className={pick.earnings.daysUntilEarnings <= 5 ? 'text-rose-400' : 'text-amber-400'}>
                    ⚠ ER in {pick.earnings.daysUntilEarnings}d
                  </span>
                )}
              </div>
            )}

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

const ProphetDetail = ({ pick }) => {
  const [chart, setChart] = useState(null);
  const [chartLoading, setChartLoading] = useState(true);
  const [chartErr, setChartErr] = useState(null);

  // W1+W3: on-demand narration for picks that arrived without a thesis.
  // The mutation patches the prophet query in TanStack cache on success, so
  // the next render path naturally picks up `pick.narrative` from the new
  // cached data. We do NOT track text in local state — single source of truth.
  const narrate = useGenerateNarrative();
  const narrativeStatus = narrate.isPending ? 'loading' : narrate.isError ? 'error' : 'idle';

  useEffect(() => {
    let cancel = false;
    setChartLoading(true);
    setChart(null);
    setChartErr(null);
    fetch(`/api/chart-analysis?ticker=${pick.ticker}&lookback=120&skipAi=1`)
      .then((r) => r.json())
      .then((d) => {
        if (cancel) return;
        if (d.ok && Array.isArray(d.bars)) setChart(d);
        else setChartErr(d.error || 'no data');
      })
      .catch((e) => { if (!cancel) setChartErr(String(e.message || e)); })
      .finally(() => { if (!cancel) setChartLoading(false); });
    return () => { cancel = true; };
  }, [pick.ticker]);

  return (
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

    {/* Chart — price + SMAs, RSI, MACD */}
    <ProphetMiniChart
      loading={chartLoading}
      error={chartErr}
      data={chart}
      entry={pick.entry}
      stop={pick.stop}
      targets={pick.targets}
    />

    {/* AI narrative — three states (W1):
        1. pick.narrative present → render the emerald-tinted block.
        2. pick.narrative missing → render the placeholder with "Generate AI thesis" button.
        3. mid-flight → spinner replaces button text. */}
    {pick.narrative ? (
      <div className="border border-emerald-500/20 bg-emerald-500/5 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Brain className="h-3 w-3 text-emerald-400" />
          <span className="text-[9px] font-mono uppercase tracking-widest text-emerald-400">AI Thesis · Claude Opus</span>
        </div>
        <p className="text-[12px] text-neutral-200 leading-relaxed whitespace-pre-wrap">{pick.narrative}</p>
      </div>
    ) : (
      <div className="border border-neutral-700/40 bg-neutral-900/30 p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <Brain className="h-3 w-3 text-neutral-500" />
          <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">
            AI Thesis · not cached for this pick
          </span>
        </div>
        <button
          type="button"
          onClick={() => narrate.mutate(pick)}
          disabled={narrativeStatus === 'loading'}
          className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:text-neutral-600 font-mono underline underline-offset-2"
        >
          {narrativeStatus === 'loading' ? 'Generating…' : '→ Generate AI thesis'}
        </button>
        {narrativeStatus === 'error' && (
          <p className="text-[10px] text-rose-400 font-mono mt-1.5">
            {narrate.error?.message === 'rate_limit'
              ? 'Rate limited — try again in a few minutes.'
              : 'Failed to generate. Try again in a moment.'}
          </p>
        )}
      </div>
    )}

    {/* Layer breakdowns */}
    <div className="space-y-1.5">
      {Object.entries(pick.layers ?? {}).map(([name, r]) => {
        const M = LAYER_META[name];
        if (!M || !r) return null;
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
              {Object.entries(r.details ?? {}).slice(0, 6).map(([k, v]) => (
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
          rationale: pick.narrative || `PROPHET ${pick.conviction}: ${(pick.flags ?? []).slice(0, 4).join(', ')}`,
          entry: pick.entry, stop: pick.stop, targets: pick.targets,
          invalidation: pick.invalidation,
          flags: pick.flags,
          layersPassed: pick.layersPassed,
        }}
      />
    </div>
  </div>
  );
};

const TradeStat = ({ label, value, color }) => (
  <div className="border border-neutral-800 bg-neutral-950/60 p-1.5 text-center">
    <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">{label}</div>
    <div className="font-mono text-[12px] tabular-nums" style={{ color }}>{value}</div>
  </div>
);

// ---------------------------------------------------------------------------
// Mini chart — price w/ SMA20/50/200 + RSI pane + MACD histogram pane
// Entry / stop / target reference lines overlay the price pane
// ---------------------------------------------------------------------------
const ProphetMiniChart = ({ loading, error, data, entry, stop, targets }) => {
  if (loading) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/60 h-[280px] flex items-center justify-center">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500 font-mono">
          <RefreshCw className="h-3 w-3 animate-spin" />
          <span>loading chart…</span>
        </div>
      </div>
    );
  }
  if (error || !data?.bars?.length) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/60 p-3 text-[11px] text-neutral-500 font-mono">
        chart unavailable{error ? `: ${error}` : ''}
      </div>
    );
  }

  // Downsample labels — we only show ~6 date ticks even on 120 bars
  const bars = data.bars;
  if (!bars.length) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/60 p-3 text-[11px] text-neutral-500 font-mono">
        chart unavailable: no bars
      </div>
    );
  }
  const last = bars[bars.length - 1];

  // Compute y-domain for price pane (tight around SMAs + entry/stop/targets).
  // Guard against empty prices — if all bars have null c, we'd Math.min(...[]) → Infinity
  // which blows up the chart domain math.
  const prices = [];
  bars.forEach((b) => {
    if (b.c != null && Number.isFinite(b.c)) prices.push(b.c);
    if (b.sma200 != null && Number.isFinite(b.sma200)) prices.push(b.sma200);
  });
  if (entry && Number.isFinite(entry)) prices.push(entry);
  if (stop && Number.isFinite(stop)) prices.push(stop);
  if (targets?.length) targets.forEach((t) => { if (Number.isFinite(t)) prices.push(t); });

  if (prices.length === 0) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/60 p-3 text-[11px] text-neutral-500 font-mono">
        chart unavailable: no valid price data
      </div>
    );
  }

  const pMin = Math.min(...prices);
  const pMax = Math.max(...prices);
  const pad = Math.max((pMax - pMin) * 0.05, 0.01);  // guard zero-range
  const priceDomain = [Math.floor((pMin - pad) * 100) / 100, Math.ceil((pMax + pad) * 100) / 100];

  const fmtDate = (d) => {
    const dt = new Date(d);
    return `${dt.getMonth() + 1}/${dt.getDate()}`;
  };

  const tickInterval = Math.max(1, Math.floor(bars.length / 6));

  // RSI pane — color based on value
  const rsiNow = last.rsi;

  return (
    <div className="border border-neutral-800 bg-neutral-950/60 overflow-hidden">
      <div className="flex items-center justify-between px-3 pt-2 pb-1 border-b border-neutral-800">
        <div className="flex items-center gap-2">
          <LineChartIcon className="h-3 w-3 text-sky-400" />
          <span className="text-[10px] font-mono uppercase tracking-widest text-neutral-400">{data.ticker} · {data.lookbackDays}d</span>
        </div>
        <div className="flex items-center gap-3 text-[10px] font-mono">
          <span className="text-emerald-400/80">SMA20 ${data.indicators?.latest?.sma20?.toFixed(2) ?? '—'}</span>
          <span className="text-amber-400/80">SMA50 ${data.indicators?.latest?.sma50?.toFixed(2) ?? '—'}</span>
          <span className="text-neutral-400">SMA200 ${data.indicators?.latest?.sma200?.toFixed(2) ?? '—'}</span>
        </div>
      </div>

      {/* PRICE PANE */}
      <div className="h-[160px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={bars} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#262626" strokeDasharray="2 4" vertical={false} />
            <XAxis
              dataKey="date"
              tickFormatter={fmtDate}
              tick={{ fill: '#737373', fontSize: 9, fontFamily: 'monospace' }}
              interval={tickInterval}
              axisLine={{ stroke: '#404040' }}
              tickLine={false}
            />
            <YAxis
              domain={priceDomain}
              tick={{ fill: '#737373', fontSize: 9, fontFamily: 'monospace' }}
              axisLine={{ stroke: '#404040' }}
              tickLine={false}
              width={50}
              tickFormatter={(v) => `$${v.toFixed(0)}`}
            />
            <Tooltip
              contentStyle={{ background: '#0a0a0a', border: '1px solid #404040', fontSize: 11 }}
              labelFormatter={fmtDate}
              formatter={(v, name) => v != null ? [typeof v === 'number' ? v.toFixed(2) : v, name] : ['—', name]}
            />
            <Line type="monotone" dataKey="c" stroke="#e5e5e5" strokeWidth={1.5} dot={false} name="Price" />
            <Line type="monotone" dataKey="sma20" stroke="#10b981" strokeWidth={1} dot={false} name="SMA20" connectNulls />
            <Line type="monotone" dataKey="sma50" stroke="#f59e0b" strokeWidth={1} dot={false} name="SMA50" connectNulls />
            <Line type="monotone" dataKey="sma200" stroke="#737373" strokeWidth={1} dot={false} strokeDasharray="3 3" name="SMA200" connectNulls />
            {entry && <ReferenceLine y={entry} stroke="#38bdf8" strokeDasharray="4 4" label={{ value: `Entry ${entry}`, fill: '#38bdf8', fontSize: 9, position: 'insideTopRight' }} />}
            {stop && <ReferenceLine y={stop} stroke="#f43f5e" strokeDasharray="4 4" label={{ value: `Stop ${stop}`, fill: '#f43f5e', fontSize: 9, position: 'insideTopRight' }} />}
            {targets?.[0] && <ReferenceLine y={targets[0]} stroke="#10b981" strokeDasharray="4 4" label={{ value: `T1 ${targets[0]}`, fill: '#10b981', fontSize: 9, position: 'insideTopRight' }} />}
            {targets?.[1] && <ReferenceLine y={targets[1]} stroke="#10b981" strokeDasharray="2 4" strokeOpacity={0.5} />}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* RSI PANE */}
      <div className="h-[56px] w-full border-t border-neutral-800">
        <div className="flex items-center justify-between px-3 pt-1">
          <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">RSI 14</span>
          <span className={`text-[10px] font-mono ${rsiNow > 70 ? 'text-rose-400' : rsiNow < 30 ? 'text-emerald-400' : 'text-neutral-300'}`}>
            {rsiNow?.toFixed(1) ?? '—'}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={36}>
          <ComposedChart data={bars} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
            <YAxis domain={[0, 100]} hide />
            <XAxis dataKey="date" hide />
            <ReferenceLine y={70} stroke="#f43f5e" strokeDasharray="2 3" strokeOpacity={0.5} />
            <ReferenceLine y={30} stroke="#10b981" strokeDasharray="2 3" strokeOpacity={0.5} />
            <ReferenceLine y={50} stroke="#404040" strokeDasharray="1 3" strokeOpacity={0.4} />
            <Line type="monotone" dataKey="rsi" stroke="#a855f7" strokeWidth={1.2} dot={false} connectNulls />
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* MACD PANE */}
      <div className="h-[56px] w-full border-t border-neutral-800">
        <div className="flex items-center justify-between px-3 pt-1">
          <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">MACD HIST</span>
          <span className={`text-[10px] font-mono ${last.macdHist > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
            {last.macdHist?.toFixed(3) ?? '—'}
          </span>
        </div>
        <ResponsiveContainer width="100%" height={36}>
          <ComposedChart data={bars} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
            <YAxis hide />
            <XAxis dataKey="date" hide />
            <ReferenceLine y={0} stroke="#404040" strokeOpacity={0.5} />
            <Bar
              dataKey="macdHist"
              shape={(props) => {
                const { x, y, width, height, payload } = props;
                // Payload can be null or missing macdHist on sparse data — guard
                if (!payload || payload.macdHist == null || !Number.isFinite(payload.macdHist)) {
                  return <rect x={x} y={y} width={width} height={0} fill="transparent" />;
                }
                const positive = payload.macdHist >= 0;
                const fill = positive ? '#10b98180' : '#f43f5e80';
                return <rect x={x} y={y} width={width} height={height} fill={fill} />;
              }}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
};
