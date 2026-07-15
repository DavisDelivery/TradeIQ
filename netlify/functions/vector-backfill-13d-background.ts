// VECTOR — E3 activist-stake backfill: initial SC 13D filings (background,
// checkpointed).
//
// POST /.netlify/functions/vector-backfill-13d-background
// Body: { resume?: true, start?: 'YYYY-MM-DD', end?: 'YYYY-MM-DD' }
//
// Walks EDGAR daily form indexes (form.YYYYMMDD.idx) one trading day at a
// time, <= 8 req/s with the SEC-required UA header. Initial SC 13D rows
// (amendments excluded) map subject CIK -> ticker via company_tickers.json;
// unmapped CIKs are counted, never guessed. Event date = filing date.
// The Feb-2024 deadline change (10 -> 5 business days) is stamped on each
// event as regime:'pre5day'|'post5day' for the descriptive pre/post split.
//
// Weekend/holiday index files 404 — that is an EXPECTED miss (skipped,
// counted), not a failure. Transport failures on real days THROW.

import type { Handler } from '@netlify/functions';
import { edgarFetch, dailyIndexUrl, getCikTickerMap, getDailyBarsClamped } from './shared/vector-data';
import { parseSc13dIndex } from './shared/vector-events';
import { computeFeatures, type FBar } from './shared/vector-features';
import { VECTOR_MODEL_VERSION, VALIDATION, E3 } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, reinvoke,
  upsertEvents, eventDocId, type VectorCheckpoint, type VectorEventDoc,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const JOB = 'backfill-13d';
const BUDGET_MS = 12 * 60_000;
const BARS_FROM = '2015-01-02';
const BARS_TO = VALIDATION.window.end;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-backfill-13d' });
  const started = Date.now();

  let body: { resume?: boolean; start?: string; end?: string } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* defaults */ }
  const prior = body.resume ? await readCheckpoint(JOB) : null;

  const start = (prior?.cursor?.start as string) ?? body.start ?? VALIDATION.window.start;
  const end = (prior?.cursor?.end as string) ?? body.end ?? VALIDATION.window.end;
  const doneThrough = (prior?.cursor?.doneThrough as string) ?? null;

  const cp: VectorCheckpoint = {
    job: JOB,
    status: 'running',
    cursor: { start, end, doneThrough },
    counters: prior?.counters ?? {
      filingsSeen: 0, events: 0, unmappedCik: 0, indexMisses: 0,
      outsideHygiene: 0, thinBars: 0,
    },
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    invocations: (prior?.invocations ?? 0) + 1,
  };
  await writeCheckpoint(cp);

  try {
    const cikMap = await getCikTickerMap();
    const spy = (await getDailyBarsClamped('SPY', BARS_FROM, BARS_TO)).bars as unknown as FBar[];

    let day = doneThrough
      ? new Date(Date.parse(doneThrough) + 86_400_000).toISOString().slice(0, 10)
      : start;
    let daysThisRun = 0;

    while (day <= end && Date.now() - started < BUDGET_MS) {
      const dow = new Date(Date.parse(day + 'T00:00:00Z')).getUTCDay();
      if (dow === 0 || dow === 6) {
        cp.cursor.doneThrough = day;
        day = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
        continue;
      }

      let idxText: string | null = null;
      try {
        const res = await edgarFetch(dailyIndexUrl(day));
        idxText = await res.text();
      } catch (err) {
        const msg = String((err as Error)?.message ?? err);
        if (msg.includes('HTTP 404') || msg.includes('HTTP 403')) {
          cp.counters.indexMisses++; // holiday / missing index — expected
        } else {
          throw err; // real transport failure: THROW, checkpoint stops here
        }
      }

      if (idxText) {
        const filings = parseSc13dIndex(idxText);
        cp.counters.filingsSeen += filings.length;
        const events: VectorEventDoc[] = [];
        for (const f of filings) {
          const ticker = cikMap.get(f.cik);
          if (!ticker) { cp.counters.unmappedCik++; continue; }

          const bmap = await latestBucketMap(f.dateFiled);
          const bucket = bmap?.get(ticker);
          if (!bucket) { cp.counters.outsideHygiene++; continue; }

          let features: Record<string, unknown> = {};
          try {
            const bars = (await getDailyBarsClamped(ticker, BARS_FROM, f.dateFiled)).bars as unknown as FBar[];
            if (bars.length < 64) { cp.counters.thinBars++; continue; }
            const spyClipped = spy.filter((b) => new Date(b.t).toISOString().slice(0, 10) <= f.dateFiled);
            features = computeFeatures(bars, spyClipped) as unknown as Record<string, unknown>;
          } catch (err) {
            // Bar fetch failed for one subject — skip the event rather than
            // store a featureless row; the day re-runs on resume only if we
            // THROW, so count it and move on (rare).
            cp.counters.thinBars++;
            continue;
          }

          events.push({
            id: eventDocId('E3', ticker, f.dateFiled),
            type: 'E3',
            ticker,
            date: f.dateFiled,
            payload: {
              company: f.company,
              cik: f.cik,
              path: f.path,
              regime: f.dateFiled >= E3.deadlineChangeCompliance ? 'post5day' : 'pre5day',
            },
            features,
            sizeBucket: bucket.sizeBucket,
            sector: bucket.sector,
            modelVersion: VECTOR_MODEL_VERSION,
            createdAt: new Date().toISOString(),
          });
        }
        if (events.length) {
          await upsertEvents(events);
          cp.counters.events += events.length;
        }
      }

      cp.cursor.doneThrough = day;
      daysThisRun++;
      if (daysThisRun % 20 === 0) {
        cp.heartbeatAt = new Date().toISOString();
        await writeCheckpoint(cp);
      }
      day = new Date(Date.parse(day + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
    }

    const finished = day > end;
    cp.status = finished ? 'complete' : 'running';
    cp.heartbeatAt = new Date().toISOString();
    if (finished) cp.completedAt = new Date().toISOString();
    await writeCheckpoint(cp);
    if (!finished) await reinvoke('vector-backfill-13d-background', { resume: true });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, job: JOB, finished, doneThrough: cp.cursor.doneThrough, counters: cp.counters }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    cp.status = 'failed';
    cp.error = msg;
    cp.heartbeatAt = new Date().toISOString();
    await writeCheckpoint(cp).catch(() => {});
    log.error('backfill_13d_failed', { err: msg, doneThrough: cp.cursor.doneThrough });
    return { statusCode: 500, body: JSON.stringify({ ok: false, job: JOB, error: msg }) };
  }
};

type BMap = Map<string, { sizeBucket: 'LARGE' | 'MID' | 'SMALL'; sector: string | null }>;
const bmapCache = new Map<string, BMap | null>();

async function latestBucketMap(date: string): Promise<BMap | null> {
  const db = getAdminDb();
  for (let back = 0; back < 3; back++) {
    const [y, m] = date.slice(0, 7).split('-').map(Number);
    const mm = m - back;
    const yy = mm >= 1 ? y : y - 1;
    const m2 = mm >= 1 ? mm : mm + 12;
    const lastDay = new Date(Date.UTC(yy, m2, 0)).getUTCDate();
    const key = `${yy}-${String(m2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    if (key > date) continue;
    if (bmapCache.has(key)) {
      const hit = bmapCache.get(key);
      if (hit) return hit;
      continue;
    }
    const doc = await db.collection(VECTOR_COLLECTIONS.universeSnapshots).doc(key).get();
    if (doc.exists) {
      const map: BMap = new Map();
      for (const t of (doc.data()!.tickers ?? []) as any[]) {
        map.set(t.ticker, { sizeBucket: t.sizeBucket, sector: t.sector ?? null });
      }
      bmapCache.set(key, map);
      return map;
    }
    bmapCache.set(key, null);
  }
  return null;
}
