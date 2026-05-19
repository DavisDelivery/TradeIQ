// GET /api/backtest-status
//
// Phase 4r W1 — diagnostic surface for the portfolio-backtest run loop,
// mirroring how Phase 4o built `/api/scan-status`. Surfaces:
//
//   - per-window state: latest runId, status, version, started/completed,
//     cursor age (how long since the last batch invocation — > 15 min on
//     a `running` doc is a stalled chain)
//   - overall: how many distinct windows are `done` for the CURRENT rule
//     version, which rolling-* windows are still missing, the rolling
//     N/8 count the verdict endpoint will see
//   - stale-doc inventory: `pending`/`running` docs older than configurable
//     thresholds (defaults: 30 min for pending, 2 h for running)
//
// No mutation. Read-only diagnostic. The verdict endpoint
// (`portfolio-verdict.ts`) is what flips PENDING → SHIP/WITH-CAVEATS/
// DON'T SHIP. This endpoint exists so an operator can see WHY the
// verdict is what it is, without grepping Firestore by hand.
//
// Query params:
//   - `window=<name>`: filter to one window (e.g. ?window=rolling-2022)
//   - `version=<v>`: rule version to count toward "done" (default: v2)
//   - `staleMs=<ms>`: stale threshold for pending docs (default 30 min)
//   - `runningStaleMs=<ms>`: stale threshold for running docs (default 2 h)

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const COLLECTION = 'portfolioBacktests';
const DEFAULT_STALE_PENDING_MS = 30 * 60_000;
const DEFAULT_STALE_RUNNING_MS = 2 * 60 * 60_000;
const DEFAULT_VERSION = 'v2';

// The window set the cron + verdict endpoint know about. Kept in sync
// with the WINDOW_CYCLE in `scan-portfolio-backtest-cron.ts` and the
// NAMED_WINDOWS + ROLLING_WINDOWS lists in `portfolio-verdict.ts`.
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
const NAMED_WINDOWS = ['full', 'half-2018', 'half-2022', 'covid', 'rate-hikes'];
const KNOWN_WINDOWS = new Set([...ROLLING_WINDOWS, ...NAMED_WINDOWS, 'short-demo']);

interface RunSummary {
  runId: string;
  window: string;
  status: string;
  version: string | null;
  startedAt: string | null;
  completedAt: string | null;
  excessReturnPct: number | null;
  ageMs: number | null;
  /** For `running` docs: ms since the most recent cursor write. > 15min
   *  = the chain stalled without writing the terminal done status. */
  invocationAgeMs: number | null;
  /** Phase 4r-W1b — running counter of self-reinvoke dispatch attempts
   *  the worker has made on this run. Compare against `invocationCount`
   *  in logs / cursor to localise stalls to the reinvoke layer. */
  reinvokeAttempts: number | null;
  /** Phase 4r-W1b — HTTP status of the last reinvoke's final attempt.
   *  202 = healthy. 429/5xx = throttled. Combine with `reinvokeAttempts`
   *  to see whether retries got it through. */
  lastReinvokeStatus: number | null;
  /** Phase 4r-W1b — error from the most recent reinvoke, when the chain
   *  exhausted its retries. Pre-W1b this was almost never written; post
   *  W1b it captures gateway throttling + transient network failures. */
  lastReinvokeError: string | null;
  /** Phase 4r-W1b W3 — number of stuck-run recovery attempts the
   *  sweep has issued for this run. Reaching MAX_RECOVERY_ATTEMPTS
   *  triggers a clean `failed` flip on the next sweep. */
  recoveryAttempts: number | null;
}

interface WindowState {
  window: string;
  latest: RunSummary | null;
  /** Is the latest run "done" AND `version` matches the active rule? */
  doneForActiveVersion: boolean;
  /** All recent runs for this window (capped at 5). */
  recent: RunSummary[];
}

function toIsoOrNull(v: unknown): string | null {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object' && '_seconds' in (v as object)) {
    const s = (v as { _seconds: number })._seconds;
    if (Number.isFinite(s)) return new Date(s * 1000).toISOString();
  }
  return null;
}

function summarize(doc: FirebaseFirestore.DocumentSnapshot, now: number): RunSummary {
  const d = doc.data() as Record<string, unknown> | undefined;
  const data = d ?? {};
  const startedAt = toIsoOrNull(data.startedAt);
  const completedAt = toIsoOrNull(data.completedAt);
  const cursorRaw = data.cursor as
    | {
        lastInvocationStartedAt?: string;
        reinvokeAttempts?: number;
        lastReinvokeStatus?: number;
        lastReinvokeError?: string;
        recoveryAttempts?: number;
      }
    | null
    | undefined;
  const lastInvAt = cursorRaw?.lastInvocationStartedAt
    ? Date.parse(cursorRaw.lastInvocationStartedAt)
    : NaN;
  const startedMs = startedAt ? Date.parse(startedAt) : NaN;
  return {
    runId: doc.id,
    window: typeof data.window === 'string' ? data.window : '?',
    status: typeof data.status === 'string' ? data.status : 'unknown',
    version: typeof data.version === 'string' ? data.version : null,
    startedAt,
    completedAt,
    excessReturnPct:
      typeof data.excessReturnPct === 'number' ? data.excessReturnPct : null,
    ageMs: Number.isFinite(startedMs) ? now - startedMs : null,
    invocationAgeMs: Number.isFinite(lastInvAt) ? now - lastInvAt : null,
    reinvokeAttempts:
      typeof cursorRaw?.reinvokeAttempts === 'number' ? cursorRaw.reinvokeAttempts : null,
    lastReinvokeStatus:
      typeof cursorRaw?.lastReinvokeStatus === 'number'
        ? cursorRaw.lastReinvokeStatus
        : null,
    lastReinvokeError:
      typeof cursorRaw?.lastReinvokeError === 'string'
        ? cursorRaw.lastReinvokeError
        : null,
    recoveryAttempts:
      typeof cursorRaw?.recoveryAttempts === 'number'
        ? cursorRaw.recoveryAttempts
        : null,
  };
}

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'backtest-status' });
  const qs = event.queryStringParameters ?? {};
  const filterWindow = qs.window;
  const activeVersion = qs.version || DEFAULT_VERSION;
  const stalePendingMs = Number(qs.staleMs) || DEFAULT_STALE_PENDING_MS;
  const staleRunningMs = Number(qs.runningStaleMs) || DEFAULT_STALE_RUNNING_MS;

  try {
    const db = getAdminDb();
    const snap = await db
      .collection(COLLECTION)
      .orderBy('startedAt', 'desc')
      .limit(200)
      .get();

    const now = Date.now();
    const allRuns = snap.docs.map((d) => summarize(d, now));

    // Group by window, take up to 5 most recent each.
    const byWindow = new Map<string, RunSummary[]>();
    for (const r of allRuns) {
      if (filterWindow && r.window !== filterWindow) continue;
      const arr = byWindow.get(r.window);
      if (arr) {
        if (arr.length < 5) arr.push(r);
      } else {
        byWindow.set(r.window, [r]);
      }
    }

    // Build a state row for every window the system knows about, even
    // those with no docs — that's the most useful diagnosis.
    const targetWindows = filterWindow
      ? [filterWindow]
      : [...NAMED_WINDOWS, ...ROLLING_WINDOWS];
    const windows: WindowState[] = targetWindows.map((w) => {
      const recent = byWindow.get(w) ?? [];
      const latest = recent[0] ?? null;
      const doneForActiveVersion = !!(
        latest &&
        latest.status === 'done' &&
        latest.version === activeVersion
      );
      return { window: w, latest, doneForActiveVersion, recent };
    });

    // Rolling N/M-done count (toward the verdict's ≥5/8 rule).
    const rollingDone = windows.filter(
      (w) => ROLLING_WINDOWS.includes(w.window) && w.doneForActiveVersion,
    ).length;
    const rollingMissing = windows
      .filter((w) => ROLLING_WINDOWS.includes(w.window) && !w.doneForActiveVersion)
      .map((w) => w.window);

    // Stale-doc inventory across the whole collection (independent of
    // filter so the operator sees the global picture).
    const stalePending: RunSummary[] = [];
    const staleRunning: RunSummary[] = [];
    for (const r of allRuns) {
      if (r.status === 'pending' && r.ageMs !== null && r.ageMs > stalePendingMs) {
        stalePending.push(r);
      }
      if (r.status === 'running' && r.invocationAgeMs !== null && r.invocationAgeMs > staleRunningMs) {
        staleRunning.push(r);
      }
    }

    // Full-window check — separate because it doesn't count toward rolling.
    const fullState = windows.find((w) => w.window === 'full') ?? null;

    log.info('status_served', {
      activeVersion,
      rollingDone,
      rollingTotal: ROLLING_WINDOWS.length,
      stalePending: stalePending.length,
      staleRunning: staleRunning.length,
    });

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        ok: true,
        now: new Date(now).toISOString(),
        activeVersion,
        full: {
          present: !!fullState?.doneForActiveVersion,
          latest: fullState?.latest ?? null,
        },
        rolling: {
          done: rollingDone,
          total: ROLLING_WINDOWS.length,
          missing: rollingMissing,
          windowsToFire: rollingMissing, // alias for clarity in scripts
        },
        windows,
        stale: {
          pending: stalePending,
          running: staleRunning,
          thresholdsMs: { pending: stalePendingMs, running: staleRunningMs },
        },
        knownWindows: [...KNOWN_WINDOWS],
      }),
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('status_failed', { err: msg });
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ ok: false, error: msg }),
    };
  }
};
