import React, { useEffect, useState } from 'react';
import { useBacktestRuns } from './hooks/useBacktestRuns.js';
import { useBacktestRun } from './hooks/useBacktestRun.js';
import { SurvivorshipBanner } from './components/SurvivorshipBanner.jsx';
import { RunMetricsTiles } from './components/RunMetricsTiles.jsx';
import { EquityCurveChart } from './components/EquityCurveChart.jsx';
import { DrawdownChart } from './components/DrawdownChart.jsx';
import { AttributionChart } from './components/AttributionChart.jsx';
import { RegimeBreakdownTable } from './components/RegimeBreakdownTable.jsx';
import { TopTradesTable } from './components/TopTradesTable.jsx';

// BacktestView — Phase 4b run viewer (read-only).
//
// Reads from /api/backtest-runs (list) and /api/backtest-runs/:runId (detail).
// Run launcher is deferred to Phase 4b-2; placeholder banner explains this
// and surfaces the prophet-only constraint that will apply when the launcher
// lands. CLI launch instructions in the empty state.
//
// Two-section layout, single column, mobile-first:
//   1. Recent runs list (clickable rows)
//   2. Selected run detail (banner if uncorrected, metrics, charts, tables)

const fmtPct = (v) => (v == null || Number.isNaN(v) ? '—' : `${(v * 100).toFixed(2)}%`);
const fmtNum = (v) => (v == null || Number.isNaN(v) ? '—' : Number(v).toFixed(3));
const fmtDateTime = (v) => {
  if (!v) return '—';
  try {
    return new Date(v).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
  } catch {
    return String(v).slice(0, 16);
  }
};

function LauncherPlaceholder() {
  return (
    <div className="border border-neutral-800 bg-neutral-950/40 px-4 py-3 mb-4 rounded">
      <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
        Run launcher
      </div>
      <div className="text-sm text-neutral-300 leading-relaxed">
        Backtest launch UI is coming in Phase 4b-2. For now, kick off runs via CLI:{' '}
        <code className="font-mono text-xs bg-neutral-900 px-1.5 py-0.5 rounded text-neutral-200">
          npx tsx scripts/run-backtest.ts
        </code>
        .
      </div>
      <div className="text-xs text-neutral-500 mt-2 leading-relaxed">
        Board: <span className="text-neutral-300 font-mono">prophet</span> only initially —
        other boards' point-in-time scoring landed partially in Phase 4a; see{' '}
        <a
          href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
          target="_blank"
          rel="noopener noreferrer"
          className="text-neutral-300 hover:text-neutral-100 underline"
        >
          BACKTEST_LIMITATIONS.md
        </a>
        .
      </div>
    </div>
  );
}

function RunRow({ run, isSelected, onClick }) {
  const ret = run.metrics?.totalReturn;
  const sharpe = run.metrics?.sharpe;
  const trades = run.metrics?.trades ?? 0;
  const uncorrected = run.universeSurvivorshipCorrected?.corrected === false;
  const universe = run.config?.universe ?? run.universeSurvivorshipCorrected?.universe ?? '?';
  const cadence = run.config?.cadence ?? '?';
  const shortId =
    run.runId.length > 18
      ? `${run.runId.slice(0, 9)}…${run.runId.slice(-6)}`
      : run.runId;

  return (
    <button
      type="button"
      onClick={onClick}
      className={`w-full text-left border-t border-neutral-800 px-3 py-3 transition-colors ${
        isSelected ? 'bg-emerald-950/20 border-l-2 border-l-emerald-500' : 'hover:bg-neutral-900/40'
      }`}
    >
      <div className="flex items-baseline justify-between gap-2 mb-1">
        <div className="font-mono text-xs text-neutral-300 truncate">{shortId}</div>
        {uncorrected && (
          <span
            title="Universe is not survivorship-corrected"
            className="text-rose-400 text-xs flex-shrink-0"
            aria-label="not survivorship corrected"
          >
            ⚠
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 text-[10px] font-mono text-neutral-500 mb-2">
        <span>{String(universe).toUpperCase()}</span>
        <span>·</span>
        <span>{cadence}</span>
        <span>·</span>
        <span>{fmtDateTime(run.completedAt)}</span>
      </div>
      <div className="flex items-center gap-4 text-xs font-mono tabular-nums">
        <span className={(ret ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'}>
          {fmtPct(ret)}
        </span>
        <span className="text-neutral-400">Sharpe {fmtNum(sharpe)}</span>
        <span className="text-neutral-500">{trades} trades</span>
      </div>
    </button>
  );
}

function RunDetail({ runId }) {
  const { data, isLoading, error } = useBacktestRun(runId);

  if (!runId) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/20 px-4 py-12 text-center text-sm text-neutral-500 font-mono">
        Select a run to view detail
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/20 px-4 py-12 text-center text-sm text-neutral-500 font-mono">
        Loading run…
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-rose-800 bg-rose-950/20 px-4 py-6 text-sm text-rose-300 font-mono">
        Failed to load run: {String(error?.message ?? error)}
      </div>
    );
  }

  if (!data?.run) {
    return (
      <div className="border border-neutral-800 bg-neutral-950/20 px-4 py-12 text-center text-sm text-neutral-500 font-mono">
        No data for this run
      </div>
    );
  }

  const { run, dailyEquity, trades, attribution, mlTrainingCount, tradesTruncated } = data;
  const universeStamp = run.universeSurvivorshipCorrected;
  const byRegime = run.metrics?.byRegime ?? [];

  return (
    <div>
      <SurvivorshipBanner universeStamp={universeStamp} />

      <div className="mb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Run
        </div>
        <div className="font-mono text-sm text-neutral-200 mt-0.5 break-all">{run.runId}</div>
        <div className="text-[10px] text-neutral-500 font-mono mt-1">
          {String(run.config?.universe ?? '').toUpperCase()} · {run.config?.cadence ?? '?'} ·{' '}
          {fmtDateTime(run.startedAt)} → {fmtDateTime(run.completedAt)}
        </div>
        {Array.isArray(run.warnings) && run.warnings.length > 0 && (
          <div className="mt-2 border border-amber-800/60 bg-amber-950/20 px-3 py-2 text-xs text-amber-300 font-mono">
            {run.warnings.length} warning{run.warnings.length === 1 ? '' : 's'}:{' '}
            {run.warnings.slice(0, 3).join(' · ')}
            {run.warnings.length > 3 && ' …'}
          </div>
        )}
      </div>

      <RunMetricsTiles metrics={run.metrics} />

      <div className="space-y-3 mb-3">
        <EquityCurveChart dailyEquity={dailyEquity} />
        <DrawdownChart dailyEquity={dailyEquity} />
        <RegimeBreakdownTable byRegime={byRegime} />
        <AttributionChart attribution={attribution} />
        <TopTradesTable trades={trades} />
      </div>

      <div className="text-[10px] font-mono text-neutral-600 px-1">
        {dailyEquity?.length ?? 0} daily rows · {trades?.length ?? 0} trades
        {tradesTruncated ? ' (capped)' : ''} · {attribution?.length ?? 0} attribution rows ·{' '}
        {mlTrainingCount ?? 0} ml training rows
      </div>
    </div>
  );
}

export function BacktestView() {
  const { data, isLoading, error } = useBacktestRuns(20);
  const runs = data?.runs ?? [];
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Auto-select the most recent run once the list loads, but only on
  // first arrival — don't clobber a user-chosen run when the list refetches.
  useEffect(() => {
    if (selectedRunId === null && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  return (
    <div className="max-w-3xl mx-auto px-3 sm:px-4 py-4 sm:py-6">
      <div className="mb-4">
        <h1 className="text-base sm:text-lg font-mono text-neutral-100 tracking-wide">BACKTEST</h1>
        <div className="text-[10px] text-neutral-500 font-mono mt-0.5">
          Phase 4a engine · read-only
        </div>
      </div>

      <LauncherPlaceholder />

      <section className="mb-4">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2 px-1">
          Recent runs
        </div>
        <div className="border border-neutral-800 bg-neutral-950/40">
          {isLoading && (
            <div className="px-4 py-8 text-center text-sm text-neutral-500 font-mono">
              Loading runs…
            </div>
          )}
          {error && (
            <div className="px-4 py-6 text-sm text-rose-300 font-mono">
              Failed to load runs: {String(error?.message ?? error)}
            </div>
          )}
          {!isLoading && !error && runs.length === 0 && (
            <div className="px-4 py-8 text-sm text-neutral-400 font-mono leading-relaxed">
              No backtest runs yet. Run one via CLI:
              <pre className="mt-2 bg-neutral-900 p-2 text-xs overflow-x-auto whitespace-pre-wrap">
                npx tsx scripts/run-backtest.ts {'\\\n'}  --config configs/dow-2018-2024-monthly-top20.json
              </pre>
              <div className="text-[10px] text-neutral-500 mt-3">
                See{' '}
                <a
                  href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline hover:text-neutral-300"
                >
                  BACKTEST_LIMITATIONS.md
                </a>{' '}
                for what to expect.
              </div>
            </div>
          )}
          {!isLoading && !error && runs.length > 0 && (
            <div>
              {runs.map((run) => (
                <RunRow
                  key={run.runId}
                  run={run}
                  isSelected={selectedRunId === run.runId}
                  onClick={() => setSelectedRunId(run.runId)}
                />
              ))}
            </div>
          )}
        </div>
      </section>

      <section>
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2 px-1">
          Run detail
        </div>
        <RunDetail runId={selectedRunId} />
      </section>
    </div>
  );
}
