// Phase 4e-1 follow-up — daily backtest cron.
// Phase 4r W1 — window-selection strategy reframed: pick the next
//   UNDONE window for the active rule version, not a deterministic
//   dayOfYear%13 slot.
//
// Why the change: the previous strategy picked one of 13 windows per
// weekday by `dayOfYear % 13`. Once a window was `done`, subsequent
// firings that re-picked the same slot just overwrote it with an
// identical re-run — wasted compute, no progress toward the 8/8
// rolling-window verdict target. With 8 rolling windows in a cycle of
// 13, an empty system takes 7–12 weeks of weekday cron firings to
// reach 8/8 even on a perfectly green path. Phase 4r ships a strategy
// where every cron firing advances the verdict.
//
// Schedule: still 0 22 * * 1-5 (weekday 22:00 UTC, after US market close).
//
// Selection logic per firing:
//   1. Query portfolioBacktests for the latest doc per window.
//   2. Find windows whose latest doc is NOT a `done` row with the
//      active rule version (default 'v2', overridable via env).
//   3. Prioritize rolling-* windows (the verdict's binding rule needs
//      8/8 done), then the named comparison windows, then a slow
//      re-validate of done windows in order.
//   4. Pick the first match. Fall back to the legacy dayOfYear%13
//      pick if the Firestore query throws (defense in depth — a stuck
//      cron is worse than a wasteful one).

import type { Handler } from '@netlify/functions';
import { schedule } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { recoverStuckBacktestRuns } from './shared/backtest-resume/recover';

const COLLECTION = 'portfolioBacktests';

// The rolling windows the verdict's binding "≥5/8 beats SPY" rule reads.
const ROLLING_WINDOWS = [
  'rolling-2018',
  'rolling-2019',
  'rolling-2020',
  'rolling-2021',
  'rolling-2022',
  'rolling-2023',
  'rolling-2024',
  'rolling-2025',
];

// The named comparison windows that appear in the verdict's summary
// table (full, halves, stress windows). The full window is the
// ship-vs-no-ship anchor; the half/stress windows are the regime checks.
const NAMED_WINDOWS = ['full', 'half-2018', 'half-2022', 'covid', 'rate-hikes'];

// Priority for selection: rolling first (binding rule), then named
// comparisons. The cron picks the first window in this list whose
// latest doc is not already `done` for the active version.
const PRIORITY = [...ROLLING_WINDOWS, ...NAMED_WINDOWS];

// Legacy cycle preserved for fallback when Firestore is unreachable.
const LEGACY_CYCLE = [
  'covid',
  'rate-hikes',
  'rolling-2024',
  'rolling-2023',
  'rolling-2022',
  'rolling-2021',
  'rolling-2020',
  'rolling-2019',
  'rolling-2018',
  'rolling-2025',
  'half-2022',
  'half-2018',
  'full',
];

function pickLegacyWindow(now: Date): string {
  // Day-of-year deterministic pick — wraps around the cycle.
  const start = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diff = now.getTime() - start;
  const dayOfYear = Math.floor(diff / 86_400_000);
  return LEGACY_CYCLE[dayOfYear % LEGACY_CYCLE.length];
}

/**
 * Read each window's latest doc and return the first PRIORITY-ordered
 * window whose latest is NOT `done` at the active version.
 *
 * Exported for unit testing — accepts an injected db so the test can
 * pass a stub.
 */
export async function pickNextUndoneWindow(
  db: FirebaseFirestore.Firestore,
  activeVersion: string,
): Promise<{ window: string; reason: 'undone' | 'all-done-revalidate'; perWindow: Record<string, { runId: string; status: string; version: string | null } | null> }> {
  // Pull the most recent batch and dedupe per window (latest by startedAt).
  // 200 is generous — even with 13 windows × 5 retries the dedupe finds
  // every latest in one query.
  const snap = await db
    .collection(COLLECTION)
    .orderBy('startedAt', 'desc')
    .limit(200)
    .get();

  const latest: Record<string, { runId: string; status: string; version: string | null }> = {};
  for (const doc of snap.docs) {
    const data = doc.data() as { window?: string; status?: string; version?: string };
    if (!data.window) continue;
    if (latest[data.window]) continue; // already captured the most recent
    latest[data.window] = {
      runId: doc.id,
      status: typeof data.status === 'string' ? data.status : 'unknown',
      version: typeof data.version === 'string' ? data.version : null,
    };
  }

  const perWindow: Record<string, { runId: string; status: string; version: string | null } | null> = {};
  for (const w of PRIORITY) perWindow[w] = latest[w] ?? null;

  // First undone: latest is null, or status !== 'done', or version !== active.
  for (const w of PRIORITY) {
    const l = latest[w];
    if (!l || l.status !== 'done' || l.version !== activeVersion) {
      return { window: w, reason: 'undone', perWindow };
    }
  }

  // Everything is done at the active version. Re-validate the oldest
  // rolling window (by re-running it) so the verdict stays fresh and
  // we catch any data-provider drift over time.
  return { window: ROLLING_WINDOWS[0], reason: 'all-done-revalidate', perWindow };
}

const DEFAULT_VERSION = 'v2';

/**
 * Inner handler — exported so unit tests can call it directly without
 * Netlify's `schedule(...)` wrapping. Accepts overrides for the db,
 * version, fetch (to mock the trigger), and origin.
 */
export async function runCron(opts: {
  db?: FirebaseFirestore.Firestore;
  fetchImpl?: typeof fetch;
  origin?: string;
  activeVersion?: string;
  legacyFallback?: (now: Date) => string;
  now?: Date;
} = {}): Promise<{ statusCode: number; body: string }> {
  const log = logger.child({ fn: 'scan-portfolio-backtest-cron' });
  const now = opts.now ?? new Date();
  const activeVersion = opts.activeVersion ?? process.env.PORTFOLIO_RULE_VERSION ?? DEFAULT_VERSION;
  const origin = opts.origin ?? process.env.URL ?? 'https://tradeiq-alpha.netlify.app';
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${origin}/.netlify/functions/portfolio-backtest-trigger`;

  let chosenWindow: string;
  let strategy: 'next-undone' | 'all-done-revalidate' | 'legacy-fallback';
  let perWindow: Record<string, unknown> | undefined;
  const db = opts.db ?? getAdminDb();

  // Phase 4r-W1b W3 — sweep stuck `running` backtests BEFORE picking a
  // window to dispatch. Two reasons to do it here rather than later:
  //   1. A successful resume of a stuck run advances the cursor before
  //      the pick query reads the doc, so `pickNextUndoneWindow` sees
  //      the live state.
  //   2. A failed (cap-exhausted) run is no longer the "latest" `running`
  //      doc for its window — the pick can then choose a fresh run for
  //      that window cleanly.
  // Best-effort: a Firestore hiccup here must not block the new pick.
  try {
    const recovery = await recoverStuckBacktestRuns({
      db,
      collection: 'portfolioBacktests',
      origin,
      functionPath: '/.netlify/functions/run-portfolio-backtest-background',
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
    } else {
      log.info('stuck_run_sweep_clean', { inspected: recovery.inspected });
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('stuck_run_recovery_failed', { err: msg });
  }

  try {
    const result = await pickNextUndoneWindow(db, activeVersion);
    chosenWindow = result.window;
    strategy = result.reason === 'undone' ? 'next-undone' : 'all-done-revalidate';
    perWindow = result.perWindow as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('strategy_query_failed_using_legacy', { err: msg });
    chosenWindow = (opts.legacyFallback ?? pickLegacyWindow)(now);
    strategy = 'legacy-fallback';
  }

  log.info('cron_selected_window', { window: chosenWindow, strategy, activeVersion });

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ window: chosenWindow }),
    });
    const body = await res.text();
    log.info('cron_dispatched', {
      window: chosenWindow,
      strategy,
      status: res.status,
      body: body.slice(0, 200),
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        window: chosenWindow,
        strategy,
        activeVersion,
        triggerStatus: res.status,
        perWindow,
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('cron_failed', { window: chosenWindow, err: msg });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, window: chosenWindow, strategy, error: msg }),
    };
  }
}

export const handler: Handler = schedule('0 22 * * 1-5', async () => {
  return runCron();
});

// Exposed so unit tests can inspect cycle/priority without invoking schedule().
export const _internals = {
  WINDOW_CYCLE: LEGACY_CYCLE,
  PRIORITY,
  ROLLING_WINDOWS,
  NAMED_WINDOWS,
  pickWindow: pickLegacyWindow,
};
