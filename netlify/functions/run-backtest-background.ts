// Phase 4b-2 — background runner for the Phase 4a backtest engine.
//
// Why this exists:
//   Backtests take 5–15 minutes. Netlify's HTTP gateway times outbound
//   requests at 211s. The only way to run the engine via HTTP without
//   buying paid background-functions add-on is the `-background.ts`
//   filename suffix: any function whose file ends in this suffix is
//   bundled as a background function with a 15-minute container window
//   regardless of how it's invoked.
//
// Invocation:
//   POST /.netlify/functions/run-backtest-background
//   Body: { runId, config }
//
//   The trigger endpoint (backtest-runs-trigger.ts) has already:
//     - validated the config via runBacktest's validateConfig
//     - generated the runId
//     - written backtestRuns/{runId} with status: 'pending'
//     - fired-and-forgotten a POST here
//
//   The background function:
//     - flips status to 'running' via persistRunRunning(runId)
//     - awaits runBacktest(config, { resumeRunId: runId })
//       which writes the full result on success or status: 'failed' on
//       throw (via the engine's existing persistRunResult / persistRunFailure
//       paths)
//
// The HTTP response is 202 (returned synchronously by Netlify's gateway
// regardless of what we return here) so the body shape mostly matters
// for log-tail debugging. We still return a small JSON body for sanity.
//
// References:
//   - seed-scan-background.ts (existing reference implementation of the
//     -background.ts pattern, in production since PR #14)
//   - briefs/phase-4b-2-brief.md W1

import type { Handler } from '@netlify/functions';
import { runBacktest } from './shared/backtest/engine';
import type { BacktestConfig } from './shared/backtest/types';
import { persistRunRunning } from './shared/backtest/persistence';
import { logger } from './shared/logger';
import { withSentry } from './shared/sentry';

interface BackgroundPayload {
  runId: string;
  config: BacktestConfig;
}

export const handler: Handler = withSentry(async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const log = logger.child({ fn: 'run-backtest-background' });

  // Parse the trigger's payload.
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

  const { runId, config } = payload;
  if (!runId || typeof runId !== 'string') {
    log.error('missing_runid', {});
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'missing runId' }),
    };
  }
  if (!config || typeof config !== 'object') {
    log.error('missing_config', { runId });
    return {
      statusCode: 400,
      body: JSON.stringify({ ok: false, error: 'missing config' }),
    };
  }

  log.info('background_run_started', {
    runId,
    universe: config.universe,
    startDate: config.startDate,
    endDate: config.endDate,
    board: config.board,
    rebalance: config.rebalanceFrequency,
  });

  // Flip 'pending' -> 'running' before the engine starts heavy work, so the
  // UI's polling hook can distinguish "queued, container cold-starting" from
  // "actively scoring tickers". The engine itself writes 'complete' /
  // 'failed' at the end via persistRunResult / persistRunFailure.
  try {
    await persistRunRunning(runId);
  } catch (e: any) {
    // Don't abort the run for a status-write hiccup — Firestore writes are
    // generally durable; the worst case is the UI sees 'pending' until
    // persistRunResult lands.
    log.warn('status_running_failed', { runId, err: String(e?.message ?? e) });
  }

  try {
    const result = await runBacktest(config, {
      resumeRunId: runId,
      onProgress: (evt) => {
        // Engine's onProgress fires per-rebalance; useful in logs but
        // intentionally not written to Firestore (would require schema
        // change). UI polls run-level status; granular progress is 4b-3.
        log.info('progress', evt);
      },
    });
    log.info('background_run_complete', {
      runId: result.runId,
      tradeCount: result.metrics.tradeCount,
      totalReturnPct: result.metrics.totalReturnPct,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, runId: result.runId }),
    };
  } catch (err: any) {
    // The engine's catch block in runBacktest already wrote persistRunFailure.
    // We log here so Sentry captures the exception via withSentry, then bow out.
    log.error('background_run_failed', { runId, err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, runId, error: String(err?.message ?? err) }),
    };
  }
});
