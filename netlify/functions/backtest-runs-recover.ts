// POST /api/backtest-runs/recover
//
// FIX-1 W1 — maintenance sweep for zombie regular-engine backtest runs
// (`backtestRuns` collection). Production carried two runs frozen at
// `status: 'running'` for weeks (bt_20260608171209_e719xu since Jun 8,
// bt_20260519233555_2kv7mt since May 19): their background chains died
// without a terminal write, and unlike the portfolio-backtest cron
// (which calls `recoverStuckBacktestRuns` before every dispatch),
// NOTHING sweeps `backtestRuns`. A permanently-"running" doc pollutes
// the run list and blocks single-flight launch checks.
//
// Semantics: any `running` / `pending` run whose most recent sign of
// life (cursor.lastInvocationStartedAt, else updatedAt, else startedAt)
// is older than the threshold is marked `failed` with an explanatory
// error. We deliberately mark-failed rather than resume: these runs
// predate current MODEL_VERSION/engine fixes, and a fresh run is the
// honest re-measurement (same reasoning as scan-side Phase 4p W3).
//
// Executable post-deploy without DB access:
//   curl -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/recover
// Optional body: { "staleMinutes": 60, "dryRun": true, "runIds": ["bt_..."] }
//   - runIds: restrict the sweep to specific runs (still requires them
//     to be running/pending — completed runs are never touched).
//   - dryRun: report what WOULD be failed without writing.
//
// No auth, mirroring the trigger endpoint's owner decision (personal
// deployment; the endpoint can only fail already-dead runs, never
// delete data or touch completed results).

import type { Handler } from '@netlify/functions';
import { createLogger } from './shared/logger';
import { getAdminDb } from './shared/firebase-admin';

const log = createLogger('backtest-runs-recover');
const headers = { 'Content-Type': 'application/json' };

/** A running/pending run idle longer than this is presumed dead. The
 *  batched engine reinvokes every ≤15 min, so 60 min of silence means
 *  the chain is gone. */
export const DEFAULT_STALE_MINUTES = 60;
const SCAN_LIMIT = 100;

interface SweptRun {
  runId: string;
  status: string;
  lastSeenAt: string | null;
  idleMinutes: number | null;
  action: 'failed' | 'would-fail' | 'skipped';
  reason: string;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ ok: false, error: 'POST only' }),
    };
  }

  let body: { staleMinutes?: number; dryRun?: boolean; runIds?: string[] } = {};
  try {
    body = event.body ? JSON.parse(event.body) : {};
  } catch {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ ok: false, error: 'invalid JSON body' }),
    };
  }

  const staleMinutes =
    Number.isFinite(body.staleMinutes) && (body.staleMinutes as number) > 0
      ? (body.staleMinutes as number)
      : DEFAULT_STALE_MINUTES;
  const dryRun = body.dryRun === true;
  const onlyRunIds =
    Array.isArray(body.runIds) && body.runIds.length > 0
      ? new Set(body.runIds.map(String))
      : null;

  const db = getAdminDb();
  const now = Date.now();
  const swept: SweptRun[] = [];

  try {
    let docs;
    if (onlyRunIds) {
      const reads = await Promise.all(
        [...onlyRunIds].map((id) => db.collection('backtestRuns').doc(id).get()),
      );
      docs = reads.filter((d) => d.exists);
    } else {
      const snap = await db
        .collection('backtestRuns')
        .orderBy('startedAt', 'desc')
        .limit(SCAN_LIMIT)
        .get();
      docs = snap.docs;
    }

    for (const doc of docs) {
      const data = doc.data() as any;
      const status: string = data?.status ?? 'unknown';
      if (status !== 'running' && status !== 'pending') {
        if (onlyRunIds) {
          swept.push({
            runId: doc.id,
            status,
            lastSeenAt: null,
            idleMinutes: null,
            action: 'skipped',
            reason: `status '${status}' is terminal; not touched`,
          });
        }
        continue;
      }

      const lastSeenAt: string | null =
        data?.cursor?.lastInvocationStartedAt ??
        data?.updatedAt ??
        data?.startedAt ??
        null;
      const t = lastSeenAt ? Date.parse(lastSeenAt) : NaN;
      const idleMinutes = Number.isFinite(t) ? Math.round((now - t) / 60_000) : null;

      // No parseable timestamp at all → dead by definition (nothing can
      // ever prove it alive); treat as maximally stale.
      const isStale = idleMinutes === null || idleMinutes >= staleMinutes;
      if (!isStale) {
        swept.push({
          runId: doc.id,
          status,
          lastSeenAt,
          idleMinutes,
          action: 'skipped',
          reason: `idle ${idleMinutes} min < threshold ${staleMinutes} min`,
        });
        continue;
      }

      const reason =
        `zombie recovery (FIX-1): status '${status}' with no sign of life for ` +
        `${idleMinutes === null ? 'an unknown period' : `${idleMinutes} min`} ` +
        `(threshold ${staleMinutes} min); background chain presumed dead`;

      if (!dryRun) {
        await db.collection('backtestRuns').doc(doc.id).set(
          {
            status: 'failed',
            failedAt: new Date().toISOString(),
            error: reason,
            cursor: null,
          },
          { merge: true },
        );
      }
      swept.push({
        runId: doc.id,
        status,
        lastSeenAt,
        idleMinutes,
        action: dryRun ? 'would-fail' : 'failed',
        reason,
      });
    }

    const failedCount = swept.filter((r) => r.action !== 'skipped').length;

    // VECTOR — sweep vector_scan_state zombies in the same pass (a
    // checkpointed backfill whose chain died mid-flight stays 'running'
    // forever without this; failed-out jobs resume via POST {resume:true}).
    let vectorZombies: string[] = [];
    if (!dryRun) {
      try {
        const { failOutZombies } = await import('./shared/vector-store');
        vectorZombies = await failOutZombies(staleMinutes * 60_000);
      } catch (err) {
        log.warn('vector_zombie_sweep_failed', { err: String((err as Error)?.message ?? err) });
      }
    }

    log.info('recover_sweep_complete', {
      inspected: docs.length,
      failed: failedCount,
      vectorZombies,
      dryRun,
      staleMinutes,
    });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        dryRun,
        staleMinutes,
        inspected: docs.length,
        recovered: swept,
      }),
    };
  } catch (err: any) {
    log.error('recover_sweep_failed', { err: String(err?.message ?? err) });
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ ok: false, error: String(err?.message ?? err) }),
    };
  }
};
