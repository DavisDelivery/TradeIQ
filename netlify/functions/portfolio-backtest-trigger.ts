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

const headers = { 'Content-Type': 'application/json' };

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

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'portfolio-backtest-trigger' });
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'method not allowed' }),
    };
  }

  let body: { window?: string };
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
