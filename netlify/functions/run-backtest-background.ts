// Phase 4b-2 + 4e-1-infra — background runner for the regular backtest engine.
//
// Why this exists:
//   Backtests take 5–88 minutes. Netlify's HTTP gateway times outbound
//   requests at 211s. The only way to run the engine via HTTP without
//   buying paid background-functions add-on is the `-background.ts`
//   filename suffix: any function whose file ends in this suffix is
//   bundled as a background function with a 15-minute container window
//   regardless of how it's invoked.
//
// Phase 4e-1-infra: the 15-min ceiling is itself a hard ceiling, so a
// single invocation cannot complete the full 7-year sp500/monthly
// window (~84 rebalances × ~63 sec ≈ 88 min). To chain execution we:
//   1. Read a per-run `cursor` from backtestRuns/{runId} on entry.
//      Null/missing → fresh start. Non-null → resume.
//   2. Drive the engine one batch (8 rebalances by default) per
//      invocation via `processRegularBatch`.
//   3. Append each batch's mlTraining rows to the run's mlTraining
//      subcollection immediately (rows are too heavy to carry in the
//      cursor doc — would push past Firestore's 1 MiB ceiling).
//   4. Stamp the post-batch state back onto `cursor` and self-reinvoke
//      via `Context.waitUntil(fetch(...))` if more rebalances remain.
//   5. On the terminal batch, read back all mlTraining rows to compute
//      the information coefficient, finalize metrics, persist the full
//      result, and clear the cursor.

import type { Handler } from '@netlify/functions';
import { validateConfig } from './shared/backtest/engine';
import {
  finalizeRegularBacktest,
  initialRegularState,
  prepRun,
  processRegularBatch,
  type RegularBacktestState,
} from './shared/backtest/engine-batched';
import type { BacktestConfig } from './shared/backtest/types';
import {
  appendMLTrainingRows,
  persistRunFailure,
  persistRunResult,
  persistRunRunning,
  readAllMLTrainingRows,
} from './shared/backtest/persistence';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { withSentry } from './shared/sentry';
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

const COLLECTION = 'backtestRuns';

// 13-min wall-clock budget leaves 90s safety margin under Netlify's
// 15-min Background Function kill ceiling — enough for the terminal
// Firestore write + the self-reinvoke fetch to land.
const BUDGET_MS = Number(process.env.BACKTEST_BUDGET_MS ?? 13 * 60_000);
// 8 rebalances × ~63s ≈ 8.4 min — comfortably under BUDGET_MS for
// sp500/monthly. Override via BACKTEST_BATCH_SIZE for tuning.
const BATCH_SIZE = Number(process.env.BACKTEST_BATCH_SIZE ?? 8);

interface BackgroundPayload {
  runId: string;
  config?: BacktestConfig;
  resume?: boolean;
}

export const handler: Handler = withSentry(async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'run-backtest-background' });

  let payload: BackgroundPayload;
  try {
    payload = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.error('payload_parse_failed', { err: String(e?.message ?? e) });
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'invalid payload json' }),
    };
  }

  const { runId } = payload;
  if (!runId || typeof runId !== 'string') {
    log.error('missing_runid', {});
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'missing runId' }),
    };
  }

  const invocationStart = Date.now();
  const db = getAdminDb();

  try {
    // Resume path: the cursor + the persisted config in the run doc are
    // the source of truth. Fresh start: payload.config carries the config
    // (matches the v1 trigger contract).
    const existing = await readCursor<RegularBacktestState>(db, COLLECTION, runId);
    const isResume = existing != null;

    let config: BacktestConfig | undefined = payload.config;
    if (isResume || !config) {
      // Read the persisted config from the run doc. Trigger writes it at
      // 'pending' time; we re-load it here so resumed invocations don't
      // depend on the reinvoke body carrying the entire config.
      const snap = await db.collection(COLLECTION).doc(runId).get();
      const data = snap.data();
      const persistedConfig = data?.config as BacktestConfig | undefined;
      if (!persistedConfig) {
        log.error('missing_config', { runId, isResume });
        return {
          statusCode: 400,
          body: JSON.stringify({
            ok: false,
            error: isResume ? 'no persisted config for resumed run' : 'missing config',
          }),
        };
      }
      config = persistedConfig;
    }

    validateConfig(config);

    const prep = await prepRun(config);
    const totalRebalances = prep.rebalanceDates.length;

    const cursor: BacktestCursor<RegularBacktestState> = isResume
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
          state: initialRegularState(config, totalRebalances, prep.rebalanceDates[0]),
          cumulativeMetrics: { tradeCount: 0, mlTrainingCount: 0 },
        };

    // First batch flips status to 'running' (Phase 4b-2 contract: trigger
    // wrote 'pending', bg-function flips to 'running' on entry). Resumed
    // batches don't re-stamp.
    if (!isResume) {
      try {
        await persistRunRunning(runId);
      } catch (e: any) {
        log.warn('status_running_failed', { runId, err: String(e?.message ?? e) });
      }
    }

    log.info('batch_start', {
      runId,
      universe: config.universe,
      isResume,
      invocationCount: cursor.invocationCount,
      nextRebalanceIndex: cursor.nextRebalanceIndex,
      totalRebalances,
    });

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
      res = await processRegularBatch({
        config,
        runId,
        state: cursor.state ?? initialRegularState(config, totalRebalances, prep.rebalanceDates[0]),
        batchSize: BATCH_SIZE,
        isExpired: () => watchdog.isExpired(),
        onProgress: (evt) => log.info('progress', evt),
      });
    } finally {
      watchdog.stop();
    }

    const batchElapsedMs = Date.now() - invocationStart;

    // Append THIS batch's mlTraining rows to the subcollection.
    if (res.batchMlRows.length > 0) {
      try {
        await appendMLTrainingRows(
          runId,
          res.batchMlRows,
          cursor.cumulativeMetrics.mlTrainingCount,
        );
      } catch (e: any) {
        log.error('ml_append_failed', {
          runId,
          err: String(e?.message ?? e),
        });
        throw e;
      }
    }
    const updatedMlCount = cursor.cumulativeMetrics.mlTrainingCount + res.batchMlRows.length;

    if (res.done) {
      // Terminal batch — read back all mlRows for IC computation, finalize.
      const allMlRows = await readAllMLTrainingRows(runId);
      const result = finalizeRegularBacktest({
        config,
        runId,
        state: res.state,
        allMlRows,
        benchBars: prep.benchBars,
        benchTicker: prep.benchTicker,
        rebalanceDates: prep.rebalanceDates,
        survivorship: prep.survivorship,
      });

      await persistRunResult(runId, result);
      await clearCursor(db, COLLECTION, runId);

      log.info('background_run_complete', {
        runId,
        invocationCount: cursor.invocationCount,
        tradeCount: result.metrics.tradeCount,
        totalReturnPct: result.metrics.totalReturnPct,
        batchElapsedMs,
      });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, runId: result.runId }),
      };
    }

    // Non-terminal batch — checkpoint and reinvoke.
    const nextCursor: BacktestCursor<RegularBacktestState> = {
      ...cursor,
      state: res.state,
      nextRebalanceIndex: res.state.nextRebalanceIdx,
      cumulativeMetrics: {
        tradeCount: res.state.trades.length,
        mlTrainingCount: updatedMlCount,
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
      '/.netlify/functions/run-backtest-background',
    );

    const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;
    const dispatched = await dispatchReinvoke(reinvokeUrl, runId, reinvokeCtx);

    if (!dispatched.ok) {
      await writeCursor(db, COLLECTION, runId, {
        ...nextCursor,
        lastReinvokeError: dispatched.error,
      });
      log.error('reinvoke_dispatch_failed', { runId, err: dispatched.error });
    }

    log.info('batch_complete_continuing', {
      runId,
      invocationCount: cursor.invocationCount,
      rebalancesProcessed: res.rebalancesProcessed,
      nextRebalanceIndex: res.state.nextRebalanceIdx,
      totalRebalances,
      mlTrainingCount: updatedMlCount,
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
    log.error('background_run_failed', { runId, err: String(err?.message ?? err) });
    // Persist failure status so the run doc doesn't stay stuck at 'running'.
    await persistRunFailure(runId, String(err?.message ?? err)).catch(() => {});
    return {
      statusCode: 500,
      body: JSON.stringify({
        ok: false,
        runId,
        error: String(err?.message ?? err),
      }),
    };
  }
});
