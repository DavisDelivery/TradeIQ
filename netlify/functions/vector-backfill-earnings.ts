// VECTOR — E1 earnings-surprise backfill (background, checkpointed).
//
// POST /.netlify/functions/vector-backfill-earnings
// Body: { resume?: true, tickers?: string[] }   (tickers = debug subset)
//
// Universe = the union of all PIT hygiene snapshots (vector_universe_
// snapshots), so delisted names are included and nothing outside hygiene
// wastes provider quota. Per ticker:
//   1. Massive PIT income statements (split-adjusted as-reported diluted
//      EPS + filing_date) -> quarterly EPS series. SUE per design needs
//      >= 12 quarters before a report can score.
//   2. Event-day resolution: Finnhub's earnings calendar `hour` field
//      (bmo/amc) where the plan serves that date; otherwise the event day
//      falls back to the statement's SEC filing_date treated as AMC.
//      FALLBACK BIAS NOTE: filing_date trails the press release by days
//      to weeks, so the fallback measures a LATER, less-anticipatory
//      entry — it can only understate edge, which is the direction the
//      design permits a bias to point. payload.dateSource records which
//      path resolved each event.
//   3. Reaction close(d-1)->close(d) vs SPY, volumeShock vs median63,
//      state features at d — all from one Polygon bar series per ticker
//      (2015->window end) and one shared SPY series.
//   4. Upsert one vector_events doc per report (deterministic id).
//
// Checkpoint = ticker index into the sorted universe. Per-ticker
// transport failures are recorded in cursor.failedTickers and NEVER
// written as empty events (4t-W1c); a failure rate > 20% fails the whole
// job loudly.

import type { Handler } from '@netlify/functions';
import { getIncomeStatementsPit } from './shared/massive-fundamentals';
import { getEarningsCalendarForSymbol, getDailyBarsClamped } from './shared/vector-data';
import { computeSue, e1Agreement, resolveEventDay } from './shared/vector-events';
import { computeFeatures, type FBar } from './shared/vector-features';
import { VECTOR_MODEL_VERSION, VALIDATION, HYGIENE } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, heartbeat, reinvoke,
  upsertEvents, eventDocId, type VectorCheckpoint, type VectorEventDoc,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const JOB = 'backfill-earnings';
const BUDGET_MS = 12 * 60_000;
const BARS_FROM = '2015-01-02';
const BARS_TO = VALIDATION.window.end; // 2024-12-31
const MAX_FAILURE_RATE = 0.2;

type BucketMap = Map<string, { sizeBucket: 'LARGE' | 'MID' | 'SMALL'; sector: string | null }>;

// Month-end hygiene snapshot cache for (asOf -> ticker -> bucket).
const snapCache = new Map<string, BucketMap>();

async function bucketAt(date: string): Promise<BucketMap | null> {
  // Find the latest snapshot <= date (snapshots are month-ends).
  const asOf = `${date.slice(0, 7)}-01` <= date ? date.slice(0, 7) : date.slice(0, 7);
  // Try this month-end and up to 2 prior month-ends.
  const db = getAdminDb();
  for (let back = 0; back < 3; back++) {
    const [y, m] = asOf.split('-').map(Number);
    const mm = m - back;
    const yy = mm >= 1 ? y : y - 1;
    const m2 = mm >= 1 ? mm : mm + 12;
    const lastDay = new Date(Date.UTC(yy, m2, 0)).getUTCDate();
    const key = `${yy}-${String(m2).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;
    // The event month's own month-end is in the future relative to intra-
    // month events; PIT requires the PRIOR month-end unless date IS the
    // month-end. Skip keys > date.
    if (key > date) continue;
    if (snapCache.has(key)) return snapCache.get(key)!;
    const doc = await db.collection(VECTOR_COLLECTIONS.universeSnapshots).doc(key).get();
    if (doc.exists) {
      const map: BucketMap = new Map();
      for (const t of (doc.data()!.tickers ?? []) as any[]) {
        map.set(t.ticker, { sizeBucket: t.sizeBucket, sector: t.sector ?? null });
      }
      snapCache.set(key, map);
      return map;
    }
  }
  return null;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-backfill-earnings' });
  const started = Date.now();

  let body: { resume?: boolean; tickers?: string[] } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* defaults */ }

  const prior = body.resume ? await readCheckpoint(JOB) : null;

  try {
    // Universe: union of hygiene snapshot tickers (or debug subset).
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
      counters: prior?.counters ?? { events: 0, agreements: 0, tickersDone: 0, failures: 0, skippedThinHistory: 0 },
      startedAt: prior?.startedAt ?? new Date().toISOString(),
      heartbeatAt: new Date().toISOString(),
      invocations: (prior?.invocations ?? 0) + 1,
    };
    await writeCheckpoint(cp);

    // SPY series once per invocation: the trading calendar + benchmark.
    const spy = (await getDailyBarsClamped('SPY', BARS_FROM, BARS_TO)).bars as unknown as FBar[];
    if (spy.length < 500) throw new Error(`SPY series too thin (${spy.length}) — refusing to fabricate a calendar`);
    const spyDays = spy.map((b) => new Date(b.t).toISOString().slice(0, 10));
    const spySet = new Set(spyDays);
    const isTradingDay = (d: string) => spySet.has(d);
    const nextTradingDay = (d: string) => {
      let cur = d;
      for (let i = 0; i < 12; i++) {
        cur = new Date(Date.parse(cur + 'T00:00:00Z') + 86_400_000).toISOString().slice(0, 10);
        if (spySet.has(cur)) return cur;
      }
      return cur; // beyond window end; caller's window filter drops it
    };
    const spyIdxByDay = new Map(spyDays.map((d, i) => [d, i]));

    let i = startIdx;
    for (; i < universe.length && Date.now() - started < BUDGET_MS; i++) {
      const ticker = universe[i];
      try {
        // 40 statements ≈ 10 years of quarters; PIT cutoff at window end.
        const stmts = await getIncomeStatementsPit(ticker, BARS_TO, 48);
        const quarterly = (stmts ?? [])
          .filter((s: any) => s.diluted_earnings_per_share != null && (s.filing_date || s.period_end))
          .map((s: any) => ({
            eps: s.diluted_earnings_per_share as number,
            periodEnd: (s.period_end ?? '') as string,
            filingDate: (s.filing_date ?? s.period_end) as string,
          }))
          .filter((s) => s.periodEnd)
          .sort((a, b) => a.periodEnd.localeCompare(b.periodEnd));

        if (quarterly.length < HYGIENE.minEpsQuarters) {
          cp.counters.skippedThinHistory++;
          cp.counters.tickersDone++;
          continue;
        }

        // Finnhub calendar hour resolution for this ticker's report dates —
        // best-effort: current plan depth may not reach 2016. Missing dates
        // fall back to filing_date-as-AMC.
        // Calendar rows are ANNOUNCEMENT dates (press release), which precede
        // the SEC filing_date. Join by period: the announcement for a quarter
        // is the first calendar date in (periodEnd, periodEnd + 90d].
        let calRows: { date: string; hour: 'bmo' | 'amc' | 'dmh' | '' }[] = [];
        try {
          calRows = await getEarningsCalendarForSymbol(ticker, '2015-06-01', BARS_TO);
          calRows.sort((a, b) => a.date.localeCompare(b.date));
        } catch {
          // Plan-depth or transport failure: every report for this ticker
          // resolves via the filing-date fallback (dateSource records it).
        }
        const announceFor = (periodEnd: string): { date: string; hour: 'bmo' | 'amc' | 'dmh' | '' } | null => {
          const limit = new Date(Date.parse(periodEnd) + 90 * 86_400_000).toISOString().slice(0, 10);
          for (const r of calRows) {
            if (r.date > periodEnd && r.date <= limit) return r;
          }
          return null;
        };

        const bars = (await getDailyBarsClamped(ticker, BARS_FROM, BARS_TO)).bars as unknown as FBar[];
        if (bars.length < 260) { cp.counters.skippedThinHistory++; cp.counters.tickersDone++; continue; }
        const barIdxByDay = new Map(bars.map((b, j) => [new Date(b.t).toISOString().slice(0, 10), j]));

        const events: VectorEventDoc[] = [];
        for (let q = HYGIENE.minEpsQuarters; q < quarterly.length; q++) {
          const report = quarterly[q];
          const sue = computeSue(quarterly.slice(0, q + 1).map((x) => x.eps));
          if (sue == null) continue;

          const cal = announceFor(report.periodEnd);
          const announceDate = cal?.date ?? report.filingDate;
          const calHour = cal?.hour ?? null;
          const d = resolveEventDay(announceDate, calHour === 'dmh' ? 'amc' : calHour, nextTradingDay, isTradingDay);
          if (d < VALIDATION.window.start || d > VALIDATION.window.end) continue;

          const bIdx = barIdxByDay.get(d);
          const sIdx = spyIdxByDay.get(d);
          if (bIdx == null || bIdx < 1 || sIdx == null || sIdx < 1) continue;

          // Hygiene + bucket at t (prior month-end snapshot).
          const bmap = await bucketAt(d);
          const bucket = bmap?.get(ticker);
          if (!bucket) continue; // outside hygiene universe at t

          const tickerRet = bars[bIdx].c / bars[bIdx - 1].c - 1;
          const spyRet = spy[sIdx].c / spy[sIdx - 1].c - 1;
          const reaction = tickerRet - spyRet;
          const trailing = bars.slice(Math.max(0, bIdx - 64), bIdx);
          const medVol = trailing.length >= 20
            ? [...trailing.map((b) => b.v)].sort((a, b) => a - b)[Math.floor(trailing.length / 2)]
            : null;
          const volumeShock = medVol && medVol > 0 ? bars[bIdx].v / medVol : null;

          const features = computeFeatures(bars.slice(0, bIdx + 1), spy.slice(0, sIdx + 1));
          const agreement = e1Agreement(sue, reaction, volumeShock);

          events.push({
            id: eventDocId('E1', ticker, d),
            type: 'E1',
            ticker,
            date: d,
            payload: {
              sue,
              reaction: +reaction.toFixed(5),
              volumeShock: volumeShock != null ? +volumeShock.toFixed(3) : null,
              epsQuarters: q + 1,
              periodEnd: report.periodEnd,
              announceDate,
              hour: calHour,
              dateSource: cal != null ? 'finnhub-calendar' : 'filing-date',
            },
            features: features as unknown as Record<string, unknown>,
            sizeBucket: bucket.sizeBucket,
            sector: bucket.sector,
            agreement,
            modelVersion: VECTOR_MODEL_VERSION,
            createdAt: new Date().toISOString(),
          });
        }

        if (events.length) {
          await upsertEvents(events);
          cp.counters.events += events.length;
          cp.counters.agreements += events.filter((e) => e.agreement).length;
        }
        cp.counters.tickersDone++;
        failedTickers.delete(ticker);
      } catch (err) {
        cp.counters.failures++;
        failedTickers.add(ticker);
        log.warn('ticker_failed', { ticker, err: String((err as Error)?.message ?? err) });
        // THROW-discipline: nothing written for this ticker; it stays on
        // the failed list for a retry pass. A high failure rate aborts.
        if (cp.counters.failures / Math.max(1, cp.counters.tickersDone + cp.counters.failures) > MAX_FAILURE_RATE
            && cp.counters.failures > 25) {
          throw new Error(`failure rate exceeded ${MAX_FAILURE_RATE * 100}% (${cp.counters.failures} failures)`);
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
    if (!finished) await reinvoke('vector-backfill-earnings', { resume: true });

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
    log.error('backfill_earnings_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, job: JOB, error: msg }) };
  }
};
