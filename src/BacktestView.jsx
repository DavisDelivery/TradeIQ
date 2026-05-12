import React, { useState, useEffect, useMemo } from 'react';
import {
  ChevronRight,
  AlertTriangle,
  Activity,
  Loader2,
  Database,
} from 'lucide-react';
import { useBacktestRuns } from './hooks/useBacktestRuns.js';
import { useBacktestRun } from './hooks/useBacktestRun.js';
import { SurvivorshipBanner } from './components/SurvivorshipBanner.jsx';
import { RunMetricsTiles } from './components/RunMetricsTiles.jsx';
import { EquityCurveChart } from './components/EquityCurveChart.jsx';
import { DrawdownChart } from './components/DrawdownChart.jsx';
import { AttributionChart } from './components/AttributionChart.jsx';
import { RegimeBreakdownTable } from './components/RegimeBreakdownTable.jsx';
import { TopTradesTable } from './components/TopTradesTable.jsx';

// Phase 4b — Backtest run viewer.
//
// Replaces the legacy BacktestView (which talked to the engine-test
// /api/backtest endpoint with a ticker list + lookback). The legacy
// useBacktest hook and /api/backtest endpoint are now unused by any
// view (EngineTestView turned out to use a separate useEngineTest hook
// against /api/engine-test). They're left in tree as dead code for
// Phase 4b's mandate — removal is a separate housekeeping pass.
//
// This view reads Phase 4a auditable run records from Firestore via
// /api/backtest-runs. Read-only in 4b-1; launcher is 4b-2.
//
// Layout (mobile-first, single column):
//   - Header
//   - Launcher placeholder (Phase 4b-2 note)
//   - Recent Runs section: list of clickable rows
//   - Run Detail section (when a run is selected):
//       - SurvivorshipBanner (renders only when corrected: false)
//       - RunMetricsTiles
//       - EquityCurveChart + DrawdownChart
//       - AttributionChart
//       - RegimeBreakdownTable
//       - TopTradesTable
//
// State: selectedRunId is sticky to the first run in the list once the
// list resolves; the user can pick another row to drill in.

function formatRelativeDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    const now = new Date();
    const ms = now - d;
    const mins = Math.floor(ms / 60000);
    const hrs = Math.floor(ms / 3_600_000);
    const days = Math.floor(ms / 86_400_000);
    if (mins < 1) return 'just now';
    if (mins < 60) return `${mins}m ago`;
    if (hrs < 24) return `${hrs}h ago`;
    if (days < 30) return `${days}d ago`;
    return d.toISOString().slice(0, 10);
  } catch {
    return String(iso).slice(0, 10);
  }
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${Number(v).toFixed(2)}%`;
}
function fmtNum(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  return Number(v).toFixed(3);
}

// ----- Section headers -----------------------------------------------------

function SectionHeader({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between mb-3">
      <h2 className="text-[10px] uppercase tracking-[0.25em] text-neutral-400 font-mono font-semibold">
        {children}
      </h2>
      {hint && (
        <span className="text-[10px] text-neutral-600 font-mono">{hint}</span>
      )}
    </div>
  );
}

// ----- Run-list row --------------------------------------------------------

function RunListRow({ run, selected, onSelect }) {
  const uncorrected =
    run?.universeSurvivorshipCorrected &&
    run.universeSurvivorshipCorrected.corrected === false;
  const ret = run?.metrics?.totalReturnPct;
  const retColor =
    ret == null || !Number.isFinite(ret)
      ? 'text-neutral-300'
      : ret >= 0
        ? 'text-emerald-300'
        : 'text-rose-300';
  const universe = run?.config?.universe ?? '?';
  const board = run?.config?.board ?? '?';
  const freq = run?.config?.rebalanceFrequency ?? '?';
  return (
    <button
      type="button"
      onClick={() => onSelect(run.runId)}
      className={`w-full text-left border ${
        selected
          ? 'border-emerald-700/60 bg-emerald-950/15'
          : 'border-neutral-800 bg-neutral-950/30 hover:bg-neutral-900/40'
      } px-3 py-2.5 transition-colors`}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <div className="flex items-center gap-2 min-w-0">
          {uncorrected && (
            <AlertTriangle
              className="h-3.5 w-3.5 text-rose-400 shrink-0"
              aria-label="uncorrected universe"
            />
          )}
          <span className="font-mono text-[11px] text-neutral-200 truncate">
            {run.runId}
          </span>
        </div>
        <ChevronRight className="h-3.5 w-3.5 text-neutral-600 shrink-0" aria-hidden="true" />
      </div>
      <div className="flex items-center justify-between gap-2 text-[10px] font-mono">
        <div className="text-neutral-500 uppercase tracking-wider">
          {universe} · {board} · {freq}
        </div>
        <div className="text-neutral-500">{formatRelativeDate(run.completedAt)}</div>
      </div>
      <div className="flex items-center gap-3 mt-1.5 text-[11px] font-mono tabular-nums">
        <span className={retColor}>{fmtPct(ret)}</span>
        <span className="text-neutral-500">Sharpe {fmtNum(run?.metrics?.sharpe)}</span>
        <span className="text-neutral-500">
          {run?.metrics?.tradeCount != null ? `${run.metrics.tradeCount} trades` : ''}
        </span>
      </div>
    </button>
  );
}

// ----- Launcher placeholder ------------------------------------------------

function LauncherPlaceholder() {
  return (
    <div
      className="border border-dashed border-neutral-700 bg-neutral-950/30 px-4 py-3 mb-5 rounded"
      data-testid="launcher-placeholder"
    >
      <div className="flex items-start gap-3">
        <Activity className="h-4 w-4 text-neutral-500 shrink-0 mt-0.5" aria-hidden="true" />
        <div className="flex-1 text-[11px] font-mono">
          <div className="text-neutral-300 mb-1">
            Run launcher: coming in Phase 4b-2
          </div>
          <div className="text-neutral-500 leading-relaxed">
            Launch new backtests via CLI:{' '}
            <code className="text-neutral-300">
              npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json
            </code>
            . Board: <code className="text-neutral-300">prophet</code> only (other
            boards' PIT scoring landed partially in Phase 4a — see{' '}
            <a
              href="https://github.com/DavisDelivery/TradeIQ/blob/main/docs/BACKTEST_LIMITATIONS.md"
              target="_blank"
              rel="noopener noreferrer"
              className="underline text-neutral-400 hover:text-neutral-200"
            >
              BACKTEST_LIMITATIONS.md
            </a>
            ).
          </div>
        </div>
      </div>
    </div>
  );
}

// ----- Empty state ---------------------------------------------------------

function EmptyState() {
  return (
    <div className="border border-neutral-800 bg-neutral-950/30 p-8 text-center">
      <Database className="h-6 w-6 text-neutral-600 mx-auto mb-3" aria-hidden="true" />
      <div className="text-[12px] font-mono text-neutral-300 mb-2">
        No backtest runs yet
      </div>
      <div className="text-[11px] font-mono text-neutral-500 max-w-md mx-auto leading-relaxed">
        Run one via CLI:{' '}
        <code className="text-neutral-300">
          npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json
        </code>
        . Once the run finishes and writes to{' '}
        <code className="text-neutral-300">backtestRuns/</code>, it will appear here.
      </div>
    </div>
  );
}

// ----- Run detail ----------------------------------------------------------

function RunDetail({ runId }) {
  const { data, error, isLoading, refetch } = useBacktestRun(runId);

  if (isLoading) {
    return (
      <div className="border border-neutral-800 p-6 flex items-center justify-center text-neutral-500 font-mono text-[11px]">
        <Loader2 className="h-4 w-4 animate-spin mr-2" />
        Loading run detail…
      </div>
    );
  }

  if (error) {
    return (
      <div className="border border-rose-800/50 bg-rose-950/20 p-4 font-mono text-[11px] text-rose-300">
        Failed to load run: {error?.message ?? String(error)}
        <button
          type="button"
          onClick={() => refetch()}
          className="ml-3 underline hover:text-rose-100"
        >
          retry
        </button>
      </div>
    );
  }

  if (!data?.run) return null;

  const { run, dailyEquity, attribution } = data;
  return (
    <div data-testid="run-detail">
      <SurvivorshipBanner universeStamp={run.universeSurvivorshipCorrected} />
      <div className="mb-4 text-[11px] font-mono text-neutral-500">
        <span className="text-neutral-300">{run.runId}</span>
        {' · '}
        {run.config?.universe?.toUpperCase()} · {run.config?.board}
        {' · '}
        {run.config?.startDate} → {run.config?.endDate}
        {' · '}
        {run.config?.rebalanceFrequency}
      </div>
      <RunMetricsTiles metrics={run.metrics} benchmark={run.benchmark} />
      <div className="grid grid-cols-1 gap-4 mb-4">
        <EquityCurveChart dailyEquity={dailyEquity} />
        <DrawdownChart dailyEquity={dailyEquity} />
      </div>
      <div className="mb-4">
        <AttributionChart attribution={attribution} />
      </div>
      <div className="grid grid-cols-1 gap-4">
        <RegimeBreakdownTable perRegime={run.metrics?.perRegime} />
        <TopTradesTable attribution={attribution} />
      </div>
      {Array.isArray(run.warnings) && run.warnings.length > 0 && (
        <div className="mt-4 border border-amber-800/50 bg-amber-950/15 px-3 py-2 font-mono text-[10px] text-amber-300/90">
          <div className="font-semibold mb-1">Run warnings ({run.warnings.length})</div>
          <ul className="list-disc list-inside space-y-0.5">
            {run.warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ----- Main view -----------------------------------------------------------

export const BacktestView = () => {
  const { data, error, isLoading, refetch } = useBacktestRuns(20);
  const runs = useMemo(() => data?.runs ?? [], [data]);
  const [selectedRunId, setSelectedRunId] = useState(null);

  // Default-select the most recent run once the list resolves. We don't
  // overwrite a user's explicit pick — only set the default when nothing
  // is selected yet.
  useEffect(() => {
    if (!selectedRunId && runs.length > 0) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  // Defensive: if the user's selected run vanishes from the list (e.g.
  // a paginated refetch dropped it), reset to the first available run.
  useEffect(() => {
    if (selectedRunId && runs.length > 0 && !runs.some((r) => r.runId === selectedRunId)) {
      setSelectedRunId(runs[0].runId);
    }
  }, [runs, selectedRunId]);

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      {/* Header */}
      <div className="mb-5">
        <div className="flex items-baseline gap-3 mb-1">
          <h1 className="text-xl sm:text-2xl font-mono font-semibold text-neutral-100 tracking-tight">
            BACKTEST
          </h1>
          <span className="text-[10px] uppercase tracking-[0.2em] text-neutral-600 font-mono">
            Phase 4a · read-only
          </span>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Auditable historical backtest runs from the Phase 4a engine. Equity,
          drawdown, attribution, regime, and trade-level outcomes are stored
          immutably in Firestore and rendered here.
        </p>
      </div>

      <LauncherPlaceholder />

      {/* Recent Runs */}
      <div className="mb-6">
        <SectionHeader hint={runs.length > 0 ? `${runs.length} runs` : undefined}>
          Recent runs
        </SectionHeader>
        {isLoading && (
          <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-[11px]">
            <Loader2 className="h-4 w-4 animate-spin inline-block mr-2" />
            Loading runs…
          </div>
        )}
        {error && (
          <div className="border border-rose-800/50 bg-rose-950/20 p-4 font-mono text-[11px] text-rose-300">
            Failed to load runs: {error?.message ?? String(error)}
            <button
              type="button"
              onClick={() => refetch()}
              className="ml-3 underline hover:text-rose-100"
            >
              retry
            </button>
          </div>
        )}
        {!isLoading && !error && runs.length === 0 && <EmptyState />}
        {!isLoading && !error && runs.length > 0 && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2" data-testid="run-list">
            {runs.map((run) => (
              <RunListRow
                key={run.runId}
                run={run}
                selected={run.runId === selectedRunId}
                onSelect={setSelectedRunId}
              />
            ))}
          </div>
        )}
      </div>

      {/* Run Detail */}
      {selectedRunId && (
        <div className="mt-6">
          <SectionHeader>Run detail</SectionHeader>
          <RunDetail runId={selectedRunId} />
        </div>
      )}
    </div>
  );
};
