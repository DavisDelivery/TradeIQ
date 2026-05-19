// Phase 4r-W1b W3 — stuck-run recovery for portfolio backtests.
//
// Defence in depth for the reinvoke chain. W2 hardens dispatchReinvoke
// (retries on 429/5xx, jitter, real-outcome reporting) — but a run can
// still stall if every retry fails or the resumed invocation itself
// dies before re-dispatching. Without recovery a stuck `status: running`
// doc sits forever, blocking that window in the verdict.
//
// The pattern mirrors `shared/scan-resume/finalize.ts:recoverStuckRuns`
// (Phase 4p W3), with two differences appropriate to backtests:
//
//   1. Backtests keep ALL resume state on the cursor — `nextRebalanceIndex`
//      + `state` (positions, cash, equity curve). So unlike the scan side,
//      where Phase 4p chooses to mark stuck runs as `error` and let a
//      fresh scan cover the same data, here we can RESUME the stuck run
//      cheaply by re-dispatching its reinvoke. The cursor advances; the
//      verdict gets a real `done` row, not a wasted re-run from zero.
//
//   2. We cap how many recovery attempts a run can absorb. If recovery
//      has already been tried `MAX_RECOVERY_ATTEMPTS` times and the run
//      is still stuck, the next sweep fails it cleanly (status='failed')
//      so the cron's next-undone-window strategy can fire a fresh run
//      for that window without the stuck doc looking like the latest.
//
// The recovery sweep is meant to be called by the cron BEFORE it picks
// a window to dispatch — so the cron's "latest doc" reading already
// reflects the recovery's effect (recovered runs may have advanced into
// `done` by the next cron tick, failed runs are not the latest for that
// window's "active version" check).

import type { Firestore } from 'firebase-admin/firestore';
import { Timestamp } from 'firebase-admin/firestore';
import {
  readCursor,
  writeCursor,
  type BacktestCursor,
} from './cursor';
import { dispatchReinvoke, type ReinvokeContext } from './reinvoke';

/**
 * A `status: 'running'` backtest doc whose cursor's
 * `lastInvocationStartedAt` is older than this is presumed stuck — the
 * Netlify Background Function ceiling is 15 min, so 30 min idle means
 * even the W2 retry chain has long since had time to land or fail.
 * Override via env for tests.
 */
export const STALE_RUN_THRESHOLD_MS = Number(
  process.env.BACKTEST_STALE_RUN_THRESHOLD_MS ?? 30 * 60_000,
);

/**
 * Cap on per-run recovery attempts. After this many resume-dispatches
 * with no progress, we stop trying and mark the run `failed` so the
 * cron's next-undone-window strategy fires a fresh run for that window.
 * Three attempts at ~30 min apart = ~1.5 h grace before we give up.
 */
export const MAX_RECOVERY_ATTEMPTS = Number(
  process.env.BACKTEST_MAX_RECOVERY_ATTEMPTS ?? 3,
);

type RecoveryAction = 'resumed' | 'failed' | 'skipped';

export interface StuckRunRecord {
  runId: string;
  window: string;
  status: string;
  action: RecoveryAction;
  ageMs: number;
  invocationCount: number;
  recoveryAttempts: number;
  reason: string;
  dispatchOk?: boolean;
  dispatchError?: string;
  lastReinvokeStatus?: number;
}

export interface RecoverStuckBacktestRunsArgs {
  db: Firestore;
  /** Collection name — `portfolioBacktests` in prod. Parameterised for
   *  symmetry with the rest of the backtest-resume module and so the
   *  regular-engine collection (`backtestRuns`) can reuse it later. */
  collection: string;
  /** Origin used to derive the reinvoke URL when re-dispatching a
   *  resumable run. e.g. `process.env.URL ?? 'https://tradeiq-alpha.netlify.app'`. */
  origin: string;
  /** Function path to POST to for the resume. e.g.
   *  `/.netlify/functions/run-portfolio-backtest-background`. */
  functionPath: string;
  /** Override threshold (ms). Default `STALE_RUN_THRESHOLD_MS`. */
  staleThresholdMs?: number;
  /** Override recovery cap. Default `MAX_RECOVERY_ATTEMPTS`. */
  maxRecoveryAttempts?: number;
  /** Fixed `now` for deterministic tests. */
  now?: number;
  /** Cap the docs scanned (defaults to 50; we only ever expect a handful). */
  scanLimit?: number;
  /** Injected dispatch — tests pass a stub; prod gets the real one. */
  dispatch?: (
    url: string,
    runId: string,
    ctx: ReinvokeContext,
    extra: Record<string, unknown>,
  ) => Promise<{ ok: boolean; attempts: number; lastStatus?: number; error?: string }>;
}

export interface RecoverStuckBacktestRunsResult {
  inspected: number;
  resumed: StuckRunRecord[];
  failed: StuckRunRecord[];
  skipped: StuckRunRecord[];
}

/**
 * Sweep the backtest collection for stuck `running` docs and either
 * resume them (re-dispatch from the checkpointed cursor) or fail them
 * (if the recovery cap is exhausted).
 *
 * Best-effort: a Firestore hiccup must not bring down the cron path
 * that calls it. Callers should `try/catch` the whole call and log
 * failures rather than aborting the surrounding work.
 */
export async function recoverStuckBacktestRuns(
  args: RecoverStuckBacktestRunsArgs,
): Promise<RecoverStuckBacktestRunsResult> {
  const {
    db,
    collection,
    origin,
    functionPath,
    staleThresholdMs = STALE_RUN_THRESHOLD_MS,
    maxRecoveryAttempts = MAX_RECOVERY_ATTEMPTS,
    now = Date.now(),
    scanLimit = 50,
    dispatch = dispatchReinvoke,
  } = args;

  // Recent-first to cap the scan budget — anything older than the
  // retention window is irrelevant.
  const snap = await db
    .collection(collection)
    .orderBy('startedAt', 'desc')
    .limit(scanLimit)
    .get();

  const resumed: StuckRunRecord[] = [];
  const failed: StuckRunRecord[] = [];
  const skipped: StuckRunRecord[] = [];

  for (const doc of snap.docs) {
    const data = doc.data() as {
      window?: string;
      status?: string;
      cursor?: BacktestCursor<unknown> | null;
    };
    if (data.status !== 'running') continue;
    const cursor = data.cursor ?? null;
    if (!cursor) continue;
    const lastInvAt = cursor.lastInvocationStartedAt
      ? Date.parse(cursor.lastInvocationStartedAt)
      : NaN;
    if (!Number.isFinite(lastInvAt)) continue;
    const ageMs = now - lastInvAt;
    if (ageMs < staleThresholdMs) continue;

    const recoveryAttempts = cursor.recoveryAttempts ?? 0;
    const window = typeof data.window === 'string' ? data.window : '?';
    const runId = doc.id;

    if (recoveryAttempts >= maxRecoveryAttempts) {
      // Recovery cap exhausted — fail cleanly. The cron's next-undone
      // pick treats this as "not done for active version" and fires a
      // fresh run for the same window.
      await db
        .collection(collection)
        .doc(runId)
        .set(
          {
            status: 'failed',
            cursor: null,
            error: `stuck-run recovery cap exhausted (${recoveryAttempts}/${maxRecoveryAttempts}); last idle ${Math.round(ageMs / 60_000)} min`,
            failedAt: new Date().toISOString(),
            updatedAt: Timestamp.now(),
          },
          { merge: true },
        );
      failed.push({
        runId,
        window,
        status: 'failed',
        action: 'failed',
        ageMs,
        invocationCount: cursor.invocationCount ?? 0,
        recoveryAttempts,
        reason: `recovery cap ${maxRecoveryAttempts} exhausted`,
      });
      continue;
    }

    // Attempt resume: bump the recovery counter on the cursor and
    // re-dispatch the reinvoke. The cursor's nextRebalanceIndex + state
    // are the resume point — the worker reads them on entry like any
    // normal reinvoke.
    const refreshedCursor: BacktestCursor<unknown> = {
      ...cursor,
      lastInvocationStartedAt: new Date().toISOString(),
      recoveryAttempts: recoveryAttempts + 1,
    };
    await writeCursor(db, collection, runId, refreshedCursor);

    const url = `${origin}${functionPath}`;
    const dispatched = await dispatch(url, runId, {}, { window });
    if (dispatched.ok) {
      resumed.push({
        runId,
        window,
        status: 'running',
        action: 'resumed',
        ageMs,
        invocationCount: cursor.invocationCount ?? 0,
        recoveryAttempts: recoveryAttempts + 1,
        reason: `idle ${Math.round(ageMs / 60_000)} min, dispatch ok`,
        dispatchOk: true,
        lastReinvokeStatus: dispatched.lastStatus,
      });
    } else {
      // Stamp the dispatch error onto the cursor for diagnostics but
      // keep status=running and counter incremented — the next sweep
      // can retry until the cap, then fail.
      await writeCursor(db, collection, runId, {
        ...refreshedCursor,
        lastReinvokeError: dispatched.error ?? 'unknown dispatch failure',
        lastReinvokeStatus: dispatched.lastStatus,
      });
      skipped.push({
        runId,
        window,
        status: 'running',
        action: 'skipped',
        ageMs,
        invocationCount: cursor.invocationCount ?? 0,
        recoveryAttempts: recoveryAttempts + 1,
        reason: `dispatch failed (${dispatched.error ?? 'unknown'}); will retry next sweep`,
        dispatchOk: false,
        dispatchError: dispatched.error,
        lastReinvokeStatus: dispatched.lastStatus,
      });
    }
  }

  return {
    inspected: snap.docs.length,
    resumed,
    failed,
    skipped,
  };
}

// Test-only export so a test can drive a fixed `now` + injected dispatch
// stub. Production callers use `recoverStuckBacktestRuns` directly.
export const _internals = {
  readCursor,
};
