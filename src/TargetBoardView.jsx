import React, { useState, useMemo } from 'react';
import {
  AlertTriangle, Circle, CircleX, X, CircleCheck, Eye, ExternalLink, Filter,
} from 'lucide-react';
import {
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar, ResponsiveContainer,
} from 'recharts';
import { fmt, tierColor, tierGlow, analystIcon, analystLabel, safeTimestamp } from './lib/formatters.jsx';
import { ConvictionBadge, DirectionPill } from './components/Badges.jsx';
import { ResearchPanel } from './components/ResearchPanel.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { LogButton } from './components/LogButton.jsx';
import { AnalystContributions } from './components/AnalystContributions.jsx';
import { useTargetBoard } from './hooks/useTargetBoard.js';

// ---------------------------------------------------------------------------
// TargetCard — single ticker card on the grid
// ---------------------------------------------------------------------------
const TargetCard = ({ target, onOpen }) => {
  const conflict = target.conflictLevel && target.conflictLevel !== 'none';
  return (
    <button
      onClick={() => onOpen(target)}
      className="group relative text-left w-full border border-neutral-800/80 bg-neutral-950/40 hover:bg-neutral-900/60 hover:border-neutral-700 transition-all duration-200 overflow-hidden"
      style={target.tier === 'A' ? { boxShadow: tierGlow('A') } : {}}
    >
      <div className="absolute left-0 top-0 bottom-0 w-[3px]" style={{ background: tierColor(target.tier) }} />

      <div className="p-4 pl-5">
        <div className="flex items-start justify-between mb-3">
          <div className="min-w-0 flex-1 pr-3">
            <div className="flex items-baseline gap-2">
              <div className="font-serif font-bold text-xl tracking-tight text-neutral-100">
                {target.ticker}
              </div>
              <DirectionPill direction={target.direction} />
            </div>
            {/* Phase 4h W4 — company name + sector under the ticker so a
                Russell small-cap like SMTC reads as Semtech / Semiconductors
                at a glance instead of an opaque four-letter symbol. */}
            {target.companyName && target.companyName !== target.ticker && (
              <div
                className="text-[11px] text-neutral-300 mt-0.5 truncate"
                title={target.companyName}
              >
                {target.companyName}
              </div>
            )}
            {target.sector && (
              <div className="text-[10px] uppercase tracking-widest font-mono text-neutral-500 mt-0.5">
                {target.sector}
              </div>
            )}
            <div className="text-[11px] text-neutral-500 font-mono mt-1">
              <span className="text-neutral-300">{fmt.moneyDec(target.price)}</span>
              <span className={`ml-2 ${target.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmt.pct(target.priceChangePct)}
              </span>
            </div>
          </div>
          <div className="flex items-start gap-2">
            <ConvictionBadge tier={target.tier} />
            <div className="text-right">
              <div className="font-mono tabular-nums text-2xl font-semibold" style={{ color: tierColor(target.tier) }}>
                {target.composite}
              </div>
              <div className="text-[9px] text-neutral-500 font-mono uppercase tracking-widest mt-0.5">composite</div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1 mb-3">
          {target.analystContributions?.slice(0, 8).map((c) => {
            const Icon = analystIcon[c.analyst] || Circle;
            const color = c.direction === 'long' ? '#14e89a' : c.direction === 'short' ? '#ff5577' : '#9ca3af';
            return (
              <div
                key={c.analyst}
                className="relative group/dot"
                title={`${analystLabel[c.analyst]}: ${c.score} ${c.direction}`}
              >
                <div
                  className="h-5 w-5 border flex items-center justify-center"
                  style={{
                    borderColor: color + '55',
                    background: color + '15',
                    color,
                  }}
                >
                  <Icon className="h-2.5 w-2.5" />
                </div>
              </div>
            );
          })}
        </div>

        <p className="text-[12px] text-neutral-400 leading-relaxed line-clamp-3">
          {target.rationale}
        </p>

        {conflict && (
          <div className="mt-3 flex items-center gap-1.5 text-[10px] text-amber-400/70 font-mono uppercase tracking-wider">
            <AlertTriangle className="h-3 w-3" />
            {target.conflictLevel} conflict · score penalized
          </div>
        )}
      </div>
    </button>
  );
};

// ---------------------------------------------------------------------------
// TargetBoardView — the grid + filters surface (presentational)
// ---------------------------------------------------------------------------
export const TargetBoardView = ({ targets, onOpenTarget, scanMeta, freshnessPill }) => {
  const [filterTier, setFilterTier] = useState('all');
  const [filterDirection, setFilterDirection] = useState('all');

  const filtered = useMemo(() => {
    return targets
      .filter(t => filterTier === 'all' || t.tier === filterTier)
      .filter(t => filterDirection === 'all' || t.direction === filterDirection)
      .sort((a, b) => b.composite - a.composite);
  }, [targets, filterTier, filterDirection]);

  const breakdown = useMemo(() => ({
    A: targets.filter(t => t.tier === 'A').length,
    B: targets.filter(t => t.tier === 'B').length,
    C: targets.filter(t => t.tier === 'C').length,
    long: targets.filter(t => t.direction === 'long').length,
    short: targets.filter(t => t.direction === 'short').length,
  }), [targets]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 mb-5 sm:mb-6">
        <div>
          <div className="flex items-center gap-3 mb-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">Live Board</div>
            {freshnessPill}
          </div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {filtered.length} <span className="text-neutral-500 italic font-light">targets ranked</span>
          </h1>
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1 mt-3 text-[11px] font-mono text-neutral-400">
            {scanMeta?.universe && (
              <div>
                <span className="text-neutral-500 uppercase tracking-widest mr-2">Scope</span>
                <span className="text-neutral-200 font-semibold">
                  {scanMeta.universe === 'core' ? 'Core (33)' :
                    scanMeta.universe === 'sp500' ? 'S&P 500' :
                    scanMeta.universe === 'ndx' ? 'Nasdaq 100' :
                    scanMeta.universe === 'dow' ? 'Dow 30' :
                    (scanMeta.universe === 'russell' || scanMeta.universe === 'russell2k') ? 'Russell 2K' :
                    'All Indices'}
                </span>
                {scanMeta.tickersScanned !== undefined && (
                  <span className="text-neutral-500 ml-1">
                    · {scanMeta.tickersScanned}/{scanMeta.universeSize ?? scanMeta.tickersScanned} scanned
                  </span>
                )}
              </div>
            )}
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">A-grade</span>
              <span className="text-emerald-400 font-semibold">{breakdown.A}</span>
            </div>
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">B-grade</span>
              <span className="text-sky-400 font-semibold">{breakdown.B}</span>
            </div>
            <div>
              <span className="text-neutral-500 uppercase tracking-widest mr-2">Long/Short</span>
              <span className="text-emerald-400">{breakdown.long}</span>
              <span className="text-neutral-600 mx-1">/</span>
              <span className="text-rose-400">{breakdown.short}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <span className="text-neutral-500 mr-2 uppercase tracking-widest">Tier</span>
            {['all', 'A', 'B', 'C'].map(t => (
              <button
                key={t}
                onClick={() => setFilterTier(t)}
                className={`px-2 h-7 ${
                  filterTier === t ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {t === 'all' ? 'ALL' : t}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 text-[11px] font-mono">
            <span className="text-neutral-500 mr-2 uppercase tracking-widest">Side</span>
            {['all', 'long', 'short'].map(d => (
              <button
                key={d}
                onClick={() => setFilterDirection(d)}
                className={`px-2 h-7 uppercase ${
                  filterDirection === d ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'
                }`}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
        {filtered.map(t => (
          <TargetCard key={t.ticker} target={t} onOpen={onOpenTarget} />
        ))}
      </div>

      {filtered.length === 0 && (
        <div className="border border-neutral-800 p-16 text-center">
          <Filter className="h-6 w-6 mx-auto text-neutral-600 mb-3" />
          <div className="text-neutral-400">No targets match filters</div>
        </div>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// LiveTargetBoard — data-fetching wrapper. Wired to useTargetBoard via
// TanStack Query: cache dedup, focus-revalidate, force-rescan via
// setQueryData. The old request-ID race guard is no longer needed —
// useQuery's abort signal supersedes prior in-flight requests
// automatically when the queryKey changes.
// ---------------------------------------------------------------------------
export const LiveTargetBoard = ({ onOpenTarget, universe = 'all' }) => {
  const { data, error, isLoading: loading, isFetching, forceRescan } = useTargetBoard(universe);
  const isRescanning = isFetching && !loading;

  if (loading && !data) {
    const universeMeta = {
      core: { label: 'core watchlist', size: 33, time: '10-15s' },
      sp500: { label: 'S&P 500', size: 500, time: '20-35s, two-pass' },
      ndx: { label: 'Nasdaq 100', size: 100, time: '15-25s' },
      dow: { label: 'Dow 30', size: 30, time: '10-15s' },
      russell: { label: 'Russell 2000', size: 2000, time: '30-50s, two-pass' },
      russell2k: { label: 'Russell 2000', size: 2000, time: '30-50s, two-pass' },
      all: { label: 'all indices', size: 2500, time: '40-60s, two-pass' },
    };
    const m = universeMeta[universe] || universeMeta.all;
    return (
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-neutral-800 p-8 text-center">
          <div className="inline-block h-6 w-6 border-2 border-emerald-500/30 border-t-emerald-500 rounded-full animate-spin mb-3" />
          <div className="text-neutral-400 text-sm">Scanning {m.label} ({m.size.toLocaleString()} tickers)…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">{m.time} · Polygon bars + sector rotation + aggregation</div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
        <div className="border border-rose-500/30 bg-rose-500/5 p-4 mb-4">
          <div className="flex items-center gap-2 text-rose-400 font-mono text-[11px] uppercase tracking-widest mb-1">
            <CircleX className="h-4 w-4" /> Error loading target board
          </div>
          <div className="text-[12px] text-neutral-300">{error?.message ?? String(error)}</div>
          <button onClick={() => forceRescan()} className="mt-3 px-3 h-8 border border-neutral-800 text-[11px] font-mono uppercase tracking-widest text-neutral-400 hover:text-neutral-200">
            ↻ Retry
          </button>
        </div>
      </div>
    );
  }

  const targets = data?.targets || [];
  return (
    <>
      <TargetBoardView
        targets={targets}
        onOpenTarget={onOpenTarget}
        scanMeta={data}
        freshnessPill={
          <FreshnessPill
            meta={data}
            isRescanning={isRescanning}
            onForceRescan={() => forceRescan()}
          />
        }
      />
      {data && (
        <div className="max-w-[1400px] mx-auto px-4 sm:px-6 pb-6 text-[10px] font-mono text-neutral-600 flex items-center gap-3">
          <span>Source: <span className="text-neutral-400">{data.source}</span></span>
          <span>·</span>
          <span>Generated: <span className="text-neutral-400">{safeTimestamp(data.generatedAt)}</span></span>
          <span>·</span>
          <span>{targets.length} targets</span>
          {data.modelVersion && (
            <>
              <span>·</span>
              <span>Model: <span className="text-neutral-400">{data.modelVersion}</span></span>
            </>
          )}
        </div>
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// TargetDetail — modal opened from cards. Mounted at App root so it
// overlays whichever view is active.
// ---------------------------------------------------------------------------
export const TargetDetail = ({ target, onClose }) => {
  if (!target) return null;

  const radarData = target.analystContributions?.map(c => ({
    subject: analystLabel[c.analyst] || c.analyst,
    score: c.score,
    fullMark: 100,
  })) || [];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 md:p-8 bg-black/70 backdrop-blur-sm" onClick={onClose}>
      <div
        className="relative w-full max-w-5xl max-h-[92vh] overflow-y-auto bg-[#0a0b0d] border border-neutral-800"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 bg-[#0a0b0d] border-b border-neutral-800 px-6 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-baseline gap-4">
              <h2 className="font-serif font-bold text-3xl tracking-tight">{target.ticker}</h2>
              <ConvictionBadge tier={target.tier} />
              <DirectionPill direction={target.direction} />
            </div>
            {/* Phase 4h W4 — company name + sector. Same source as the card. */}
            {(target.companyName || target.sector) && (
              <div className="mt-1 flex items-baseline gap-3 flex-wrap">
                {target.companyName && target.companyName !== target.ticker && (
                  <span className="text-[13px] text-neutral-200">{target.companyName}</span>
                )}
                {target.sector && (
                  <span className="text-[10px] uppercase tracking-widest font-mono text-neutral-500">
                    {target.sector}
                  </span>
                )}
              </div>
            )}
            <div className="mt-1 font-mono text-[12px] text-neutral-400">
              <span className="text-neutral-200">{fmt.moneyDec(target.price)}</span>
              <span className={`ml-2 ${target.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                {fmt.pct(target.priceChangePct)}
              </span>
              <span className="text-neutral-600 mx-2">│</span>
              <span>Composite <span className="font-semibold" style={{ color: tierColor(target.tier) }}>{target.composite}</span></span>
              {target.scoredAt && (
                <>
                  <span className="text-neutral-600 mx-2">│</span>
                  <span className="text-neutral-500">Scored {new Date(target.scoredAt).toLocaleTimeString()}</span>
                </>
              )}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <LogButton
              size="md"
              payload={{
                ticker: target.ticker,
                source: 'board',
                loggedPrice: target.price,
                composite: target.composite,
                tier: target.tier,
                direction: target.direction,
                rationale: target.rationale,
              }}
            />
            <button onClick={onClose} className="text-neutral-400 hover:text-neutral-200 p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        <div className="p-6 space-y-6">
          <div className="border-l-2 border-emerald-500/40 pl-4 py-2">
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Thesis</div>
            <p className="text-neutral-200 leading-relaxed">{target.rationale}</p>
          </div>

          <ResearchPanel ticker={target.ticker} />

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div className="border border-neutral-800 p-4">
              <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Analyst Agreement</div>
              <div className="h-64">
                <ResponsiveContainer width="100%" height="100%">
                  <RadarChart data={radarData}>
                    <PolarGrid stroke="#2a2b2e" />
                    <PolarAngleAxis
                      dataKey="subject"
                      tick={{ fill: '#9ca3af', fontSize: 11, fontFamily: 'IBM Plex Mono' }}
                    />
                    <PolarRadiusAxis
                      domain={[0, 100]}
                      tick={{ fill: '#525252', fontSize: 9 }}
                      stroke="#2a2b2e"
                    />
                    <Radar
                      dataKey="score"
                      stroke="#14e89a"
                      fill="#14e89a"
                      fillOpacity={0.2}
                      strokeWidth={1.5}
                    />
                  </RadarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <AnalystContributions target={target} />
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">Top Signals</div>
            <div className="flex flex-wrap gap-2">
              {target.topSignals?.map((s, i) => (
                <div key={i} className="border border-neutral-800 px-3 py-2 bg-neutral-950/50">
                  <div className="font-mono text-[11px] text-neutral-400">{(s.type ?? 'signal').replace(/_/g, ' ')}</div>
                  <div className="font-mono text-sm text-neutral-100 mt-0.5">{s.score ?? '—'}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2 pt-2">
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/15">
              <CircleCheck className="h-3.5 w-3.5" /> Log as Trade
            </button>
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider text-neutral-400 border border-neutral-800 hover:border-neutral-700">
              <Eye className="h-3.5 w-3.5" /> Watchlist
            </button>
            <button className="flex items-center gap-2 px-4 h-9 text-[12px] font-mono uppercase tracking-wider text-neutral-400 border border-neutral-800 hover:border-neutral-700 ml-auto">
              <ExternalLink className="h-3.5 w-3.5" /> Open in TradeStation
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
