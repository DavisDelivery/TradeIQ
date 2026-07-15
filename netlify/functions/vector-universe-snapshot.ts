// VECTOR — PIT hygiene universe snapshot builder (background, checkpointed).
//
// POST /.netlify/functions/vector-universe-snapshot
// Body: { start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD', resume?: true }
//
// For each calendar month-end in [start, end], builds the hygiene list —
// every US ticker (Polygon grouped-daily, which includes tickers that
// later delisted) passing: close >= $5, >= 287 bars seen, 63d median
// dollar volume >= $2M — and writes it to vector_universe_snapshots/{date}
// with each ticker's size bucket. Survivorship-proof by construction:
// the grouped-daily files are what printed that day, dead companies and
// all.
//
// Mechanics: walks trading days ONE grouped call per day, maintaining
// per-ticker rolling state (63d dollar-vol window, bar count). At each
// month-end the hygiene list snapshots the rolling state. Checkpoint =
// last fully processed day + last written month-end; resume re-warms the
// 63d window from (checkpoint - 100 calendar days) without re-writing
// older snapshots. Failures THROW (4t-W1c) — the checkpoint doc records
// 'failed' and the chain stops; re-POST with resume:true to continue.

import type { Handler } from '@netlify/functions';
import { getGroupedDaily } from './shared/vector-data';
import { monthEnds } from './shared/vector-events';
import { sizeBucketOf, HYGIENE, VECTOR_MODEL_VERSION } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, heartbeat, reinvoke,
  type VectorCheckpoint,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const JOB = 'universe-snapshot';
const BUDGET_MS = 12 * 60_000;
const DEFAULT_START = '2015-06-30'; // warmup runway before the 2016-01-31 window opens
const DEFAULT_END = '2024-12-31';
// Re-warm window on resume: 420 calendar days ≈ 287 trading days, so the
// bar-count hygiene check is enforced IDENTICALLY on fresh and resumed
// paths (a shorter warmup would let sub-287-bar IPOs slip into resumed
// snapshots). Costs ~290 grouped calls per resume — correctness first.
const WARMUP_CAL_DAYS = 420;

interface RollState {
  dollarVols: number[]; // trailing window, capped at 63
  bars: number; // total bars seen (capped count is fine past hygiene min)
  lastClose: number;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-universe-snapshot' });
  const started = Date.now();

  let body: { start?: string; end?: string; resume?: boolean } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* defaults */ }

  const prior = body.resume ? await readCheckpoint(JOB) : null;
  const start = (prior?.cursor?.start as string) ?? body.start ?? DEFAULT_START;
  const end = (prior?.cursor?.end as string) ?? body.end ?? DEFAULT_END;
  const targets = monthEnds(start, end).filter((d) => d >= start);
  const doneThrough = (prior?.cursor?.doneThrough as string) ?? null;
  const nextTargets = doneThrough ? targets.filter((d) => d > doneThrough) : targets;
  if (!nextTargets.length) {
    return { statusCode: 200, body: JSON.stringify({ ok: true, job: JOB, note: 'nothing to do' }) };
  }

  const cp: VectorCheckpoint = {
    job: JOB,
    status: 'running',
    cursor: { start, end, doneThrough },
    counters: prior?.counters ?? { snapshotsWritten: 0, groupedCalls: 0 },
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    invocations: (prior?.invocations ?? 0) + 1,
  };
  await writeCheckpoint(cp);

  // Walk days from warmup point up to as many month-ends as the budget allows.
  const walkFrom = doneThrough
    ? new Date(Date.parse(doneThrough) - WARMUP_CAL_DAYS * 86_400_000).toISOString().slice(0, 10)
    : new Date(Date.parse(nextTargets[0]) - 420 * 86_400_000).toISOString().slice(0, 10); // first snapshot needs 287-bar runway

  const state = new Map<string, RollState>();
  const db = getAdminDb();
  let day = walkFrom;
  let targetIdx = 0;
  let snapshotsThisRun = 0;

  try {
    while (targetIdx < nextTargets.length && Date.now() - started < BUDGET_MS) {
      const rows = await getGroupedDaily(day);
      cp.counters.groupedCalls++;
      for (const r of rows) {
        if (!r.T || r.c == null || r.v == null) continue;
        let s = state.get(r.T);
        if (!s) { s = { dollarVols: [], bars: 0, lastClose: 0 }; state.set(r.T, s); }
        s.dollarVols.push(r.c * r.v);
        if (s.dollarVols.length > 63) s.dollarVols.shift();
        s.bars++;
        s.lastClose = r.c;
      }
      // Month-end reached — we snapshot when `day` reaches/passes the
      // target (the rolling state then reflects the last trading day <=
      // the calendar month-end).
      while (targetIdx < nextTargets.length && day >= nextTargets[targetIdx]) {
        const asOf = nextTargets[targetIdx];
        // Warmup-only pass (resume path): re-warmed state but this target
        // predates doneThrough — cannot happen since nextTargets filtered.
        const list: { ticker: string; sizeBucket: string; medianDollarVol: number; close: number }[] = [];
        for (const [ticker, s] of state) {
          if (s.lastClose < HYGIENE.minClose) continue;
          if (s.bars < HYGIENE.minBars) continue; // enforced on fresh AND resumed paths
          if (s.dollarVols.length < 63) continue;
          const sorted = [...s.dollarVols].sort((a, b) => a - b);
          const med = sorted.length % 2 ? sorted[(sorted.length - 1) / 2]
            : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
          if (med < HYGIENE.minMedianDollarVol63d) continue;
          const bucket = sizeBucketOf(med);
          if (!bucket) continue;
          list.push({ ticker, sizeBucket: bucket, medianDollarVol: Math.round(med), close: s.lastClose });
        }
        await db.collection(VECTOR_COLLECTIONS.universeSnapshots).doc(asOf).set({
          asOf,
          count: list.length,
          byBucket: {
            LARGE: list.filter((x) => x.sizeBucket === 'LARGE').length,
            MID: list.filter((x) => x.sizeBucket === 'MID').length,
            SMALL: list.filter((x) => x.sizeBucket === 'SMALL').length,
          },
          tickers: list,
          modelVersion: VECTOR_MODEL_VERSION,
          builtAt: new Date().toISOString(),
          warmedResume: !!doneThrough,
        });
        cp.counters.snapshotsWritten++;
        snapshotsThisRun++;
        cp.cursor.doneThrough = asOf;
        targetIdx++;
        await heartbeat(JOB);
        log.info('universe_snapshot_written', { asOf, tickers: list.length });
      }

      // advance one calendar day
      day = new Date(Date.parse(day) + 86_400_000).toISOString().slice(0, 10);
    }

    const finished = targetIdx >= nextTargets.length;
    cp.status = finished ? 'complete' : 'running';
    cp.heartbeatAt = new Date().toISOString();
    if (finished) cp.completedAt = new Date().toISOString();
    await writeCheckpoint(cp);
    if (!finished) await reinvoke('vector-universe-snapshot', { resume: true });

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true, job: JOB, finished, snapshotsThisRun,
        doneThrough: cp.cursor.doneThrough, counters: cp.counters,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    cp.status = 'failed';
    cp.error = msg;
    cp.heartbeatAt = new Date().toISOString();
    await writeCheckpoint(cp).catch(() => {});
    log.error('universe_snapshot_failed', { err: msg, day, doneThrough: cp.cursor.doneThrough });
    // THROW discipline: never a fabricated-empty snapshot; the error is
    // recorded on the checkpoint and the chain stops here.
    return { statusCode: 500, body: JSON.stringify({ ok: false, job: JOB, error: msg }) };
  }
};
