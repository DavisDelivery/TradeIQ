import React, { useState, useEffect, useMemo } from 'react';
import {
  BookMarked, TrendingUp, TrendingDown, Minus, X, RefreshCw, AlertCircle,
  Zap, Briefcase, Activity, Shield, Target, Cloud, CloudOff,
} from 'lucide-react';
import { readLog, removeTrade, computeForwardReturns, daysBetween, cloudSyncState } from './tradeLog.js';

const SOURCE_META = {
  earnings: { label: 'Earnings', icon: Zap, color: 'text-sky-400 border-sky-500/40 bg-sky-500/5' },
  catalyst: { label: 'Catalyst', icon: Briefcase, color: 'text-amber-400 border-amber-500/40 bg-amber-500/5' },
  board: { label: 'Board', icon: Target, color: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5' },
  williams: { label: 'Williams', icon: Activity, color: 'text-fuchsia-400 border-fuchsia-500/40 bg-fuchsia-500/5' },
  lynch: { label: 'Lynch', icon: Shield, color: 'text-violet-400 border-violet-500/40 bg-violet-500/5' },
  chart: { label: 'Chart', icon: TrendingUp, color: 'text-neutral-400 border-neutral-700 bg-neutral-900/40' },
};

const WINDOWS = [
  { key: 'since', label: 'Since' },
  { key: 'fwd5', label: '5D' },
  { key: 'fwd20', label: '20D' },
  { key: 'fwd30', label: '30D' },
  { key: 'fwd60', label: '60D' },
  { key: 'fwd90', label: '90D' },
];

export const JournalView = () => {
  const [log, setLog] = useState([]);
  const [perfByTicker, setPerfByTicker] = useState({});
  const [spyBars, setSpyBars] = useState(null);
  const [loadingTickers, setLoadingTickers] = useState(new Set());
  const [errorTickers, setErrorTickers] = useState(new Set());
  const [expandedId, setExpandedId] = useState(null);
  const [sourceFilter, setSourceFilter] = useState('all');
  const [cloudState, setCloudState] = useState(cloudSyncState());

  const refresh = () => setLog(readLog());

  useEffect(() => {
    refresh();
    const handler = () => refresh();
    window.addEventListener('tradelog:change', handler);
    // Poll cloud state for UI indicator (Firestore sub takes 1-2s to establish)
    const poll = setInterval(() => setCloudState(cloudSyncState()), 1500);
    return () => {
      window.removeEventListener('tradelog:change', handler);
      clearInterval(poll);
    };
  }, []);

  // Fetch SPY bars once for alpha calculations
  useEffect(() => {
    if (log.length === 0 || spyBars) return;
    fetch('/api/chart-analysis?ticker=SPY&lookback=180&skipAi=1')
      .then((r) => r.ok ? r.json() : null)
      .then((json) => { if (json?.ok && Array.isArray(json.bars)) setSpyBars(json.bars); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log.length]);

  // Fetch chart-analysis data for each distinct ticker in the log (no AI narrative)
  useEffect(() => {
    const tickers = Array.from(new Set(log.map((t) => t.ticker)));
    for (const ticker of tickers) {
      if (perfByTicker[ticker] || loadingTickers.has(ticker)) continue;
      setLoadingTickers((prev) => new Set([...prev, ticker]));
      fetch(`/api/chart-analysis?ticker=${encodeURIComponent(ticker)}&lookback=180&skipAi=1`)
        .then((r) => r.ok ? r.json() : null)
        .then((json) => {
          if (json?.ok && Array.isArray(json.bars)) {
            setPerfByTicker((prev) => ({ ...prev, [ticker]: json.bars }));
          } else {
            setErrorTickers((prev) => new Set([...prev, ticker]));
          }
        })
        .catch(() => setErrorTickers((prev) => new Set([...prev, ticker])))
        .finally(() => {
          setLoadingTickers((prev) => {
            const next = new Set(prev);
            next.delete(ticker);
            return next;
          });
        });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [log]);

  const handleRemove = (id) => {
    setLog(removeTrade(id));
    if (expandedId === id) setExpandedId(null);
  };

  const filtered = sourceFilter === 'all' ? log : log.filter((t) => t.source === sourceFilter);
  const sorted = [...filtered].sort((a, b) => new Date(b.loggedAt).getTime() - new Date(a.loggedAt).getTime());

  const sourceCounts = useMemo(() => {
    const counts = { all: log.length };
    for (const t of log) counts[t.source] = (counts[t.source] ?? 0) + 1;
    return counts;
  }, [log]);

  // Summary stats
  const summary = useMemo(() => {
    let wins5 = 0, losses5 = 0, totalRet5 = 0, n5 = 0;
    let wins30 = 0, losses30 = 0, totalRet30 = 0, n30 = 0;
    for (const t of log) {
      const bars = perfByTicker[t.ticker];
      if (!bars) continue;
      const fwd = computeForwardReturns(bars, t.loggedAt, t.loggedPrice);
      if (fwd.fwd5) { n5++; totalRet5 += fwd.fwd5.returnPct; if (fwd.fwd5.returnPct >= 0) wins5++; else losses5++; }
      if (fwd.fwd30) { n30++; totalRet30 += fwd.fwd30.returnPct; if (fwd.fwd30.returnPct >= 0) wins30++; else losses30++; }
    }
    return {
      tradesWith5d: n5,
      winRate5d: n5 > 0 ? +(wins5 / n5).toFixed(2) : null,
      avgReturn5d: n5 > 0 ? +(totalRet5 / n5).toFixed(2) : null,
      tradesWith30d: n30,
      winRate30d: n30 > 0 ? +(wins30 / n30).toFixed(2) : null,
      avgReturn30d: n30 > 0 ? +(totalRet30 / n30).toFixed(2) : null,
    };
  }, [log, perfByTicker]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto pb-20 sm:pb-6">
      <header className="mb-4">
        <div className="flex items-baseline gap-3 mb-2">
          <BookMarked className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">Journal</h1>
          <span
            className={`inline-flex items-center gap-1 text-[10px] font-mono uppercase tracking-wider ${cloudState.ready ? 'text-emerald-500' : 'text-neutral-600'}`}
            title={cloudState.ready ? 'Synced to Firestore — visible on all your devices' : 'Offline — storing locally, will sync when reconnected'}
          >
            {cloudState.ready ? <Cloud className="h-3 w-3" /> : <CloudOff className="h-3 w-3" />}
            {cloudState.ready ? 'synced' : 'local'}
          </span>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Trades you've logged from anywhere in the app. Forward returns computed from entry price at 5/20/30/60/90-day windows. Synced across devices via Firebase.
        </p>
      </header>

      {log.length === 0 ? (
        <div className="border border-neutral-800 p-10 text-center">
          <BookMarked className="h-8 w-8 text-neutral-700 mx-auto mb-2" />
          <div className="text-neutral-500 font-mono text-sm mb-2">No logged trades yet.</div>
          <div className="text-neutral-600 text-[11px] font-mono">
            Tap any Earnings card and hit "Log Trade" to start tracking.
          </div>
        </div>
      ) : (
        <>
          {/* Summary stats */}
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-4">
            <SummaryStat label="Total Logged" value={log.length} />
            <SummaryStat label="With 5D Data" value={summary.tradesWith5d} />
            <SummaryStat
              label="5D Win Rate"
              value={summary.winRate5d !== null ? `${(summary.winRate5d * 100).toFixed(0)}%` : '—'}
              color={summary.winRate5d !== null ? (summary.winRate5d >= 0.5 ? '#14e89a' : '#f43f5e') : undefined}
            />
            <SummaryStat
              label="Avg 5D Return"
              value={summary.avgReturn5d !== null ? `${summary.avgReturn5d >= 0 ? '+' : ''}${summary.avgReturn5d}%` : '—'}
              color={summary.avgReturn5d !== null ? (summary.avgReturn5d >= 0 ? '#14e89a' : '#f43f5e') : undefined}
            />
          </div>

          {/* Source filter chips */}
          <div className="flex flex-wrap gap-1 mb-3">
            <FilterChip active={sourceFilter === 'all'} onClick={() => setSourceFilter('all')}>
              All ({sourceCounts.all ?? 0})
            </FilterChip>
            {Object.keys(SOURCE_META).map((s) => sourceCounts[s] ? (
              <FilterChip key={s} active={sourceFilter === s} onClick={() => setSourceFilter(s)}>
                {SOURCE_META[s].label} ({sourceCounts[s]})
              </FilterChip>
            ) : null)}
          </div>

          {/* Trades list */}
          <div className="space-y-2">
            {sorted.map((t) => {
              const bars = perfByTicker[t.ticker];
              const loading = loadingTickers.has(t.ticker);
              const errored = errorTickers.has(t.ticker);
              const fwd = bars ? computeForwardReturns(bars, t.loggedAt, t.loggedPrice) : {};
              // SPY benchmark at the same log date, using its own base price at that point
              const spyFwd = spyBars ? computeForwardReturns(spyBars, t.loggedAt, spyBars.find((b) => new Date(b.date).getTime() >= new Date(t.loggedAt).getTime())?.c ?? spyBars[0].c) : {};
              const source = SOURCE_META[t.source] ?? SOURCE_META.chart;
              const SourceIcon = source.icon;
              const isOpen = expandedId === t.id;
              return (
                <div
                  key={t.id}
                  className={`border bg-neutral-950/40 transition-colors ${isOpen ? 'border-neutral-600' : 'border-neutral-800 hover:border-neutral-700'}`}
                >
                  <button
                    onClick={() => setExpandedId(isOpen ? null : t.id)}
                    className="w-full text-left p-3 sm:p-4"
                  >
                    <div className="flex items-baseline justify-between gap-3 mb-2 flex-wrap">
                      <div className="flex items-baseline gap-2 flex-wrap">
                        <span className={`inline-flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider border ${source.color}`}>
                          <SourceIcon className="h-2.5 w-2.5" />
                          {source.label}
                        </span>
                        <span className="font-serif font-bold text-lg text-neutral-100">{t.ticker}</span>
                        {t.strategy && <span className="text-[11px] text-neutral-400">{t.strategy}</span>}
                        <span className="text-[10px] font-mono text-neutral-500">
                          logged {new Date(t.loggedAt).toLocaleDateString()} @ ${t.loggedPrice?.toFixed(2) ?? '—'}
                        </span>
                      </div>
                      <span className="text-[10px] font-mono text-neutral-600">
                        {loading ? 'fetching…' : errored ? 'data unavailable' : bars ? `${daysBetween(t.loggedAt, new Date().toISOString())}d tracked` : ''}
                      </span>
                    </div>
                    <div className="grid grid-cols-3 sm:grid-cols-6 gap-1 text-[11px]">
                      {WINDOWS.map((w) => (
                        <ReturnCell
                          key={w.key}
                          label={w.label}
                          entry={fwd[w.key]}
                          spyEntry={spyFwd[w.key]}
                          loading={loading && !bars}
                        />
                      ))}
                    </div>
                  </button>
                  {isOpen && (
                    <div className="border-t border-neutral-800 p-3 sm:p-4 bg-black/40 space-y-3">
                      {t.rationale && (
                        <div>
                          <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500 mb-1">Original rationale</div>
                          <div className="text-[12px] text-neutral-300 leading-relaxed">{t.rationale}</div>
                        </div>
                      )}
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        {t.composite !== undefined && <KV k="Score at log" v={t.composite} />}
                        {t.expectedMove !== undefined && <KV k="Expected move" v={`±${t.expectedMove?.toFixed(1)}%`} />}
                        {t.avgPriorMove !== undefined && t.avgPriorMove !== null && <KV k="Prior avg move" v={`${t.avgPriorMove.toFixed(1)}%`} />}
                        {t.ivr !== undefined && <KV k="IVR" v={t.ivr} />}
                        {t.reportDate && <KV k="Report" v={t.reportDate} />}
                        {t.bias && <KV k="Bias" v={t.bias.replace('_', ' ')} />}
                      </div>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={(ev) => { ev.stopPropagation(); handleRemove(t.id); }}
                          className="flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-widest text-rose-400 border border-rose-500/40 bg-rose-500/5 hover:bg-rose-500/15"
                        >
                          <X className="h-3 w-3" /> Remove from journal
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </>
      )}
    </div>
  );
};

const SummaryStat = ({ label, value, color }) => (
  <div className="border border-neutral-800 bg-neutral-950/40 p-2.5">
    <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500 mb-0.5">{label}</div>
    <div className="font-mono text-lg tabular-nums" style={color ? { color } : { color: '#e5e5e5' }}>{value}</div>
  </div>
);

const FilterChip = ({ active, onClick, children }) => (
  <button
    onClick={onClick}
    className={`px-2.5 py-1 text-[11px] font-medium border transition-colors ${
      active
        ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
        : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
    }`}
  >
    {children}
  </button>
);

const ReturnCell = ({ label, entry, spyEntry, loading }) => {
  let value = '—';
  let color = '#737373';
  let alphaText = null;
  let alphaColor = '#737373';
  if (loading) {
    value = '…';
  } else if (entry && Number.isFinite(entry.returnPct)) {
    const r = entry.returnPct;
    value = `${r >= 0 ? '+' : ''}${r.toFixed(2)}%`;
    color = r >= 0 ? '#14e89a' : '#f43f5e';
    if (spyEntry && Number.isFinite(spyEntry.returnPct)) {
      const alpha = r - spyEntry.returnPct;
      alphaText = `α ${alpha >= 0 ? '+' : ''}${alpha.toFixed(1)}`;
      alphaColor = alpha >= 0 ? '#10b981' : '#f43f5e';
    }
  }
  return (
    <div className="border border-neutral-800/60 p-1.5 text-center">
      <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">{label}</div>
      <div className="font-mono text-[12px] tabular-nums" style={{ color }}>{value}</div>
      {alphaText && (
        <div className="font-mono text-[9px] tabular-nums opacity-80" style={{ color: alphaColor }}>{alphaText}</div>
      )}
    </div>
  );
};

const KV = ({ k, v }) => (
  <div>
    <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500 mb-0.5">{k}</div>
    <div className="text-[12px] text-neutral-200">{v}</div>
  </div>
);
