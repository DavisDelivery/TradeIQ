import React, { useState, useEffect, useMemo } from 'react';
import { AlertTriangle, CircleX } from 'lucide-react';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { MOCK_EARNINGS } from './lib/mockData.js';
import { useEarnings } from './hooks/useEarnings.js';
import { readLog } from './tradeLog.js';

const DetailStat = ({ label, value, color }) => (
  <div>
    <div className="text-neutral-500 uppercase tracking-widest text-[9px] font-mono mb-0.5">{label}</div>
    <div className="text-sm font-mono" style={color ? { color } : { color: '#e5e5e5' }}>{value}</div>
  </div>
);

const EARNINGS_WINDOWS = [3, 7, 14, 30];

const PLAY_TYPE_LABELS = {
  long_volatility: 'Long Vol',
  short_volatility: 'Short Vol',
  directional_long: 'Directional ↑',
  directional_short: 'Directional ↓',
  pead_long: 'PEAD ↑',
  pead_short: 'PEAD ↓',
  reversal: 'Reversal',
  skip: 'Skip',
};

const PLAY_TYPE_COLORS = {
  long_volatility: '#a78bfa',
  short_volatility: '#4dbaf2',
  directional_long: '#14e89a',
  directional_short: '#f87171',
  pead_long: '#34d399',
  pead_short: '#fb7185',
  reversal: '#fbbf24',
  skip: '#737373',
};

const fmtUsdEarnings = (n) => {
  if (!Number.isFinite(n)) return '—';
  return `$${n.toFixed(2)}`;
};

export const EarningsPlaysView = () => {
  const [windowDays, setWindowDays] = useState(() => {
    if (typeof window !== 'undefined') {
      const u = new URL(window.location.href);
      const d = Number(u.searchParams.get('earningsDays'));
      if (EARNINGS_WINDOWS.includes(d)) return d;
    }
    return 7;
  });
  const [filter, setFilter] = useState('all');
  const [expandedKey, setExpandedKey] = useState(null);
  const [loggedIds, setLoggedIds] = useState(() => new Set(readLog().filter((t) => t.source === 'earnings').map((t) => t.ticker + '|' + t.reportDate)));

  const { sortKey, sortDir, sortBy, sortRows } = useSortable('composite', 'desc');
  const { data, error, isLoading: loading, isFetching, forceRescan } = useEarnings(windowDays);
  const isRescanning = isFetching && !loading;

  // Sync window selection to URL for bookmarkability
  useEffect(() => {
    if (typeof window === 'undefined') return;
    const u = new URL(window.location.href);
    u.searchParams.set('earningsDays', String(windowDays));
    window.history.replaceState({}, '', u.toString());
  }, [windowDays]);

  const setups = data?.setups ?? [];
  const filtered = setups.filter((e) => {
    if (filter === 'all') return true;
    if (filter === 'pre') return !e.postPrint;
    if (filter === 'post') return e.postPrint;
    return e.bias === filter;
  });
  const sorted = useMemo(() => sortRows(filtered), [filtered, sortKey, sortDir, sortRows]);

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="mb-6 flex items-start justify-between gap-3 flex-wrap">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">Earnings Setups</div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className="text-emerald-400">{sorted.length}</span>{' '}
                <span className="text-neutral-500 italic font-light">
                  earnings plays in {windowDays}d window
                </span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Pre-print volatility & directional plays + post-print PEAD/reversal setups.
            Each card shows entry trigger, stop, targets, sizing, and historical edge.
          </p>
        </div>
        <div className="flex-shrink-0">
          <FreshnessPill
            meta={data}
            isRescanning={isRescanning}
            onForceRescan={() => forceRescan()}
          />
        </div>
      </div>

      {/* Window + filter row */}
      <div className="flex items-center gap-1 text-[11px] font-mono mb-3 flex-wrap">
        <span className="text-neutral-500 mr-2 uppercase tracking-widest">Window</span>
        {EARNINGS_WINDOWS.map((d) => (
          <button
            key={d}
            onClick={() => setWindowDays(d)}
            className={`px-2.5 h-7 transition-colors ${
              windowDays === d
                ? 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/40'
                : 'text-neutral-500 border border-neutral-800 hover:border-neutral-600'
            }`}
          >
            {d}d
          </button>
        ))}
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
          <div className="text-neutral-400 text-sm">Loading earnings calendar and computing IV proxies…</div>
          <div className="text-neutral-600 text-[11px] mt-1 font-mono">15-22 seconds for fresh scan</div>
        </div>
      )}

      {data && (
        <div className="flex items-center gap-1 text-[11px] font-mono mb-5 flex-wrap">
          <span className="text-neutral-500 mr-2 uppercase tracking-widest">Filter</span>
          {[
            ['all', 'ALL'],
            ['pre', 'PRE-PRINT'],
            ['post', 'POST-PRINT'],
            ['sell_premium', 'SELL VOL'],
            ['buy_premium', 'BUY VOL'],
          ].map(([key, label]) => (
            <button key={key} onClick={() => setFilter(key)}
              className={`px-2 h-7 transition-colors ${filter === key ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-500 hover:text-neutral-300'}`}>
              {label}
            </button>
          ))}
          <span className="ml-auto text-neutral-600 text-[10px]">
            Checked {data.universeChecked ?? '—'} · Generated {data.generatedAt ? new Date(data.generatedAt).toLocaleTimeString() : '—'}
          </span>
        </div>
      )}

      {sorted.length === 0 && data && !loading && (
        <div className="border border-neutral-800 p-6 text-center text-neutral-500 text-sm">
          No qualifying earnings plays in this window.
        </div>
      )}

      {/* Sortable summary table */}
      {sorted.length > 0 && (
        <div className="border border-neutral-800 overflow-x-auto mb-4">
          <table className="w-full text-[12px] font-mono">
            <thead className="bg-neutral-900/40 text-[10px] uppercase tracking-widest text-neutral-500">
              <tr>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ticker" align="left">Ticker</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="composite" align="right">Score</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="daysUntil" align="right">Days</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="playType" align="left">Play Type</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="expectedMove" align="right">Exp Move</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="avgPriorMove" align="right">Avg Prior</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="moveRatio" align="right">Ratio</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="ivr" align="right">IVR</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="bias" align="left">Bias</SortableTh>
              </tr>
            </thead>
            <tbody>
              {sorted.map((e) => {
                const cardKey = `${e.ticker ?? '?'}|${e.reportDate ?? '?'}`;
                const isOpen = expandedKey === cardKey;
                const ptColor = PLAY_TYPE_COLORS[e.playType] || '#737373';
                const ptLabel = PLAY_TYPE_LABELS[e.playType] || e.playType || '—';
                const compColor = e.composite >= 80 ? '#14e89a' : e.composite >= 70 ? '#4dbaf2' : '#a3a3a3';
                return (
                  <React.Fragment key={cardKey}>
                    <tr
                      onClick={() => setExpandedKey(isOpen ? null : cardKey)}
                      className={`border-t border-neutral-800/60 cursor-pointer transition-colors ${isOpen ? 'bg-neutral-900/40' : 'hover:bg-neutral-900/20'}`}
                    >
                      <td className="px-3 py-2.5 font-serif font-bold text-neutral-100 text-[13px]">{e.ticker}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums font-bold" style={{ color: compColor }}>{e.composite ?? '—'}</td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                        {Number.isFinite(e.daysUntil) ? (e.daysUntil < 0 ? `${Math.abs(e.daysUntil)}d ago` : `${e.daysUntil}d`) : '—'}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="px-1.5 py-0.5 text-[10px] uppercase tracking-widest border" style={{ color: ptColor, borderColor: ptColor + '55', background: ptColor + '15' }}>
                          {ptLabel}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                        {Number.isFinite(e.expectedMove) ? `±${e.expectedMove.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                        {Number.isFinite(e.avgPriorMove) ? `${e.avgPriorMove.toFixed(1)}%` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                        {Number.isFinite(e.moveRatio) ? `${e.moveRatio.toFixed(2)}x` : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-right tabular-nums text-neutral-300">
                        {Number.isFinite(e.ivr) ? e.ivr : '—'}
                      </td>
                      <td className="px-3 py-2.5 text-neutral-400 text-[11px]">
                        {(e.bias ?? '—').replace(/_/g, ' ')}
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-t border-neutral-800/60 bg-neutral-950/60">
                        <td colSpan={9} className="p-0">
                          <EarningsSetupDetail
                            setup={e}
                            alreadyLogged={loggedIds.has(cardKey)}
                            onLog={() => {
                              logTrade({
                                ticker: e.ticker,
                                source: 'earnings',
                                loggedPrice: e.price,
                                strategy: e.strategy,
                                bias: e.bias,
                                playType: e.playType,
                                reportDate: e.reportDate,
                                reportTime: e.reportTime,
                                daysUntilAtLog: e.daysUntil,
                                expectedMove: e.expectedMove,
                                ivr: e.ivr,
                                avgPriorMove: e.avgPriorMove,
                                moveRatio: e.moveRatio,
                                composite: e.composite,
                                rationale: e.rationale,
                                triggers: e.triggers,
                              });
                              setLoggedIds(new Set([...loggedIds, cardKey]));
                            }}
                          />
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="border border-amber-500/20 bg-amber-500/5 p-4 flex items-start gap-3">
        <AlertTriangle className="h-5 w-5 text-amber-400 flex-shrink-0 mt-0.5" />
        <div>
          <div className="font-serif text-base text-neutral-200">IV crush risk on every earnings trade</div>
          <p className="text-[13px] text-neutral-400 mt-1 leading-relaxed">
            IV values are a realized-vol proxy until TradeStation options chain is wired up.
            Real IV Rank will be more precise. Even a correct directional call can lose if the
            realized move matches the expected move. Size tiny until you have 20+ closed earnings trades.
          </p>
        </div>
      </div>
    </div>
  );
};

// Read & persist the user's account size for contract-count math.
// localStorage works in the real Vite build (this isn't an artifact context).
// Default $100K; user can edit per-card and the value sticks across sessions.
const ACCT_SIZE_KEY = 'tradeiq:accountSize';
const readAccountSize = () => {
  try {
    const v = parseFloat(localStorage.getItem(ACCT_SIZE_KEY) ?? '');
    return Number.isFinite(v) && v > 0 ? v : 100000;
  } catch { return 100000; }
};
const writeAccountSize = (v) => {
  try { localStorage.setItem(ACCT_SIZE_KEY, String(v)); } catch {}
};

const fmtCompact = (n) => {
  if (!Number.isFinite(n)) return '—';
  if (Math.abs(n) >= 1_000_000) return `$${(n / 1_000_000).toFixed(2)}M`;
  if (Math.abs(n) >= 1_000) return `$${(n / 1_000).toFixed(0)}K`;
  return `$${n.toLocaleString()}`;
};

const EarningsSetupDetail = ({ setup: e, alreadyLogged, onLog }) => {
  const ptColor = PLAY_TYPE_COLORS[e.playType] || '#737373';
  const t = e.triggers ?? null;
  const edge = e.historicalEdge ?? null;
  const opts = t?.options ?? null;
  const steps = t?.executionSteps ?? null;

  const [acctSize, setAcctSize] = useState(readAccountSize);
  const [acctInput, setAcctInput] = useState(() => String(readAccountSize()));

  const handleAcctBlur = () => {
    const v = parseFloat(acctInput);
    if (Number.isFinite(v) && v > 0) {
      setAcctSize(v);
      writeAccountSize(v);
    } else {
      setAcctInput(String(acctSize));
    }
  };

  // Compute concrete contract / share counts from account size + risk %
  const riskBudget = acctSize * ((t?.positionSizePct ?? 0.5) / 100);
  let contractCount = null;
  let shareCount = null;
  if (opts) {
    // For options: max loss per contract = options.maxLossPerContract
    // (long straddle: debit; iron condor: width − credit; * 100)
    const lossPerCtr = opts.maxLossPerContract ?? null;
    if (lossPerCtr && lossPerCtr > 0) {
      contractCount = Math.max(1, Math.floor(riskBudget / lossPerCtr));
    }
  } else if (t?.stop && Number.isFinite(t.stop) && Number.isFinite(e.price)) {
    const lossPerShare = Math.abs(e.price - t.stop);
    if (lossPerShare > 0) shareCount = Math.max(1, Math.floor(riskBudget / lossPerShare));
  }

  const isVolPlay = !!opts;

  return (
    <div className="p-4 space-y-4 text-[12px]">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <DetailStat label="Strategy" value={e.strategy ?? '—'} color={ptColor} />
        <DetailStat label="Report" value={`${e.reportDate ?? '—'} · ${(e.reportTime ?? '').toUpperCase() || 'DMH'}`} />
        <DetailStat
          label="Position size"
          value={t?.positionSizePct ? `${t.positionSizePct.toFixed(1)}% acct` : '—'}
        />
        {isVolPlay ? (
          <DetailStat
            label="Max risk"
            value={opts?.maxLossPerContract ? fmtCompact(opts.maxLossPerContract) + '/ctr' : '—'}
            color="#f87171"
          />
        ) : (
          <DetailStat
            label="R:R"
            value={t?.riskReward ? `${t.riskReward.toFixed(2)}` : '—'}
            color={t?.riskReward && t.riskReward >= 2 ? '#14e89a' : t?.riskReward && t.riskReward < 1 ? '#f59e0b' : undefined}
          />
        )}
      </div>

      {/* Trade Plan — entry text + (price targets only for non-vol plays) */}
      {t && (
        <div className="border border-neutral-800 bg-neutral-900/30 p-3">
          <div className="font-mono uppercase tracking-widest text-[9px] text-neutral-500 mb-2">Trade Plan</div>
          <div className="space-y-1.5">
            <div>
              <span className="text-neutral-500 text-[10px] uppercase tracking-widest mr-2">Entry:</span>
              <span className="text-neutral-200">{t.entry}</span>
            </div>
            {/* Stock-price stop/T1-T3 are only meaningful for directional/PEAD/reversal.
                For vol plays, the real risk lives in the options structure block below. */}
            {!isVolPlay && (
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mt-2">
                <DetailStat label="Stop" value={t.stop ? fmtUsdEarnings(t.stop) : '—'} color="#f87171" />
                <DetailStat label="T1" value={t.targets?.t1 ? fmtUsdEarnings(t.targets.t1) : '—'} color="#14e89a" />
                <DetailStat label="T2" value={t.targets?.t2 ? fmtUsdEarnings(t.targets.t2) : '—'} color="#14e89a" />
                <DetailStat label="T3" value={t.targets?.t3 ? fmtUsdEarnings(t.targets.t3) : '—'} color="#14e89a" />
              </div>
            )}
          </div>
        </div>
      )}

      {/* Options Structure — for vol plays only */}
      {opts && (
        <div className="border border-neutral-800 bg-neutral-900/30 p-3">
          <div className="font-mono uppercase tracking-widest text-[9px] text-neutral-500 mb-2">
            Options Structure · {opts.structure.replace(/_/g, ' ')}
          </div>
          <div className="space-y-2">
            {/* Legs table */}
            <div className="grid grid-cols-[auto_auto_auto_auto] gap-x-4 gap-y-0.5 text-[12px] font-mono">
              <div className="text-neutral-500 text-[9px] uppercase tracking-widest">Action</div>
              <div className="text-neutral-500 text-[9px] uppercase tracking-widest">Type</div>
              <div className="text-neutral-500 text-[9px] uppercase tracking-widest">Strike</div>
              <div className="text-neutral-500 text-[9px] uppercase tracking-widest">Expiry</div>
              {opts.legs.map((leg, i) => (
                <React.Fragment key={i}>
                  <div className={leg.action === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                    {leg.action.toUpperCase()}
                  </div>
                  <div className="text-neutral-200">{leg.optionType.toUpperCase()}</div>
                  <div className="text-neutral-200 tabular-nums">${leg.strike.toFixed(2)}</div>
                  <div className="text-neutral-400 tabular-nums">{opts.expiry}</div>
                </React.Fragment>
              ))}
            </div>
            {/* Economics */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 pt-2 border-t border-neutral-800/60">
              {opts.estCreditPerContract !== null && opts.estCreditPerContract !== undefined && (
                <DetailStat
                  label="Est. credit"
                  value={`$${opts.estCreditPerContract.toFixed(2)}`}
                  color="#14e89a"
                />
              )}
              {opts.estDebitPerContract !== null && opts.estDebitPerContract !== undefined && (
                <DetailStat
                  label="Est. debit"
                  value={`$${opts.estDebitPerContract.toFixed(2)}`}
                  color="#a78bfa"
                />
              )}
              <DetailStat
                label="Max profit"
                value={opts.maxProfitPerContract === null ? 'Unbounded' : fmtCompact(opts.maxProfitPerContract)}
                color="#14e89a"
              />
              <DetailStat
                label="Max loss"
                value={opts.maxLossPerContract ? fmtCompact(opts.maxLossPerContract) : '—'}
                color="#f87171"
              />
              <DetailStat
                label="Breakevens"
                value={opts.breakevens.map(b => `$${b.toFixed(2)}`).join(' / ')}
              />
            </div>
          </div>
        </div>
      )}

      {/* How to Execute — numbered, broker-agnostic step list */}
      {steps && steps.length > 0 && (
        <div className="border border-emerald-500/30 bg-emerald-500/5 p-3">
          <div className="flex items-center justify-between mb-2 gap-2 flex-wrap">
            <div className="font-mono uppercase tracking-widest text-[9px] text-emerald-400">How to Execute</div>
            <div className="flex items-center gap-1.5 text-[10px] font-mono text-neutral-500">
              <span>Account:</span>
              <span className="text-neutral-600">$</span>
              <input
                type="number"
                value={acctInput}
                onChange={(ev) => setAcctInput(ev.target.value)}
                onBlur={handleAcctBlur}
                onKeyDown={(ev) => { if (ev.key === 'Enter') ev.target.blur(); }}
                onClick={(ev) => ev.stopPropagation()}
                className="w-24 bg-neutral-900 border border-neutral-700 text-neutral-200 px-1.5 py-0.5 text-[11px] font-mono text-right focus:outline-none focus:border-emerald-500"
                aria-label="Account size for sizing math"
              />
            </div>
          </div>
          {/* Concrete sizing math */}
          <div className="bg-neutral-950/60 border border-neutral-800/60 p-2.5 mb-2 text-[11px] font-mono">
            <div className="text-neutral-500 text-[9px] uppercase tracking-widest mb-1">Your sizing</div>
            <div className="text-neutral-300">
              Risk budget: <span className="text-neutral-100">{fmtCompact(riskBudget)}</span>
              {' '}({(t?.positionSizePct ?? 0).toFixed(1)}% of {fmtCompact(acctSize)})
            </div>
            {contractCount !== null && (
              <div className="text-emerald-400 mt-0.5">
                → {contractCount} contract{contractCount !== 1 ? 's' : ''}
                {' '}({fmtCompact((opts?.maxLossPerContract ?? 0) * contractCount)} max loss)
              </div>
            )}
            {shareCount !== null && (
              <div className="text-emerald-400 mt-0.5">
                → {shareCount.toLocaleString()} share{shareCount !== 1 ? 's' : ''}
                {' '}({fmtCompact(Math.abs(e.price - (t?.stop ?? 0)) * shareCount)} max loss to stop)
              </div>
            )}
          </div>
          {/* Numbered steps */}
          <ol className="space-y-2.5">
            {steps.map((step) => (
              <li key={step.n} className="flex gap-3">
                <div className="flex-shrink-0 w-5 h-5 rounded-full bg-emerald-500/15 border border-emerald-500/40 text-emerald-400 text-[10px] font-mono font-bold flex items-center justify-center">
                  {step.n}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-neutral-100 text-[12px] font-medium">{step.title}</div>
                  <div className="text-neutral-400 text-[12px] leading-relaxed mt-0.5">{step.detail}</div>
                </div>
              </li>
            ))}
          </ol>
          <div className="mt-3 pt-2 border-t border-neutral-800/60 text-[10px] text-neutral-600 font-mono">
            Strikes & credits are estimates from the IV-based expected move. Real fills will differ; always verify on the live option chain before placing.
          </div>
        </div>
      )}

      {/* Historical edge */}
      {edge && (
        <div className="border border-neutral-800 bg-neutral-900/30 p-3">
          <div className="font-mono uppercase tracking-widest text-[9px] text-neutral-500 mb-1">Historical Edge</div>
          <div className="flex items-center gap-3">
            <div className="font-mono text-2xl font-bold" style={{ color: edge.ratePct >= 60 ? '#14e89a' : edge.ratePct >= 40 ? '#4dbaf2' : '#f59e0b' }}>
              {edge.ratePct}%
            </div>
            <div className="text-[12px] text-neutral-400">{edge.description}</div>
          </div>
        </div>
      )}

      {/* Pre-print drift signals */}
      {e.prePrintDrift && e.prePrintDrift.lean !== 'mixed' && (
        <div className="border border-neutral-800 bg-neutral-900/30 p-3">
          <div className="font-mono uppercase tracking-widest text-[9px] text-neutral-500 mb-1">Pre-Print Drift</div>
          <div className="text-[12px] text-neutral-300">
            <span className={e.prePrintDrift.lean === 'long' ? 'text-emerald-400' : 'text-rose-400'}>
              Lean {e.prePrintDrift.lean}
            </span>
            <span className="text-neutral-500 ml-2">{e.prePrintDrift.details.join(' · ')}</span>
          </div>
        </div>
      )}

      <p className="text-[12px] text-neutral-400 leading-relaxed">{e.rationale}</p>

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={(ev) => { ev.stopPropagation(); if (!alreadyLogged) onLog(); }}
          disabled={alreadyLogged}
          className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-widest border transition-colors ${
            alreadyLogged
              ? 'text-emerald-400 border-emerald-500/40 bg-emerald-500/10 cursor-default'
              : 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5 hover:bg-emerald-500/15'
          }`}
        >
          {alreadyLogged ? '✓ Logged' : '+ Log Trade'}
        </button>
        <span className="text-[10px] text-neutral-600 font-mono">
          {alreadyLogged ? 'See Journal tab for forward returns' : 'Tracks 5d/20d/30d/60d/90d returns in Journal'}
        </span>
      </div>
    </div>
  );
};
