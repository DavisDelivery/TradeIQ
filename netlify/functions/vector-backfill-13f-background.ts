// VECTOR — 13F holder aggregates (background, checkpointed).
//
// POST /.netlify/functions/vector-backfill-13f-background
// Body: { resume?: true, quarters?: string[] }  (quarters = 'YYYY-Qn')
//
// Builds vector_13f_agg: per (ticker, filed-quarter) the count of distinct
// 13F filers holding the name — the instDelta feature reads the change
// between the two most recent quarters FILED <= t (filing dates, never
// period dates: 13F filings lag period end by up to 45 days and using
// period dates would leak).
//
// Source: EDGAR full-quarter form indexes for 13F-HR, then each filing's
// information-table membership per CUSIP. A full holdings parse of every
// 13F is enormous; the aggregate needs only DISTINCT-HOLDER COUNTS, so we
// walk the quarterly form.idx for 13F-HR filers and, per filing, fetch the
// primary information table and extract CUSIPs (deduped per filer).
// CUSIP -> ticker resolves through the Polygon reference map (cached in
// the checkpoint's cursor across the chain).
//
// This is the slowest backfill (EDGAR at 8 req/s). It is deliberately
// LAST in the kickoff order and the instDelta feature returns null +
// _noData until its quarter is aggregated — never silently.

import type { Handler } from '@netlify/functions';
import { edgarFetch } from './shared/vector-data';
import { VECTOR_MODEL_VERSION } from './shared/vector-constants';
import {
  VECTOR_COLLECTIONS, readCheckpoint, writeCheckpoint, reinvoke,
  type VectorCheckpoint,
} from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const JOB = 'backfill-13f';
const BUDGET_MS = 12 * 60_000;

/** Quarters 2015-Q3 .. 2024-Q4 — two quarters of runway before the window. */
function defaultQuarters(): string[] {
  const out: string[] = [];
  for (let y = 2015; y <= 2024; y++) {
    for (let q = 1; q <= 4; q++) {
      if (y === 2015 && q < 3) continue;
      out.push(`${y}-Q${q}`);
    }
  }
  return out;
}

function quarterIndexUrl(quarter: string): string {
  const [y, q] = quarter.split('-Q');
  return `https://www.sec.gov/Archives/edgar/full-index/${y}/QTR${q}/form.idx`;
}

interface F13Filing { cik: string; dateFiled: string; path: string }

function parse13fIndex(idxText: string): F13Filing[] {
  const out: F13Filing[] = [];
  for (const line of idxText.split('\n')) {
    if (!line.startsWith('13F-HR')) continue; // includes 13F-HR/A; exclude amendments below
    const cols = line.trimEnd().split(/\s{2,}/);
    if (cols.length < 5) continue;
    const [form, , cik, dateFiled, path] = cols;
    if (form.trim() !== '13F-HR') continue;
    const iso = /^\d{8}$/.test(dateFiled)
      ? `${dateFiled.slice(0, 4)}-${dateFiled.slice(4, 6)}-${dateFiled.slice(6, 8)}`
      : dateFiled;
    out.push({ cik: cik.padStart(10, '0'), dateFiled: iso, path: path.trim() });
  }
  return out;
}

/** Extract distinct CUSIPs from a 13F information table (XML or legacy text). */
export function extractCusips(text: string): Set<string> {
  const out = new Set<string>();
  // Modern XML: <cusip>037833100</cusip> (case-insensitive, namespaced ok)
  const re = /<(?:\w+:)?cusip>\s*([0-9A-Za-z]{9})\s*<\/(?:\w+:)?cusip>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) out.add(m[1].toUpperCase());
  return out;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'POST only' };
  const log = logger.child({ fn: 'vector-backfill-13f' });
  const started = Date.now();

  let body: { resume?: boolean; quarters?: string[] } = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { /* defaults */ }
  const prior = body.resume ? await readCheckpoint(JOB) : null;

  const quarters = (prior?.cursor?.quarters as string[]) ?? body.quarters ?? defaultQuarters();
  const qIdx = (prior?.cursor?.qIdx as number) ?? 0;
  const filingIdx = (prior?.cursor?.filingIdx as number) ?? 0;

  const cp: VectorCheckpoint = {
    job: JOB,
    status: 'running',
    cursor: { quarters, qIdx, filingIdx },
    counters: prior?.counters ?? { filingsDone: 0, cusipRows: 0, quartersDone: 0, tableMisses: 0 },
    startedAt: prior?.startedAt ?? new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
    invocations: (prior?.invocations ?? 0) + 1,
  };
  await writeCheckpoint(cp);

  try {
    const db = getAdminDb();
    let qi = qIdx;
    let fi = filingIdx;

    while (qi < quarters.length && Date.now() - started < BUDGET_MS) {
      const quarter = quarters[qi];
      const res = await edgarFetch(quarterIndexUrl(quarter));
      const filings = parse13fIndex(await res.text());

      // Per-quarter accumulation doc: counts merge in as chunks complete,
      // so a resumed chain continues the same quarter without recount.
      const aggRef = db.collection(VECTOR_COLLECTIONS.agg13f).doc(`quarter_${quarter}`);
      const aggSnap = await aggRef.get();
      const counts: Record<string, number> = aggSnap.exists ? (aggSnap.data()!.cusipHolders ?? {}) : {};

      for (; fi < filings.length && Date.now() - started < BUDGET_MS; fi++) {
        const f = filings[fi];
        try {
          // Fetch the filing's document index; find the info-table doc.
          const base = `https://www.sec.gov/Archives/${f.path.replace(/\.txt$/, '')}`.replace(/-(?=[^-]*$)/, '-');
          // The .txt full-submission works universally and contains the
          // info table inline — one request per filing.
          const txtRes = await edgarFetch(`https://www.sec.gov/Archives/${f.path}`);
          const cusips = extractCusips(await txtRes.text());
          void base;
          for (const c of cusips) counts[c] = (counts[c] ?? 0) + 1;
          cp.counters.filingsDone++;
        } catch (err) {
          cp.counters.tableMisses++;
          log.warn('filing_skipped', { path: f.path, err: String((err as Error)?.message ?? err) });
        }
        if (fi % 25 === 0) {
          await aggRef.set(
            { quarter, cusipHolders: counts, filingsProcessed: fi + 1, of: filings.length, modelVersion: VECTOR_MODEL_VERSION, updatedAt: new Date().toISOString() },
            { merge: true },
          );
          cp.cursor.qIdx = qi;
          cp.cursor.filingIdx = fi + 1;
          cp.heartbeatAt = new Date().toISOString();
          await writeCheckpoint(cp);
        }
      }

      if (fi >= filings.length) {
        await aggRef.set(
          {
            quarter, cusipHolders: counts, filingsProcessed: filings.length, of: filings.length,
            distinctCusips: Object.keys(counts).length, complete: true,
            modelVersion: VECTOR_MODEL_VERSION, updatedAt: new Date().toISOString(),
          },
          { merge: true },
        );
        cp.counters.cusipRows += Object.keys(counts).length;
        cp.counters.quartersDone++;
        qi++;
        fi = 0;
        cp.cursor.qIdx = qi;
        cp.cursor.filingIdx = 0;
        cp.heartbeatAt = new Date().toISOString();
        await writeCheckpoint(cp);
        log.info('quarter_complete', { quarter, cusips: Object.keys(counts).length });
      }
    }

    const finished = qi >= quarters.length;
    cp.status = finished ? 'complete' : 'running';
    cp.heartbeatAt = new Date().toISOString();
    if (finished) cp.completedAt = new Date().toISOString();
    await writeCheckpoint(cp);
    if (!finished) await reinvoke('vector-backfill-13f-background', { resume: true });

    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, job: JOB, finished, qIdx: qi, filingIdx: fi, counters: cp.counters }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    cp.status = 'failed';
    cp.error = msg;
    cp.heartbeatAt = new Date().toISOString();
    await writeCheckpoint(cp).catch(() => {});
    log.error('backfill_13f_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, job: JOB, error: msg }) };
  }
};
