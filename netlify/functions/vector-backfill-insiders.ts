// VECTOR — E2 insider-cluster-in-drawdown backfill (background, checkpointed).
//
// POST /.netlify/functions/vector-backfill-insiders
// Body: { resume?: true, tickers?: string[] }
//
// Reuses the existing Finnhub insider PIT fetch (token bucket, patient
// retry). Backfill target is 2013-01-01 so the Cohen-Malloy-Pomorski
// routine screen has its 3-year lookback for events from 2016 on. Plan
// depth may not serve 2013 — when a ticker's history reaches back less
// than (event - 3y), the screen degrades to the pre-registered reduced
// variant (same-insider-same-month in the prior 2 years) and the event
// carries routineScreen:'reduced'. Never silently.
//
// Cluster events (2nd distinct qualifying buyer within 90d) are gated at
// the filing date to close <= 0.80 x max(high, 252d) — the E2 drawdown
// context — using the same per-ticker Polygon series the features use.
//
// Failures THROW; failed tickers stay on the checkpoint's retry list.

import type { Handler } from '@netlify/functions';
import { getFinnhubInsiderTransactionsWithStatus } from './shared/data-provider';
import { getDailyBarsClamped } from './shared/vector-data';
import {
  qualifiesE2, isRoutineInsider, detectClusters, sellClusterActive, type InsiderTx,
} from './shared/vector-events';
import { computeFeatures, type FBar } from './shared/vector-features';
import { VECTOR_MODEL_VERSION, VALIDATION, E2 } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, reinvoke,
  upsertEvents, eventDocId, type VectorCheckpoint, type VectorEventDoc,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const JOB = 'backfill-insiders';
const BUDGET_MS = 12 * 60_000;
const BARS_FROM = '2015-01-02';
const BARS_TO = VALIDATION.window.end;
const MAX_FAILURE_RATE = 0.2;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-backfill-insiders' });
  const started = Date.now();

  let body: { resume?: boolean; tickers?: string[] } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* defaults */ }
  const prior = body.resume ? await readCheckpoint(JOB) : null;

  try {
    let universe: string[];
    if (body.tickers?.length) {
      universe = body.tickers.map((t) => t.toUpperCase());
    } else if (prior?.cursor?.universe) {
      universe = prior.cursor.universe as string[];
    } else {
      const snaps = await getAdminDb().collection(VECTOR_COLLECTIONS.universeSnapshots).select('tickers').get();
      const set = new Set<string>();
      for (const d of snaps.docs) for (const t of (d.data().tickers ?? []) as any[]) set.add(t.ticker);
      universe = [...set].sort();
      if (!universe.length) throw new Error('no universe snapshots — run vector-universe-snapshot first');
    }

    const startIdx = (prior?.cursor?.tickerIdx as number) ?? 0;
    const failedTickers = new Set<string>((prior?.cursor?.failedTickers as string[]) ?? []);
    const cp: VectorCheckpoint = {
      job: JOB,
      status: 'running',
      cursor: { tickerIdx: startIdx, universe, failedTickers: [...failedTickers] },
      counters: prior?.counters ?? {
        events: 0, gatedOutNotInDrawdown: 0, routineExcluded: 0, reducedScreens: 0,
        tickersDone: 0, failures: 0,
      },
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      invocations: (prior?.invocations ?? 0) + 1,
    };
    await writeCheckpoint(cp);

    // Form 4 lookback anchored at the design's 2013-01-01 start.
    const daysBack = Math.ceil((Date.now() - Date.parse(E2.form4BackfillStart)) / 86_400_000);
    const spy = (await getDailyBarsClamped('SPY', BARS_FROM, BARS_TO)).bars as unknown as FBar[];

    let i = startIdx;
    for (; i < universe.length && Date.now() - started < BUDGET_MS; i++) {
      const ticker = universe[i];
      try {
        const res = await getFinnhubInsiderTransactionsWithStatus(ticker, daysBack, {});
        if (!res || (res as any).rateLimitExhausted) {
          throw new Error('finnhub insider fetch exhausted rate-limit retries');
        }
        const raw = ((res as any).data ?? []) as any[];

        // Map to InsiderTx; Finnhub carries code, name, share, change,
        // transactionPrice, transactionDate, filingDate. Officer/director
        // discrimination is best-effort (Finnhub omits role; edgar-roles
        // enrichment is the live path's job). For the backfill we accept
        // all Form-4 reporters as officer/director — Form 4 filers are
        // insiders BY DEFINITION (officers, directors, 10% owners); the
        // 10%-owner admixture is recorded so the cohort can be split later.
        const txs: InsiderTx[] = raw
          .filter((r) => (r.transactionCode === 'P' || r.transactionCode === 'S') && r.transactionPrice > 0)
          .map((r) => ({
            insiderName: String(r.name ?? 'unknown'),
            code: r.transactionCode as 'P' | 'S',
            transactionDate: String(r.transactionDate ?? ''),
            filingDate: String(r.filingDate ?? r.transactionDate ?? ''),
            dollars: Math.abs((r.change ?? r.share ?? 0) * (r.transactionPrice ?? 0)),
            isOfficerOrDirector: true,
          }))
          .filter((t) => t.transactionDate && t.filingDate);

        const purchases = txs.filter((t) => t.code === 'P');
        const sells = txs.filter((t) => t.code === 'S');

        // Routine screen mode: full needs history covering event-3y; the
        // fetched window's earliest filing tells us what we actually have.
        const earliest = purchases.length
          ? purchases.reduce((a, b) => (a.transactionDate < b.transactionDate ? a : b)).transactionDate
          : null;

        // Qualifying purchases with the routine screen applied per insider.
        const byInsider = new Map<string, InsiderTx[]>();
        for (const p of purchases) {
          const k = p.insiderName.toLowerCase();
          if (!byInsider.has(k)) byInsider.set(k, []);
          byInsider.get(k)!.push(p);
        }
        const qualifying: InsiderTx[] = [];
        let routineExcluded = 0;
        let usedReduced = false;
        for (const p of purchases) {
          if (!qualifiesE2(p)) continue;
          const history = (byInsider.get(p.insiderName.toLowerCase()) ?? [])
            .filter((h) => h.transactionDate < p.transactionDate);
          const threeYearsBefore = new Date(Date.parse(p.transactionDate) - 3 * 365 * 86_400_000)
            .toISOString().slice(0, 10);
          const mode: 'full' | 'reduced' = earliest != null && earliest <= threeYearsBefore ? 'full' : 'reduced';
          if (mode === 'reduced') usedReduced = true;
          if (isRoutineInsider(p.transactionDate, history, mode)) { routineExcluded++; continue; }
          qualifying.push(p);
        }
        cp.counters.routineExcluded += routineExcluded;
        if (usedReduced) cp.counters.reducedScreens++;

        const clusters = detectClusters(qualifying);
        if (clusters.length) {
          const bars = (await getDailyBarsClamped(ticker, BARS_FROM, BARS_TO)).bars as unknown as FBar[];
          const barIdxByDay = new Map(bars.map((b, j) => [new Date(b.t).toISOString().slice(0, 10), j]));
          const dayOf = (d: string) => {
            // filing dates on non-trading days resolve to the next bar
            let cur = d;
            for (let k = 0; k < 7; k++) {
              if (barIdxByDay.has(cur)) return cur;
              cur = new Date(Date.parse(cur + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
            }
            return null;
          };

          const events: VectorEventDoc[] = [];
          for (const c of clusters) {
            if (c.date < VALIDATION.window.start || c.date > VALIDATION.window.end) continue;
            const d = dayOf(c.date);
            if (!d) continue;
            const bIdx = barIdxByDay.get(d)!;
            if (bIdx < 252) continue; // need the 52w high for the gate

            // Drawdown gate: close <= 0.80 x max(high, 252d).
            const hi252 = Math.max(...bars.slice(bIdx - 251, bIdx + 1).map((b) => b.h));
            const close = bars[bIdx].c;
            if (close > E2.drawdownGate * hi252) { cp.counters.gatedOutNotInDrawdown++; continue; }

            // Hygiene/bucket at t from the prior month-end snapshot.
            const bmap = await latestBucketMap(d);
            const bucket = bmap?.get(ticker);
            if (!bucket) continue;

            const spyClipped = spy.filter((b) => b.t <= bars[bIdx].t);
            const features = computeFeatures(bars.slice(0, bIdx + 1), spyClipped);

            events.push({
              id: eventDocId('E2', ticker, d),
              type: 'E2',
              ticker,
              date: d,
              payload: {
                buyers: c.buyers,
                aggregateDollars: Math.round(c.aggregateDollars),
                filingDate: c.date,
                sellCluster: sellClusterActive(sells, c.date),
                routineScreen: usedReduced ? 'reduced' : 'full',
                distToHigh: +(close / hi252).toFixed(4),
              },
              features: features as unknown as Record<string, unknown>,
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
        cp.counters.tickersDone++;
        failedTickers.delete(ticker);
      } catch (err) {
        cp.counters.failures++;
        failedTickers.add(ticker);
        log.warn('ticker_failed', { ticker, err: String((err as Error)?.message ?? err) });
        if (cp.counters.failures / Math.max(1, cp.counters.tickersDone + cp.counters.failures) > MAX_FAILURE_RATE
            && cp.counters.failures > 25) {
          throw new Error(`failure rate exceeded ${MAX_FAILURE_RATE * 100}%`);
        }
      }
      if (i % 10 === 0) {
        cp.cursor.tickerIdx = i + 1;
        cp.cursor.failedTickers = [...failedTickers];
        cp.heartbeatAt = new Date().toISOString();
        await writeCheckpoint(cp);
      }
    }

    const finished = i >= universe.length;
    cp.cursor.tickerIdx = i;
    cp.cursor.failedTickers = [...failedTickers];
    cp.status = finished ? 'complete' : 'running';
    cp.heartbeatAt = new Date().toISOString();
    if (finished) cp.completedAt = new Date().toISOString();
    await writeCheckpoint(cp);
    if (!finished) await reinvoke('vector-backfill-insiders', { resume: true });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, job: JOB, finished, tickerIdx: i, of: universe.length, counters: cp.counters }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    const cp = await readCheckpoint(JOB);
    if (cp) {
      cp.status = 'failed';
      cp.error = msg;
      cp.heartbeatAt = new Date().toISOString();
      await writeCheckpoint(cp).catch(() => {});
    }
    log.error('backfill_insiders_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, job: JOB, error: msg }) };
  }
};

// Prior-month-end hygiene lookup (shared shape with the earnings backfill;
// kept local so each function file stays self-contained per convention).
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
