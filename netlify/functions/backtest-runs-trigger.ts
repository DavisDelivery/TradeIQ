// Phase 4b-2 — POST /api/backtest-runs/start trigger endpoint.
//
// Synchronous handler that:
//   1. Validates the BacktestConfig (reuses runBacktest's own
//      validateConfig so we can't drift).
//   2. Enforces prophet-only board (other boards' PIT scoring landed
//      partially in Phase 4a — accepting them silently would produce
//      garbage results; see BACKTEST_LIMITATIONS.md).
//   3. Single-flights against concurrent launches: if a pending/running
//      run exists started within the last 30 min, return 409 with the
//      existing runId. (Chad is the only user; this guards against an
//      accidental double-click, not real concurrency.)
//   4. Path-A runId allocation: trigger generates the runId, writes
//      backtestRuns/{runId} with status: 'pending' via persistRunPending,
//      then POSTs to /.netlify/functions/run-backtest-background with
//      { runId, config }, awaiting the dispatch (with a 3s timeout race)
//      so the container can't freeze before the POST leaves. Returns
//      202 with the runId in <1s on the happy path, <3s in degraded.
//
// Why we await the dispatch instead of fire-and-forget: AWS Lambda can
// freeze the container the moment the handler's Promise resolves; any
// dangling Promises (a `fetch(...).then(...)` chain with no await)
// never run, and the POST never leaves. This was the bug behind
// bt_20260515115436_ixxt1o sitting at 'pending' for hours. The 3s
// timeout race caps tail latency so a slow gateway can't blow the
// trigger's 26s budget. Mirror of the PR #30 fix on the portfolio
// trigger.
//
// Trigger lives at a DISTINCT path (/api/backtest-runs/start) from the
// list (/api/backtest-runs). Method-conditioned Netlify redirects are
// silently ignored, so separating paths is the only reliable routing.
// See netlify.toml for the redirect ordering.

import type { Handler } from '@netlify/functions';
import {
  generateRunId,
  persistRunPending,
} from './shared/backtest/persistence';
import { validateConfig } from './shared/backtest/engine';
import type { BacktestConfig } from './shared/backtest/types';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { recoverStuckBacktestRuns } from './shared/backtest-resume/recover';

const headers = { 'Content-Type': 'application/json' };

// Single-flight window: any pending/running run started within this
// many milliseconds blocks a new launch. 30 minutes covers a normal
// completed Dow run (~5 min) plus generous margin; chosen so that a
// genuinely-stuck run (which would land in status='failed' after the
// 15-min background cap regardless) stops blocking after the cap +
// some slack.
const SINGLE_FLIGHT_WINDOW_MS = 30 * 60 * 1000;

function inferOrigin(event: { headers: Record<string, string | undefined> }): string {
  // Prefer the request's own host so deploy previews invoke their own
  // background function, not production's. Netlify forwards both
  // `host` and `x-forwarded-host`; the latter is what end-clients see.
  const host =
    event.headers['x-forwarded-host'] ??
    event.headers['X-Forwarded-Host'] ??
    event.headers.host ??
    event.headers.Host;
  const proto =
    event.headers['x-forwarded-proto'] ??
    event.headers['X-Forwarded-Proto'] ??
    'https';
  if (host) return `${proto}://${host}`;
  // Fallback for unit tests / unusual proxy setups: use the production URL
  // env var Netlify always sets, then a hard fallback. Background invokes
  // would 404 in this fallback case but the trigger still completes.
  return process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
}

/**
 * Look for any pending/running run in `backtestRuns` started within the
 * single-flight window. Returns the existing runId if one is found, null
 * otherwise. Uses a single-field `in` query which Firestore satisfies
 * without a composite index; the time-window filter is applied in code.
 *
 * Exported as a thin wrapper so the test suite can stub the DB lookup.
 */
export async function findInFlightRun(): Promise<string | null> {
  const db = getAdminDb();
  const cutoffMs = Date.now() - SINGLE_FLIGHT_WINDOW_MS;
  const snap = await db
    .collection('backtestRuns')
    .where('status', 'in', ['pending', 'running'])
    .limit(20)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data();
    const startedAtMs = Date.parse(data?.startedAt ?? '');
    if (Number.isFinite(startedAtMs) && startedAtMs >= cutoffMs) {
      return doc.id;
    }
  }
  return null;
}

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'backtest-runs-trigger' });
  const start = Date.now();

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ ok: false, error: 'method not allowed' }) };
  }

  // --- Parse body
  // Body accepts the BacktestConfig plus an optional `allowParallel: true`
  // sidecar that bypasses single-flight. The sidecar is stripped before
  // validation/persistence so it doesn't leak into Firestore.
  let rawBody: any;
  try {
    rawBody = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.warn('config_parse_failed', { err: String(e?.message ?? e) });
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'invalid config json' }),
    };
  }
  const allowParallel =
    rawBody?.allowParallel === true ||
    event.queryStringParameters?.parallel === '1';
  const config: BacktestConfig = { ...rawBody };
  delete (config as any).allowParallel;

  // --- Validate shape (reuse engine's own validator)
  try {
    validateConfig(config);
  } catch (e: any) {
    log.warn('config_invalid', { err: String(e?.message ?? e) });
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: String(e?.message ?? e) }),
    };
  }

  // --- Supported-board enforcement
  // Phase 4a originally accepted only `prophet`. Phase 4m+4n (PR #41)
  // added PIT-correct williams + lynch scorers. Phase 4t W1 (this PR)
  // adds the ten-analyst composite (`target`) — see
  // `reports/phase-4t/pit-audit.md` for the per-factor PIT integrity
  // classification. catalyst + insider boards remain stubs; their
  // score-at-date paths return null and the trigger rejects them so a
  // silently-biased run can't be fired.
  const SUPPORTED_BOARDS: ReadonlyArray<string> = [
    'prophet',
    'williams',
    'lynch',
    'target',
  ];
  if (!SUPPORTED_BOARDS.includes(config.board)) {
    log.warn('board_not_supported', { board: config.board });
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error:
          `Board '${config.board}' is not supported for backtests. ` +
          `Supported: ${SUPPORTED_BOARDS.join(', ')}. ` +
          `catalyst / insider / target boards' point-in-time scoring is incomplete — see docs/BACKTEST_LIMITATIONS.md.`,
      }),
    };
  }

  // --- Phase 4v — sweep stuck non-portfolio runs before deciding what
  // to do with this trigger. The portfolio side already does this in
  // `scan-portfolio-backtest-cron.ts:169`; the non-portfolio side had
  // no recovery loop, so two stuck Phase 4t composite runs sat at
  // `status: running` for 4+ hours after the W1b reinvoke chain
  // dropped (see reports/phase-4v-backtest-concurrency/diagnosis.md).
  //
  // Best-effort: a Firestore hiccup must not block the new trigger.
  // Two reasons to run it here, not later:
  //   1. A resumed stuck run advances its cursor before the single-
  //      flight scan reads the doc, so single-flight sees fresh state.
  //   2. A failed (cap-exhausted) run is no longer `running`, so it
  //      stops blocking new triggers on the 30-min single-flight
  //      window.
  const recoveryOrigin = inferOrigin(event as any);
  try {
    const recovery = await recoverStuckBacktestRuns({
      db: getAdminDb(),
      collection: 'backtestRuns',
      origin: recoveryOrigin,
      functionPath: '/.netlify/functions/run-backtest-background',
    });
    if (
      recovery.resumed.length > 0 ||
      recovery.failed.length > 0 ||
      recovery.skipped.length > 0
    ) {
      log.warn('stuck_runs_swept', {
        inspected: recovery.inspected,
        resumed: recovery.resumed.map((r) => r.runId),
        failed: recovery.failed.map((r) => r.runId),
        skipped: recovery.skipped.map((r) => r.runId),
      });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('stuck_run_recovery_failed', { err: msg });
  }

  // --- Single-flight (skipped when caller opts into parallel).
  // The default guards against accidental double-clicks. Phase 5a's
  // seed-run batch (5 configs, briefs/phase-5a-seed-runs.md) needs
  // parallel launches to clear its data gate inside one wall-clock
  // window; that batch passes `allowParallel: true`.
  if (!allowParallel) {
    try {
      const inFlight = await findInFlightRun();
      if (inFlight) {
        log.info('single_flight_blocked', { existingRunId: inFlight });
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            ok: false,
            error:
              `A backtest is already running (runId: ${inFlight}). ` +
              `Wait for it to finish, OR re-fire with \`allowParallel: true\` ` +
              `in the body / \`?parallel=1\` in the query if you really want concurrent runs.`,
            runId: inFlight,
          }),
        };
      }
    } catch (e: any) {
      // Don't block on a transient single-flight read failure — log it,
      // proceed. The 30-min window is a guard rail, not a correctness
      // invariant; the engine itself doesn't care if two runs overlap.
      log.warn('single_flight_check_failed', { err: String(e?.message ?? e) });
    }
  } else {
    log.info('single_flight_bypassed', { reason: 'allowParallel' });
  }

  // --- Allocate runId, write 'pending', dispatch background (awaited)
  const runId = generateRunId();
  try {
    await persistRunPending(runId, config);
  } catch (e: any) {
    log.error('pending_write_failed', { runId, err: String(e?.message ?? e) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: `failed to queue run: ${String(e?.message ?? e)}` }),
    };
  }

  const backgroundUrl = `${recoveryOrigin}/.netlify/functions/run-backtest-background`;

  // bg-dispatch fix — mirror of PR #30 (portfolio-backtest-trigger).
  // Live-confirmed stuck run: bt_20260515115436_ixxt1o sat at
  // 'pending' for ~3h with runningAt never set. The previous comment
  // here claimed fire-and-forget was safe because Netlify's gateway
  // returns 202 immediately — but that's only true if the POST
  // actually leaves the trigger container, and AWS Lambda can freeze
  // the container the moment the handler's Promise resolves. Any
  // dangling Promises (the .then/.catch chain on the unawaited fetch)
  // never run, and the dispatch POST never leaves. Same root cause as
  // the portfolio-trigger bug; the orchestrator's earlier assumption
  // that this path was the "known-working comparator" was wrong.
  //
  // Fix: await the dispatch fetch with a 3-second timeout race.
  // Netlify Background Functions return 202 from the gateway as soon
  // as the function is queued, typically in <1s. Awaiting blocks the
  // trigger only until the dispatch is in flight, not until the 15-min
  // background work completes. The 3s race caps tail latency so a
  // slow gateway can't tie up the trigger's 26s budget.
  const DISPATCH_TIMEOUT_MS = 3000;
  let dispatchOk = false;
  let dispatchStatus: number | undefined;
  try {
    const dispatch = fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, config }),
    });
    const raced = await Promise.race([
      dispatch.then((r) => ({ r })),
      new Promise<{ timeout: true }>((resolve) =>
        setTimeout(() => resolve({ timeout: true }), DISPATCH_TIMEOUT_MS),
      ),
    ]);
    if ('r' in raced) {
      dispatchOk = true;
      dispatchStatus = raced.r.status;
      log.info('background_dispatched', { runId, backgroundUrl, status: raced.r.status });
    } else {
      // Timeout — the fetch is still in-flight; we can't await further
      // without risking the trigger timeout. Most likely Netlify has
      // already accepted the request and the timeout is just slow
      // logging. The doc will advance if the background function ran.
      log.warn('background_dispatch_timeout', { runId, backgroundUrl, timeoutMs: DISPATCH_TIMEOUT_MS });
    }
  } catch (e: any) {
    log.error('background_dispatch_failed', {
      runId,
      backgroundUrl,
      err: String(e?.message ?? e),
    });
  }

  log.info('trigger_response', {
    runId,
    durationMs: Date.now() - start,
    universe: config.universe,
    board: config.board,
    dispatchOk,
    dispatchStatus,
  });

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ ok: true, runId, allowParallel, dispatchOk }),
  };
};
