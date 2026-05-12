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
//      then fires-and-forgets a POST to /.netlify/functions/run-backtest-background
//      with { runId, config }. Returns 202 with the runId in <1s.
//
// Why fire-and-forget instead of awaiting: Netlify functions can invoke
// other functions over HTTP; the gateway returns 202 to a `-background.ts`
// function immediately. The trigger doesn't need the result — the engine
// writes everything to Firestore.
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
  let config: BacktestConfig;
  try {
    config = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    log.warn('config_parse_failed', { err: String(e?.message ?? e) });
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'invalid config json' }),
    };
  }

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

  // --- Prophet-only enforcement
  // Other boards' PIT scoring landed partially in Phase 4a. Accepting
  // them silently would produce systematically biased backtests.
  // BACKTEST_LIMITATIONS.md is the long-form source.
  if (config.board !== 'prophet') {
    log.warn('board_not_supported', { board: config.board });
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error:
          `Only the prophet board is supported for backtests right now. ` +
          `Other boards' point-in-time scoring is incomplete — see BACKTEST_LIMITATIONS.md.`,
      }),
    };
  }

  // --- Single-flight
  try {
    const inFlight = await findInFlightRun();
    if (inFlight) {
      log.info('single_flight_blocked', { existingRunId: inFlight });
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          ok: false,
          error: `A backtest is already running (runId: ${inFlight}). ` +
            `Wait for it to finish or check Sentry if it appears stuck.`,
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

  // --- Allocate runId, write 'pending', fire-and-forget background
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

  const origin = inferOrigin(event as any);
  const backgroundUrl = `${origin}/.netlify/functions/run-backtest-background`;

  // Fire-and-forget. We deliberately do NOT await this. Netlify's
  // gateway returns 202 to the background function immediately, and
  // the function keeps running for up to 15 minutes; awaiting would
  // tie up this trigger function while the engine works.
  //
  // We log the fact that the dispatch happened, but errors here are
  // swallowed — the user already has the runId; a transient dispatch
  // failure means the row will sit in 'pending' until the next launcher
  // call times it out via single-flight or the user manually checks.
  fetch(backgroundUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, config }),
  })
    .then(() => {
      log.info('background_dispatched', { runId, backgroundUrl });
    })
    .catch((e) => {
      log.error('background_dispatch_failed', {
        runId,
        backgroundUrl,
        err: String(e?.message ?? e),
      });
    });

  log.info('trigger_response', {
    runId,
    durationMs: Date.now() - start,
    universe: config.universe,
    board: config.board,
  });

  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ ok: true, runId }),
  };
};
