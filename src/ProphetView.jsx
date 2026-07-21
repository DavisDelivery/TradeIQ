import React, { useState } from 'react';
import {
  Sparkles, TrendingUp, TrendingDown, Minus, Brain, Zap, AlertCircle,
  RefreshCw, Layers, Activity, Volume2, Gauge, Scale, Briefcase, Target,
  ChevronDown, ChevronRight, LineChart as LineChartIcon,
} from 'lucide-react';
import { LogButton } from './components/LogButton.jsx';
import { AdvancedPriceChart } from './components/detail/AdvancedPriceChart.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { VerdictChip } from './components/VerdictChip.jsx';
import { SieveCoverageStrip } from './components/SieveCoverageStrip.jsx';
import { useProphet } from './hooks/useProphet.js';
import { useLiveRows } from './hooks/useLiveQuotes.js';
import { useRegime } from './hooks/useRegime.js';
import { useGenerateNarrative } from './hooks/useGenerateNarrative.js';
import { FundamentalsStrip } from './components/detail/FundamentalsStrip.jsx';

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
  // The prophet-picks snapshot intentionally carries no macro regime (it
  // would bolt a live FRED/VIX fetch onto the snapshot hot path). Pull the
  // regime from the shared macro query instead — same cached entry the
  // TopBar badge and Alerts view already use, so this adds no extra request.
  const { data: regime } = useRegime();
  const isRescanning = isFetching && !loading;
  // Overlay live price/%-change so picks show a current quote even when the
  // prophet snapshot is hours old.
  const livePicks = useLiveRows(data?.picks);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-4">
        <div className="flex items-baseline gap-3 mb-2 flex-wrap">
          <Sparkles className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Prophet</h1>
          <span className="text-[10px] font-mono text-neutral-600 uppercase tracking-wider">7-layer ensemble</span>
          <VerdictChip board="prophet" />
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
      {regime?.regime && (
        <div className={`border p-2.5 mb-3 flex items-baseline justify-between ${
          regime.regime === 'risk_on' ? 'border-emerald-500/30 bg-emerald-500/5' :
          regime.regime === 'risk_off' ? 'border-rose-500/30 bg-rose-500/5' :
          'border-neutral-700 bg-neutral-900/40'
        }`}>
          <div className="flex items-baseline gap-2">
            <span className="text-[9px] font-mono text-neutral-500 uppercase tracking-widest">Regime</span>
            <span className={`text-[12px] font-bold uppercase tracking-wider ${
              regime.regime === 'risk_on' ? 'text-emerald-400' :
              regime.regime === 'risk_off' ? 'text-rose-400' : 'text-neutral-300'
            }`}>{regime.regime?.replace('_', ' ')}</span>
            <span className="text-[10px] text-neutral-500">({regime.conviction})</span>
          </div>
          <span className="text-[10px] font-mono text-neutral-500">VIX {regime.vol?.level?.toFixed(1)}</span>
        </div>
      )}

      {/* Scan stats */}
      {data && !loading && (
        <div className="flex items-center justify-between mb-3 text-[11px] font-mono">
          <div className="flex items-center gap-2 text-neutral-500">
            <span>
              <span className="text-neutral-300">{data.universe === 'largecap' ? 'Large Cap' : data.universe === 'russell' ? 'Russell 2K' : 'All Indices'}:</span>{' '}
              {data.qualified ?? data.picks?.length ?? 0} qualified / {data.universeChecked ?? data.tickersScanned ?? data.universeSize} scanned
            </span>
            {data.cached && !data.stale && <span className="text-neutral-600">· cached</span>}
            {data.partial && <span className="text-amber-500">· partial</span>}
            {data.stale && <span className="text-amber-500">· stale fallback</span>}
          </div>
          <button onClick={() => forceRescan()} disabled={isFetching} className="flex items-center gap-1 text-neutral-500 hover:text-neutral-300 transition-colors disabled:opacity-60">
            <RefreshCw className={`h-3 w-3 ${isFetching ? 'animate-spin' : ''}`} />
            {isFetching ? 'refreshing…' : 'refresh'}
          </button>
        </div>
      )}

      {/* 4c-2: Sieve coverage strip — only renders when sieve metadata is present
          (Russell snapshots produced by the 3-stage sieve). Wave 4A (M8): the
          strip reports TRUE coverage — universeChecked is the count Stage 1
          actually scored, shown as scored/universe when the stage hit its
          budget instead of implying full-universe coverage. */}
      {data?.sieve && (
        <SieveCoverageStrip
          sieve={data.sieve}
          universeSize={data.universeSize}
          universeChecked={data.universeChecked}
        />
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

      {livePicks && livePicks.length > 0 && (
        <div className="space-y-2">
          {livePicks.map((p) => (
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
      {/* Phase 6 PR-G — fundamentals strip beneath the prophet pick card */}
      <div className="px-3 py-1.5 border-t border-neutral-800/60 bg-neutral-950/40">
        <FundamentalsStrip ticker={pick.ticker} showExpandIcon={false} />
      </div>
      {expanded && <ProphetDetail pick={pick} />}
    </div>
  );
};

const ProphetDetail = ({ pick }) => {
  // W1+W3: on-demand narration for picks that arrived without a thesis.
  // The mutation patches the prophet query in TanStack cache on success, so
  // the next render path naturally picks up `pick.narrative` from the new
  // cached data. We do NOT track text in local state — single source of truth.
  const narrate = useGenerateNarrative();
  const narrativeStatus = narrate.isPending ? 'loading' : narrate.isError ? 'error' : 'idle';

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

    {/* Chart — the shared finviz-grade chart, with the trade plan drawn as
        dashed levels (entry / stop / T1 / T2 / invalidation). */}
    <AdvancedPriceChart
      ticker={pick.ticker}
      priceLines={[
        pick.entry && { price: pick.entry, color: '#38bdf8', title: 'entry' },
        pick.stop && { price: pick.stop, color: '#f43f5e', title: 'stop' },
        pick.targets?.[0] && { price: pick.targets[0], color: '#10b981', title: 'T1' },
        pick.targets?.[1] && { price: pick.targets[1], color: '#10b981', title: 'T2' },
        pick.invalidation && { price: pick.invalidation, color: '#737373', title: 'invalidation' },
      ].filter(Boolean)}
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
          <VerdictChip board="prophet" compact />
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

