// VECTOR — pre-committed validation runner (background, checkpointed).
//
// POST /.netlify/functions/vector-validate-background
// Body: { runId: string, resume?: true }
//
// Executes the BINDING rule in reports/vector/design.md against the event
// library. Three checkpointed phases:
//
//   cars     — per distinct event ticker: one Polygon bar fetch; per event
//              the net market-adjusted CAR at its type's horizon (SPY for
//              LARGE, IWM for MID/SMALL), t+1-open entry, delistings closed
//              at last print; quadrant assignment from stored features
//              (fscore may be null — the F axis computes from the rest and
//              the row carries the noData flags). Compact rows chunked into
//              vector_runs/{runId}/cars/{n} — the cohort API reads these.
//   verdicts — H1-H5 exactly per the rule; per-trigger chips.
//   sim      — book sim over VALIDATED triggers only (playbook constants),
//              vs IWM; TRADE THE BOOK iff net active return t >= 2.
//
// The runner NEVER mutates constants; the run doc records the
// VECTOR_MODEL_VERSION and git constants it measured. Failures THROW and
// the checkpoint records them; nothing is fabricated.

import type { Handler } from '@netlify/functions';
import { getDailyBarsClamped } from './shared/vector-data';
import { carForEvent, sampleStats, welchT, terciles, monotone, type StudyBar } from './shared/vector-study';
import { runVectorSim, type SimEvent } from './shared/vector-sim';
import { scoreFAxis, scoreTAxis } from './shared/vector-verdict';
import { quadrantOf, VALIDATION, VECTOR_MODEL_VERSION } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, reinvoke, type VectorCheckpoint,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const BUDGET_MS = 12 * 60_000;
const BARS_FROM = '2015-01-02';
const BARS_TO = '2025-07-01'; // horizons extend past window end (2024-12-31 + 120td)
const CHUNK = 4000;

interface CarRow {
  id: string;
  type: 'E1' | 'E2' | 'E3';
  ticker: string;
  date: string;
  sizeBucket: 'LARGE' | 'MID' | 'SMALL';
  sector: string | null;
  agreement: boolean;
  car: number;
  delisted: boolean;
  quadrant: string;
  fNoData: string[];
  amihud63: number | null;
  fscore: number | null;
  routineScreen: string | null;
}

const HORIZON: Record<CarRow['type'], number> = {
  E1: VALIDATION.h1.horizonTd,
  E2: VALIDATION.h2.horizonTd,
  E3: VALIDATION.h3.horizonTd,
};

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-validate-background' });
  const started = Date.now();

  let body: { runId?: string; resume?: boolean } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* below */ }
  const runId = body.runId;
  if (!runId || !/^vrun_[a-z0-9_]{4,60}$/i.test(runId)) {
    return { statusCode: 400, body: JSON.stringify({ ok: false, error: 'runId required (vrun_...)' }) };
  }
  const JOB = `validate-${runId}`;
  const db = getAdminDb();
  const runRef = db.collection(VECTOR_COLLECTIONS.runs).doc(runId);
  const prior = body.resume ? await readCheckpoint(JOB) : null;

  const cp: VectorCheckpoint = prior ?? {
    job: JOB,
    status: 'running',
    cursor: { phase: 'cars', tickerIdx: 0, chunkN: 0, pending: [] },
    counters: { carRows: 0, skippedNoBars: 0, tickersDone: 0 },
    startedAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    invocations: 0,
  };
  cp.invocations++;
  cp.status = 'running';
  cp.heartbeatAt = new Date().toISOString();
  await writeCheckpoint(cp);

  try {
    if (!prior) {
      await runRef.set({
        runId, status: 'running', modelVersion: VECTOR_MODEL_VERSION,
        window: VALIDATION.window, startedAt: new Date().toISOString(),
      }, { merge: true });
    }

    // Benchmarks once per invocation.
    const spy = (await getDailyBarsClamped('SPY', BARS_FROM, BARS_TO)).bars as unknown as StudyBar[];
    const iwm = (await getDailyBarsClamped('IWM', BARS_FROM, BARS_TO)).bars as unknown as StudyBar[];
    if (spy.length < 500 || iwm.length < 500) throw new Error('benchmark series too thin');

    // ---------------- phase: cars ----------------
    if (cp.cursor.phase === 'cars') {
      // Event index grouped by ticker (built once, kept in the checkpoint).
      let tickers = cp.cursor.tickers as string[] | undefined;
      if (!tickers) {
        // Range on a single field only — no composite needed.
        const snap = await db.collection(VECTOR_COLLECTIONS.events)
          .where('date', '>=', VALIDATION.window.start)
          .where('date', '<=', VALIDATION.window.end)
          .select('ticker', 'date').get();
        const set = new Set<string>();
        for (const d of snap.docs) set.add((d.data() as any).ticker);
        tickers = [...set].sort();
        cp.cursor.tickers = tickers;
        cp.counters.eventTickers = tickers.length;
        await writeCheckpoint(cp);
        if (!tickers.length) throw new Error('no events in window — run the backfills first');
      }

      let i = cp.cursor.tickerIdx as number;
      let pending: CarRow[] = (cp.cursor.pending as CarRow[]) ?? [];

      const flush = async (force = false) => {
        while (pending.length >= CHUNK || (force && pending.length)) {
          const take = pending.slice(0, CHUNK);
          pending = pending.slice(CHUNK);
          await runRef.collection('cars').doc(String(cp.cursor.chunkN)).set({ rows: take });
          cp.cursor.chunkN = (cp.cursor.chunkN as number) + 1;
          cp.counters.carRows += take.length;
        }
      };

      for (; i < tickers.length && Date.now() - started < BUDGET_MS; i++) {
        const ticker = tickers[i];
        // Composite-index-free: equality-only fetch, window-filter in
        // memory (equality + range on different fields needs a composite
        // index Firestore doesn't have — audit finding, would have
        // FAILED_PRECONDITION'd every validation run).
        const evSnapAll = await db.collection(VECTOR_COLLECTIONS.events)
          .where('ticker', '==', ticker).get();
        const evDocs = evSnapAll.docs.filter((d) => {
          const dt = (d.data() as any).date as string;
          return dt >= VALIDATION.window.start && dt <= VALIDATION.window.end;
        });
        if (!evDocs.length) { cp.counters.tickersDone++; continue; }

        let bars: StudyBar[];
        try {
          bars = (await getDailyBarsClamped(ticker, BARS_FROM, BARS_TO)).bars as unknown as StudyBar[];
        } catch (err) {
          cp.counters.skippedNoBars++;
          log.warn('bars_failed', { ticker, err: String((err as Error)?.message ?? err) });
          continue; // no CAR rows fabricated for this name
        }
        if (bars.length < 30) { cp.counters.skippedNoBars++; continue; }

        for (const doc of evDocs) {
          const e = doc.data() as any;
          const bench = e.sizeBucket === 'LARGE' ? spy : iwm;
          const res = carForEvent(bars, bench, e.date, HORIZON[e.type as CarRow['type']], e.sizeBucket);
          if (!res) continue;

          const f = e.features ?? {};
          const fr = scoreFAxis({
            fscore: f.fscore ?? null,
            latestSue: e.type === 'E1' ? (e.payload?.sue ?? null) : null,
            consecutivePositiveSue: 0,
            insiderNet90d: f.insiderNet90d ?? null,
            sellCluster: e.payload?.sellCluster === true,
            instDelta: f.instDelta ?? null,
          });
          const tr = scoreTAxis({
            close: f.close ?? 0,
            sma50: f.sma50 ?? null,
            sma200: f.sma200 ?? null,
            extension: f.extension ?? null,
            contraction: f.contraction ?? null,
            regime: null,
            drawdown: f.drawdown ?? null,
            ema20: f.ema20 ?? null,
            higherFiveDayLow: f.higherFiveDayLow ?? null,
          });

          pending.push({
            id: doc.id,
            type: e.type,
            ticker,
            date: e.date,
            sizeBucket: e.sizeBucket,
            sector: e.sector ?? null,
            agreement: e.agreement === true,
            car: res.car,
            delisted: res.delisted,
            quadrant: quadrantOf(fr.verdict, tr.verdict),
            fNoData: fr.noData,
            amihud63: f.amihud63 ?? null,
            fscore: f.fscore ?? null,
            routineScreen: e.payload?.routineScreen ?? null,
          });
        }
        cp.counters.tickersDone++;
        await flush();
        if (i % 10 === 0) {
          cp.cursor.tickerIdx = i + 1;
          cp.cursor.pending = pending;
          cp.heartbeatAt = new Date().toISOString();
          await writeCheckpoint(cp);
        }
      }

      cp.cursor.tickerIdx = i;
      if (i >= tickers.length) {
        await flush(true);
        cp.cursor.pending = [];
        cp.cursor.phase = 'verdicts';
      } else {
        cp.cursor.pending = pending;
      }
      cp.heartbeatAt = new Date().toISOString();
      await writeCheckpoint(cp);
      if (cp.cursor.phase === 'cars') {
        await reinvoke('vector-validate-background', { runId, resume: true });
        return { statusCode: 200, body: JSON.stringify({ ok: true, runId, phase: 'cars', tickerIdx: i, counters: cp.counters }) };
      }
    }

    // Load all car rows (verdicts + sim both need them).
    const chunkSnap = await runRef.collection('cars').get();
    const rows: CarRow[] = [];
    for (const c of chunkSnap.docs) rows.push(...((c.data().rows ?? []) as CarRow[]));

    // ---------------- phase: verdicts ----------------
    if (cp.cursor.phase === 'verdicts') {
      const e1 = rows.filter((r) => r.type === 'E1');
      const e2 = rows.filter((r) => r.type === 'E2');
      const e3 = rows.filter((r) => r.type === 'E3');

      // H1: E1 agreement cohort, MID+SMALL pooled.
      const h1Sample = e1.filter((r) => r.agreement && r.sizeBucket !== 'LARGE').map((r) => r.car);
      const h1 = sampleStats(h1Sample);
      const h1Pass = !!h1 && h1.mean > 0 && h1.t >= VALIDATION.h1.minT;

      // H2: E2 cluster-in-drawdown (all E2 events are drawdown-gated), all buckets.
      const h2 = sampleStats(e2.map((r) => r.car));
      const h2Pass = !!h2 && h2.mean > 0 && h2.t >= VALIDATION.h2.minT;

      // H3: E3 13D initiations.
      const h3 = sampleStats(e3.map((r) => r.car));
      const h3Pass = !!h3 && h3.mean > 0 && h3.t >= VALIDATION.h3.minT;

      // H4: within E1, PRIME minus PASS.
      const h4w = welchT(
        e1.filter((r) => r.quadrant === 'PRIME').map((r) => r.car),
        e1.filter((r) => r.quadrant === 'PASS').map((r) => r.car),
      );
      const h4Pass = !!h4w && h4w.diff > 0 && h4w.t >= VALIDATION.h4.minT;

      // H5a: E1 CAR monotone across amihud terciles + smallest-vs-largest t.
      const [lo, mid, hi] = terciles(e1, (r) => r.amihud63);
      const mLo = sampleStats(lo.map((r) => r.car));
      const mMid = sampleStats(mid.map((r) => r.car));
      const mHi = sampleStats(hi.map((r) => r.car));
      // amihud high = MOST illiquid — the diffusion-lag story predicts CAR
      // increases with illiquidity: monotone increasing lo->hi.
      const h5aMono = mLo && mMid && mHi
        ? monotone([mLo.mean, mMid.mean, mHi.mean]) === 'increasing'
        : false;
      const h5aT = welchT(hi.map((r) => r.car), lo.map((r) => r.car));
      const h5aPass = h5aMono && !!h5aT && h5aT.t >= VALIDATION.h5.minT;

      // H5b: E2 fscore>=7 minus fscore<=3.
      const h5bT = welchT(
        e2.filter((r) => (r.fscore ?? -1) >= 7).map((r) => r.car),
        e2.filter((r) => r.fscore != null && r.fscore <= 3).map((r) => r.car),
      );
      const h5bPass = !!h5bT && h5bT.diff > 0 && h5bT.t >= VALIDATION.h5.minT;
      const h5Pass = h5aPass && h5bPass;

      cp.cursor.verdicts = {
        h1: { stats: h1, pass: h1Pass },
        h2: { stats: h2, pass: h2Pass },
        h3: { stats: h3, pass: h3Pass },
        h4: { welch: h4w, pass: h4Pass },
        h5: {
          amihud: { lo: mLo, mid: mMid, hi: mHi, spread: h5aT, monotone: h5aMono, pass: h5aPass },
          fscore: { welch: h5bT, pass: h5bPass },
          pass: h5Pass,
        },
        triggers: {
          E1: h1Pass ? 'TRADE_THE_TRIGGER' : 'NO_EDGE',
          E2: h2Pass ? 'TRADE_THE_TRIGGER' : 'NO_EDGE',
          E3: h3Pass ? 'TRADE_THE_TRIGGER' : 'NO_EDGE',
        },
      };
      cp.cursor.phase = 'sim';
      cp.heartbeatAt = new Date().toISOString();
      await writeCheckpoint(cp);
      await runRef.set({ verdicts: cp.cursor.verdicts, carRows: rows.length }, { merge: true });
    }

    // ---------------- phase: sim ----------------
    if (cp.cursor.phase === 'sim') {
      const verdicts = cp.cursor.verdicts as any;
      const validated: ('E1' | 'E2' | 'E3')[] = (['E1', 'E2', 'E3'] as const)
        .filter((t) => verdicts?.triggers?.[t] === 'TRADE_THE_TRIGGER');

      let book: any = { status: 'NO_EDGE', note: 'no validated triggers — book sim not applicable' };
      if (validated.length) {
        // Book trades validated triggers only; E1 means agreement events.
        const simEvents: SimEvent[] = rows
          .filter((r) => validated.includes(r.type) && (r.type !== 'E1' || r.agreement))
          .map((r) => ({ ticker: r.ticker, date: r.date, type: r.type, sizeBucket: r.sizeBucket, sector: r.sector }));

        const distinct = [...new Set(simEvents.map((e) => e.ticker))];
        if (distinct.length > 4000) {
          throw new Error(`book sim needs ${distinct.length} ticker series — beyond one invocation; shard the sim (finding, not silently sampled)`);
        }
        const barsByTicker = new Map<string, StudyBar[]>();
        for (const t of distinct) {
          if (Date.now() - started > BUDGET_MS) {
            // Not enough budget to finish loading: reinvoke and retry the sim
            // phase from scratch (loads are idempotent).
            await writeCheckpoint(cp);
            await reinvoke('vector-validate-background', { runId, resume: true });
            return { statusCode: 200, body: JSON.stringify({ ok: true, runId, phase: 'sim-loading' }) };
          }
          try {
            barsByTicker.set(t, (await getDailyBarsClamped(t, BARS_FROM, BARS_TO)).bars as unknown as StudyBar[]);
          } catch { /* missing series: sim skips entries it can't price */ }
        }
        const sim = runVectorSim(simEvents, barsByTicker, iwm);
        const pass = sim.activeReturnPp > 0 && sim.tActiveDaily >= VALIDATION.book.minT;
        book = { status: pass ? 'TRADE_THE_BOOK' : 'NO_EDGE', validatedTriggers: validated, ...sim };
        // Equity curve kept small (5-day sampling) but cap the doc anyway.
        if (book.equityCurve?.length > 800) book.equityCurve = book.equityCurve.filter((_: any, i: number) => i % 2 === 0);
      }

      await runRef.set({
        book, status: 'complete', completedAt: new Date().toISOString(),
      }, { merge: true });
      cp.status = 'complete';
      cp.completedAt = new Date().toISOString();
      cp.heartbeatAt = new Date().toISOString();
      await writeCheckpoint(cp);
      log.info('validation_complete', { runId, carRows: rows.length });
      return { statusCode: 200, body: JSON.stringify({ ok: true, runId, status: 'complete' }) };
    }

    return { statusCode: 200, body: JSON.stringify({ ok: true, runId, phase: cp.cursor.phase }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    cp.status = 'failed';
    cp.error = msg;
    cp.heartbeatAt = new Date().toISOString();
    await writeCheckpoint(cp).catch(() => {});
    await runRef.set({ status: 'failed', error: msg }, { merge: true }).catch(() => {});
    log.error('validation_failed', { runId, err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, runId, error: msg }) };
  }
};
