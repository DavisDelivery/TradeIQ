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
import { InvalidBacktestRunError } from './shared/backtest/validity';
import type { BacktestConfig } from './shared/backtest/types';
import {
  appendAttributionRows,
  appendDailyEquityRows,
  appendMLTrainingRows,
  appendTradeRows,
  appendWarningRows,
  persistRunFailure,
  persistRunInvalid,
  persistRunRunning,
  persistRunSummary,
  readAllAttributionRows,
  readAllDailyEquityRows,
  readAllMLTrainingRows,
  readAllTradeRows,
  readAllWarningRows,
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

// Phase 4v — pre-dispatch startup jitter (ms). When two parallel
// non-portfolio backtests (e.g. the Phase 4t sp500 + russell2k
// composite pair) trip their 13-min watchdogs in the same wall-clock
// window, their self-POSTs cluster at the gateway and hit the per-
// function concurrency ceiling — observed live on bt_20260519184819
// (sp500), which recorded `lastReinvokeError: "HTTP 500"` from its
// 5th-batch reinvoke. The dispatch's internal retry-with-backoff
// (reinvoke.ts:151+) is the primary defence; jitter just breaks up
// the simultaneous-arrival pathology that triggers the 5xx in the
// first place. Mirrors `REINVOKE_JITTER_MS` on the portfolio path
// (run-portfolio-backtest-background.ts:80).
const REINVOKE_JITTER_MS = Number(process.env.BACKTEST_REINVOKE_JITTER_MS ?? 1_500);

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

    // Terminal-status guard (FABLE validation-run finding): the runner
    // previously NEVER read the doc's status, so (a) there was no way to
    // kill a chain — marking a run 'failed' via /api/backtest-runs/recover
    // didn't stop the next reinvoke, and (b) Netlify's automatic queue
    // RETRY of a hard-killed background invocation could resurrect a
    // swept run hours later (live: bt_20260713202030's retry re-ran batch
    // 1 ~30 min after the original death and contended for the Finnhub
    // budget against the replacement run, poisoning ITS rebalance #1 with
    // ~98 rate-limit TickerFailures). Terminal docs now drain the chain.
    {
      const statusSnap = await db.collection(COLLECTION).doc(runId).get();
      const docStatus = (statusSnap.data() as { status?: string } | undefined)?.status;
      if (docStatus === 'failed' || docStatus === 'complete' || docStatus === 'invalid') {
        log.warn('terminal_status_guard', { runId, docStatus, isResume });
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, runId, drained: true, docStatus }),
        };
      }
    }

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

    // Track-3 M1 — wall-clock fetch date, injected at this boundary so the
    // engine stays wall-clock-free; refuses PIT-caching of still-growing
    // (today/future) bar windows + clamps a future endDate.
    const todayIso = new Date().toISOString().slice(0, 10);
    validateConfig(config, todayIso);

    const prep = await prepRun(config, todayIso);
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
        todayIso,
        state: cursor.state ?? initialRegularState(config, totalRebalances, prep.rebalanceDates[0]),
        // Per-run override (validated to [1,16] at trigger time) beats the
        // env/default. Needed for boards whose per-rebalance wall-clock is
        // provider-rate-limit bound (fable insider @55rpm): batch 8 dies at
        // the 15-min ceiling before the FIRST checkpoint — unrecoverable.
        batchSize: config.batchSize ?? BATCH_SIZE,
        isExpired: () => watchdog.isExpired(),
        onProgress: (evt) => log.info('progress', evt),
      });
    } finally {
      watchdog.stop();
    }

    const batchElapsedMs = Date.now() - invocationStart;

    // Phase 4u — append every per-batch slice (ml rows, daily equity,
    // trades, attribution, warnings) to its subcollection BEFORE
    // writing the cursor. The cursor never carries these arrays now;
    // it only carries the cumulative counts so a resumed batch picks up
    // the next doc id. Pre-4u these all sat inline on `cursor.state`
    // and grew the doc past Firestore's 1 MiB ceiling — see
    // reports/phase-4u/diagnosis.md.
    const mlStart = cursor.cumulativeMetrics.mlTrainingCount;
    const deStart = cursor.state?.dailyEquityRowCount ?? 0;
    const trStart = cursor.state?.tradeRowCount ?? 0;
    const atStart = cursor.state?.attributionRowCount ?? 0;
    const wnStart = cursor.state?.warningRowCount ?? 0;
    try {
      if (res.batchMlRows.length > 0) {
        await appendMLTrainingRows(runId, res.batchMlRows, mlStart);
      }
      if (res.batchDailyEquity.length > 0) {
        await appendDailyEquityRows(runId, res.batchDailyEquity, deStart);
      }
      if (res.batchTrades.length > 0) {
        await appendTradeRows(runId, res.batchTrades, trStart);
      }
      if (res.batchAttribution.length > 0) {
        await appendAttributionRows(runId, res.batchAttribution, atStart);
      }
      if (res.batchWarnings.length > 0) {
        await appendWarningRows(runId, res.batchWarnings, wnStart);
      }
    } catch (e: any) {
      log.error('subcollection_append_failed', {
        runId,
        err: String(e?.message ?? e),
      });
      throw e;
    }
    const updatedMlCount = mlStart + res.batchMlRows.length;

    if (res.done) {
      // Terminal batch — read back every per-array subcollection for
      // metrics + the final result doc, then write the run summary
      // (subcollections are already populated by the per-batch
      // appends above, so persistRunSummary writes only the top-level
      // doc).
      const [allMlRows, allDailyEquity, allTrades, allAttribution, allWarnings] =
        await Promise.all([
          readAllMLTrainingRows(runId),
          readAllDailyEquityRows(runId),
          readAllTradeRows(runId),
          readAllAttributionRows(runId),
          readAllWarningRows(runId),
        ]);
      const result = finalizeRegularBacktest({
        config,
        runId,
        state: res.state,
        allMlRows,
        allDailyEquity,
        allTrades,
        allAttribution,
        allWarnings,
        benchBars: prep.benchBars,
        benchTicker: prep.benchTicker,
        rebalanceDates: prep.rebalanceDates,
        survivorship: prep.survivorship,
      });

      await persistRunSummary(runId, result);
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
        tradeCount: res.state.tradeRowCount,
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

    // Phase 4v — mirror the portfolio path (run-portfolio-backtest-
    // background.ts:408-433) by passing startup jitter to the dispatch
    // AND unconditionally stamping the W1b telemetry fields on the
    // cursor regardless of dispatch outcome. The pre-4v code only
    // wrote `lastReinvokeError` on failure, so on success the cursor
    // had no proof that a reinvoke was attempted — when a parallel
    // run's reinvoke chain stalled (live: bt_20260519184826 / russell2k
    // composite, 6 invocations with zero W1b telemetry on the cursor),
    // we could not distinguish "dispatch never ran" from "dispatch ran
    // and the next invocation was throttled". The always-stamp pattern
    // pins that distinction. See reports/phase-4v-backtest-concurrency/
    // diagnosis.md.
    const reinvokeCtx: ReinvokeContext = context as unknown as ReinvokeContext;
    const dispatched = await dispatchReinvoke(
      reinvokeUrl,
      runId,
      reinvokeCtx,
      {},
      { jitterMs: REINVOKE_JITTER_MS },
    );

    const cursorWithDispatch: BacktestCursor<RegularBacktestState> = {
      ...nextCursor,
      lastReinvokeAt: new Date().toISOString(),
      reinvokeAttempts: (cursor.reinvokeAttempts ?? 0) + 1,
      lastReinvokeRetries: dispatched.attempts,
      lastReinvokeStatus: dispatched.lastStatus,
      ...(dispatched.ok
        ? { lastReinvokeError: undefined }
        : { lastReinvokeError: dispatched.error ?? 'unknown dispatch failure' }),
    };
    await writeCursor(db, COLLECTION, runId, cursorWithDispatch);

    if (!dispatched.ok) {
      log.error('reinvoke_dispatch_failed', {
        runId,
        attempts: dispatched.attempts,
        lastStatus: dispatched.lastStatus,
        err: dispatched.error,
      });
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
    // FIX-1 W2 — the finalize-time validity guard throws
    // InvalidBacktestRunError BEFORE metrics exist. Persist status
    // 'invalid' (never 'failed', never metrics) and clear the cursor so
    // the run terminates cleanly instead of zombie-ing at 'running'.
    if (err instanceof InvalidBacktestRunError) {
      log.error('background_run_invalid', { runId, reason: err.message });
      await persistRunInvalid(runId, err.message).catch(() => {});
      await clearCursor(db, COLLECTION, runId).catch(() => {});
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: false, runId, status: 'invalid', reason: err.message }),
      };
    }
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
