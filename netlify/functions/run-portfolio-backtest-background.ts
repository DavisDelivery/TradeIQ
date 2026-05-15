// Phase 4e-1 follow-up + 4e-1-infra — background runner for the portfolio backtest.
//
// 15-min container (via -background.ts filename suffix). Receives a
// runId + window from portfolio-backtest-trigger.ts, runs the harness
// against live Polygon data and Firestore-backed Prophet snapshots,
// writes the result to portfolioBacktests/{runId} on completion.
//
// Phase 4e-1-infra: a single 15-min invocation cannot complete windows
// longer than ~14 rebalances (per-rebalance compute at sp500/monthly is
// ~63 sec; the full 7-year window needs ~84 rebalances ≈ 88 min). To
// chain execution across the wall-clock ceiling we:
//   1. Read a per-run `cursor` from Firestore on entry. Null/missing →
//      fresh start. Non-null → resume from the saved batch boundary.
//   2. Drive the harness one batch (8 rebalances by default) per
//      invocation via `processPortfolioBatch`.
//   3. Stamp the post-batch state back onto `cursor` and self-reinvoke
//      via `Context.waitUntil(fetch(...))` if there's still work to do.
//   4. On the terminal batch, finalize metrics, write the summary doc,
//      stash the equity curve + swaps under detail/full, and clear the
//      cursor field (preventing a stale re-invoke from looping).

import type { Handler } from '@netlify/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { getDailyBars } from './shared/data-provider';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import type {
  BacktestWindow,
  PriceSource,
} from './shared/prophet-portfolio/backtest-harness';
import {
  finalizePortfolioBacktest,
  initialPortfolioState,
  processPortfolioBatch,
  type PortfolioBacktestState,
} from './shared/prophet-portfolio/backtest-harness-batched';
import { compositeRankingSignal } from './shared/prophet-portfolio/signal';
import type { PortfolioConfig } from './shared/prophet-portfolio/types';
import {
  clearCursor,
  readCursor,
  writeCursor,
  type BacktestCursor,
} from './shared/backtest-resume/cursor';
import { createWatchdog } from './shared/backtest-resume/watchdog';
import {
  dispatchReinvoke,
  inferFunctionUrl,
  type ReinvokeContext,
} from './shared/backtest-resume/reinvoke';

const COLLECTION = 'portfolioBacktests';

// 13-min wall-clock budget leaves 90s safety margin under Netlify's
// 15-min Background Function kill ceiling — enough for the terminal
// Firestore write + the self-reinvoke fetch to land.
const BUDGET_MS = Number(process.env.BACKTEST_BUDGET_MS ?? 13 * 60_000);
// 8 rebalances × ~63s ≈ 8.4 min — comfortably under BUDGET_MS for
// sp500/monthly. Override via BACKTEST_BATCH_SIZE for tuning.
const BATCH_SIZE = Number(process.env.BACKTEST_BATCH_SIZE ?? 8);

const RULE_CONFIG_BASE: Omit<PortfolioConfig, 'startDate'> = {
  universe: 'largecap',
  startCapital: 100_000,
  positionCount: 10,
  minHoldDays: 30,
  maxSwapsPerRebalance: 3,
  sectorCap: 4,
  slippageBps: 10,
  minComposite: 50,
  candidatePool: 15,
  version: 'v1',
};

function makeWindow(label: string, start: string, end: string): BacktestWindow {
  const startMs = Date.parse(`${start}T00:00:00Z`);
  const endMs = Date.parse(`${end}T00:00:00Z`);
  const marks: string[] = [];
  for (let t = startMs; t <= endMs; t += 86_400_000) {
    marks.push(new Date(t).toISOString().slice(0, 10));
  }
  const rebalances: string[] = [];
  for (let t = startMs; t <= endMs; t += 7 * 86_400_000) {
    rebalances.push(new Date(t).toISOString().slice(0, 10));
  }
  return { label, start, end, rebalanceDates: rebalances, markDates: marks };
}

function windowSpec(label: string): BacktestWindow {
  switch (label) {
    case 'full':
      return makeWindow('full', '2018-01-01', '2026-01-01');
    case 'half-2018':
      return makeWindow('half-2018', '2018-01-01', '2022-01-01');
    case 'half-2022':
      return makeWindow('half-2022', '2022-01-01', '2026-01-01');
    case 'covid':
      return makeWindow('covid', '2020-02-01', '2020-09-01');
    case 'rate-hikes':
      return makeWindow('rate-hikes', '2022-01-01', '2022-12-31');
    case 'short-demo':
      return makeWindow('short-demo', '2024-01-08', '2024-04-08');
    default:
      if (label.startsWith('rolling-')) {
        const year = Number(label.slice('rolling-'.length));
        if (Number.isFinite(year)) {
          return makeWindow(label, `${year}-01-01`, `${year + 1}-01-01`);
        }
      }
      throw new Error(`Unknown window label: ${label}`);
  }
}

const livePriceSource: PriceSource = {
  async closeAt(ticker: string, date: string) {
    const from = new Date(Date.parse(`${date}T00:00:00Z`) - 7 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const bars = await getDailyBars(ticker, from, date).catch(() => []);
    for (let i = bars.length - 1; i >= 0; i--) {
      const b = bars[i] as { c?: number };
      if (typeof b.c === 'number') return b.c;
    }
    return null;
  },
};

async function writeStatus(
  runId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  await getAdminDb()
    .collection(COLLECTION)
    .doc(runId)
    .set({ ...patch, updatedAt: Timestamp.now() }, { merge: true });
}

export const handler: Handler = async (event, context) => {
  const log = logger.child({ fn: 'run-portfolio-backtest-background' });

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  let payload: { runId?: string; window?: string; resume?: boolean };
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.error('payload_parse_failed', { err: String(e?.message ?? e) });
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'invalid payload' }) };
  }
  const { runId, window: label } = payload;
  if (!runId || !label) {
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'missing runId or window' }),
    };
  }

  const invocationStart = Date.now();

  try {
    const win = windowSpec(label);
    const config: PortfolioConfig = { ...RULE_CONFIG_BASE, startDate: win.start };
    const totalRebalances = [...new Set(win.rebalanceDates)].length;

    // Read existing cursor (resume) or initialize.
    const db = getAdminDb();
    const existing = await readCursor<PortfolioBacktestState>(db, COLLECTION, runId);
    const isResume = existing != null;

    const cursor: BacktestCursor<PortfolioBacktestState> = isResume
      ? {
          ...existing,
          lastInvocationStartedAt: new Date().toISOString(),
          invocationCount: existing.invocationCount + 1,
        }
      : {
          nextRebalanceIndex: 0,
          totalRebalances,
          lastInvocationStartedAt: new Date().toISOString(),
          invocationCount: 1,
          state: initialPortfolioState(config),
          cumulativeMetrics: { tradeCount: 0, mlTrainingCount: 0 },
        };

    // First batch flips status to 'running'; resumed batches just stamp the cursor.
    await writeStatus(runId, {
      status: 'running',
      ...(isResume ? {} : { runningAt: new Date().toISOString() }),
    });

    log.info('batch_start', {
      runId,
      window: label,
      isResume,
      invocationCount: cursor.invocationCount,
      nextRebalanceIndex: cursor.nextRebalanceIndex,
      totalRebalances,
    });

    // Watchdog enforces a hard early-exit before Netlify kills us.
    const watchdog = createWatchdog(BUDGET_MS, () => {
      log.warn('watchdog_expired', {
        runId,
        invocationCount: cursor.invocationCount,
        elapsedMs: Date.now() - invocationStart,
      });
    });
    watchdog.start();

    let res;
    try {
      res = await processPortfolioBatch({
        config,
        window: win,
        signal: compositeRankingSignal,
        prices: livePriceSource,
        benchmarks: {
          spy: livePriceSource,
          qqq: livePriceSource,
          iwf: livePriceSource,
        },
        state: cursor.state ?? initialPortfolioState(config),
        batchSize: BATCH_SIZE,
        isExpired: () => watchdog.isExpired(),
      });
    } finally {
      watchdog.stop();
    }

    const batchElapsedMs = Date.now() - invocationStart;

    if (res.done) {
      // Terminal batch — compute final metrics and write summary.
      const result = finalizePortfolioBacktest({
        state: res.state,
        config,
        window: win,
      });

      const summary = {
        runId,
        window: label,
        status: 'done' as const,
        startDate: result.startDate,
        endDate: result.endDate,
        portfolioReturnPct: result.portfolioReturnPct,
        spyReturnPct: result.spyReturnPct,
        qqqReturnPct: result.qqqReturnPct,
        iwfReturnPct: result.iwfReturnPct,
        excessReturnPct: result.excessReturnPct,
        sharpe: result.sharpe,
        spySharpe: result.spySharpe,
        maxDDPct: result.maxDDPct,
        spyMaxDDPct: result.spyMaxDDPct,
        longestUnderwaterDays: result.longestUnderwaterDays,
        swapCount: result.swapCount,
        avgHoldDays: result.avgHoldDays,
        turnoverPct: result.turnoverPct,
        costDragPct: result.costDragPct,
        rebalanceCount: result.rebalanceCount,
        warningsCount: result.warnings.length,
        invocationCount: cursor.invocationCount,
        completedAt: new Date().toISOString(),
      };
      await writeStatus(runId, summary);

      // Equity curve + swap detail in a subdoc to avoid the 1 MiB limit.
      await getAdminDb()
        .collection(COLLECTION)
        .doc(runId)
        .collection('detail')
        .doc('full')
        .set({
          equityCurve: result.equityCurve,
          swaps: result.swaps,
          warnings: result.warnings,
        });

      // Clear the cursor — last-write-wins so a stale re-invoke can't loop.
      await clearCursor(db, COLLECTION, runId);

      log.info('backtest_complete', {
        runId,
        window: label,
        invocationCount: cursor.invocationCount,
        batchElapsedMs,
      });
      return { statusCode: 200, body: JSON.stringify({ ok: true, runId, summary }) };
    }

    // Non-terminal batch — checkpoint the cursor and self-reinvoke.
    const nextCursor: BacktestCursor<PortfolioBacktestState> = {
      ...cursor,
      state: res.state,
      nextRebalanceIndex: res.state.nextRebalanceIdx,
      cumulativeMetrics: {
        tradeCount: res.state.swaps.length,
        mlTrainingCount: cursor.cumulativeMetrics.mlTrainingCount,
      },
    };
    await writeCursor(db, COLLECTION, runId, nextCursor);

    const headers: Record<string, string | undefined> = {};
    if (event.headers) {
      for (const [k, v] of Object.entries(event.headers)) {
        headers[k] = v ?? undefined;
      }
    }
    const reinvokeUrl = inferFunctionUrl(
      headers,
      '/.netlify/functions/run-portfolio-backtest-background',
    );

    const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;
    const dispatched = await dispatchReinvoke(reinvokeUrl, runId, reinvokeCtx, {
      window: label,
    });

    if (!dispatched.ok) {
      // Stamp the error onto the cursor for visibility but still return
      // 202 — the cursor is committed so a manual re-fire can recover.
      await writeCursor(db, COLLECTION, runId, {
        ...nextCursor,
        lastReinvokeError: dispatched.error,
      });
      log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
    }

    log.info('batch_complete_continuing', {
      runId,
      window: label,
      invocationCount: cursor.invocationCount,
      rebalancesProcessed: res.rebalancesProcessed,
      nextRebalanceIndex: res.state.nextRebalanceIdx,
      totalRebalances,
      batchElapsedMs,
    });
    return {
      statusCode: 202,
      body: JSON.stringify({
        ok: true,
        runId,
        continuing: true,
        invocationCount: cursor.invocationCount,
        nextRebalanceIndex: res.state.nextRebalanceIdx,
        totalRebalances,
      }),
    };
  } catch (err: any) {
    log.error('backtest_failed', { runId, err: String(err?.message ?? err) });
    await writeStatus(runId, {
      status: 'failed',
      error: String(err?.message ?? err),
      failedAt: new Date().toISOString(),
    }).catch(() => {});
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
