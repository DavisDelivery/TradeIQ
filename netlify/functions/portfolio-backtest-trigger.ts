// Phase 4e-1 follow-up — POST /api/portfolio-backtest/start
//
// Mirrors the Phase 4b-2 trigger pattern (backtest-runs-trigger.ts):
//   1. Validate window arg
//   2. Generate runId, write portfolioBacktests/{runId} as 'pending'
//   3. Fire-and-forget POST to /.netlify/functions/run-portfolio-backtest-background
//   4. Return 202 with the runId
//
// Body: { window: 'full' | 'half-2018' | 'half-2022' | 'covid' |
//         'rate-hikes' | 'rolling-YYYY' | 'short-demo' }
//
// Result lives at portfolioBacktests/{runId} once the background
// function completes. Read via GET /api/portfolio-backtest-runs?runId=X.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { Timestamp } from 'firebase-admin/firestore';
import { logger } from './shared/logger';
import { STALE_RUN_THRESHOLD_MS } from './shared/backtest-resume/recover';

const headers = { 'Content-Type': 'application/json' };

// Wave 3B (track-3 M6) — single-flight window for *pending* docs (a
// pending doc has no cursor yet, so freshness comes from startedAt).
// Mirrors SINGLE_FLIGHT_WINDOW_MS in backtest-runs-trigger.ts: 30 min
// covers the dispatch→running transition with generous margin; a
// pending doc older than that means the dispatch never landed and the
// window is fair game for a re-fire.
const PENDING_SINGLE_FLIGHT_WINDOW_MS = 30 * 60 * 1000;

const KNOWN_WINDOWS = new Set([
  'full',
  'half-2018',
  'half-2022',
  'covid',
  'rate-hikes',
  'short-demo',
]);

function isValidWindow(w: string): boolean {
  if (KNOWN_WINDOWS.has(w)) return true;
  if (w.startsWith('rolling-')) {
    const y = Number(w.slice('rolling-'.length));
    return Number.isFinite(y) && y >= 2018 && y <= 2025;
  }
  return false;
}

function generateRunId(window: string): string {
  const now = new Date();
  const ts = now.toISOString().slice(0, 16).replace(/[-:T]/g, '');
  const rnd = Math.random().toString(36).slice(2, 8);
  return `pb-${window}-${ts}-${rnd}`;
}

function inferOrigin(event: { headers: Record<string, string | undefined> }): string {
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
  return process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
}

/** Millis from a Firestore Timestamp, an ISO string, or undefined. The
 *  doc's `updatedAt` is written as Timestamp.now() by the trigger/worker
 *  status writes but as an ISO string by writeCursor — accept both. */
function toMillis(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === 'string') return Date.parse(v);
  const ts = v as { toMillis?: () => number; _seconds?: number };
  if (typeof ts.toMillis === 'function') return ts.toMillis();
  if (typeof ts._seconds === 'number') return ts._seconds * 1000;
  return NaN;
}

/**
 * Wave 3B (track-3 M6) — single-flight guard, per window. Returns the
 * runId of a FRESH in-flight (pending/running) run for `window`, or
 * null when none exists. Freshness mirrors the conventions in
 * backtest-runs-trigger.ts (pending: startedAt within 30 min) and the
 * scan-resume/recover sweep (running: latest activity — cursor's
 * lastInvocationStartedAt / updatedAt — within STALE_RUN_THRESHOLD_MS).
 * Stale docs do NOT block: the recovery sweep in the cron resumes or
 * fails them, and a re-fire is legitimate.
 *
 * Single-field `status in [...]` query (no composite index needed);
 * window + freshness filtering happens in code. Exported for tests.
 */
export async function findInFlightPortfolioRun(
  window: string,
  now: number = Date.now(),
): Promise<string | null> {
  const db = getAdminDb();
  const snap = await db
    .collection('portfolioBacktests')
    .where('status', 'in', ['pending', 'running'])
    .limit(20)
    .get();
  for (const doc of snap.docs) {
    const data = doc.data() as {
      window?: string;
      status?: string;
      startedAt?: string;
      updatedAt?: unknown;
      cursor?: { lastInvocationStartedAt?: string } | null;
    };
    if (data.window !== window) continue;
    const lastActivityMs = Math.max(
      ...[
        toMillis(data.startedAt),
        toMillis(data.updatedAt),
        toMillis(data.cursor?.lastInvocationStartedAt),
      ].filter((m) => Number.isFinite(m)),
      0,
    );
    if (lastActivityMs <= 0) continue;
    const ageMs = now - lastActivityMs;
    const threshold =
      data.status === 'pending'
        ? PENDING_SINGLE_FLIGHT_WINDOW_MS
        : STALE_RUN_THRESHOLD_MS;
    if (ageMs < threshold) return doc.id;
  }
  return null;
}

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'portfolio-backtest-trigger' });
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'method not allowed' }),
    };
  }

  let body: { window?: string; allowParallel?: boolean };
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch (e: any) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'invalid json body' }),
    };
  }
  const window = body.window;
  if (!window || typeof window !== 'string' || !isValidWindow(window)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `invalid window. valid: full, half-2018, half-2022, covid, rate-hikes, short-demo, rolling-2018..rolling-2025`,
      }),
    };
  }

  // Wave 3B (track-3 M6) — single-flight per window, mirroring
  // backtest-runs-trigger.ts. A fresh pending/running run of the SAME
  // window blocks a duplicate launch (the cron's daily tick must not
  // stack concurrent runs of a slow multi-batch window); other windows
  // stay launchable in parallel (the rolling-window seeding pattern).
  // `allowParallel: true` / `?parallel=1` bypasses, for parity with the
  // regular trigger.
  const allowParallel =
    body.allowParallel === true || event.queryStringParameters?.parallel === '1';
  if (!allowParallel) {
    try {
      const inFlight = await findInFlightPortfolioRun(window);
      if (inFlight) {
        log.info('single_flight_blocked', { window, existingRunId: inFlight });
        return {
          statusCode: 409,
          headers,
          body: JSON.stringify({
            ok: false,
            error:
              `A portfolio backtest for window '${window}' is already in flight ` +
              `(runId: ${inFlight}). Wait for it to finish, OR re-fire with ` +
              `\`allowParallel: true\` in the body / \`?parallel=1\` in the query.`,
            runId: inFlight,
            window,
          }),
        };
      }
    } catch (e: any) {
      // Don't block on a transient single-flight read failure — log and
      // proceed. The guard is a rail, not a correctness invariant.
      log.warn('single_flight_check_failed', { window, err: String(e?.message ?? e) });
    }
  } else {
    log.info('single_flight_bypassed', { window, reason: 'allowParallel' });
  }

  const runId = generateRunId(window);
  const startedAt = new Date().toISOString();

  try {
    await getAdminDb()
      .collection('portfolioBacktests')
      .doc(runId)
      .set({
        runId,
        window,
        status: 'pending',
        startedAt,
        updatedAt: Timestamp.now(),
      });
  } catch (e: any) {
    log.error('pending_write_failed', { runId, err: String(e?.message ?? e) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        ok: false,
        error: `failed to queue run: ${String(e?.message ?? e)}`,
      }),
    };
  }

  const origin = inferOrigin(event as any);
  const backgroundUrl = `${origin}/.netlify/functions/run-portfolio-backtest-background`;

  // Phase 4e-1-finish — bg-dispatch fix. Two pre-existing runs sat
  // stuck at 'pending' forever (pb-full-202605150933-fqrsid and
  // pb-rolling-2022-202605142200-008f3z) because the trigger fired
  // an UNAWAITED fetch and returned immediately. AWS Lambda can
  // freeze the container the moment the handler's Promise resolves,
  // and any dangling Promises (the .then/.catch chain on the fetch)
  // never run — the dispatch POST never leaves.
  //
  // Netlify Background Functions return 202 from the gateway as soon
  // as the function is queued, typically in <1s. Awaiting the fetch
  // therefore blocks the trigger only until the dispatch is in flight,
  // not until the 15-min background work completes. We additionally
  // race against a 3s timeout so a slow gateway can't tie up the
  // trigger's 26s budget.
  const DISPATCH_TIMEOUT_MS = 3000;
  let dispatchOk = false;
  let dispatchStatus: number | undefined;
  try {
    const dispatch = fetch(backgroundUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ runId, window }),
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
      log.info('background_dispatched', { runId, window, backgroundUrl, status: raced.r.status });
    } else {
      // Timeout — the fetch is still in-flight; we can't await further
      // without risking the trigger timeout. Most likely Netlify has
      // already accepted the request and the timeout is just slow
      // logging. The doc will advance if the background function ran.
      log.warn('background_dispatch_timeout', { runId, window, backgroundUrl, timeoutMs: DISPATCH_TIMEOUT_MS });
    }
  } catch (e: any) {
    log.error('background_dispatch_failed', {
      runId,
      backgroundUrl,
      err: String(e?.message ?? e),
    });
  }

  log.info('trigger_response', { runId, window, dispatchOk, dispatchStatus });
  return {
    statusCode: 202,
    headers,
    body: JSON.stringify({ ok: true, runId, window, status: 'pending', dispatchOk }),
  };
};
