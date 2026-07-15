// VECTOR — cohort library query API.
//
// GET /api/vector-cohort?type=E1&dim1=sizeBucket:SMALL&dim2=amihudTercile:high
//
// Serves the measured forward-CAR distribution for a cohort of historical
// events, from the latest COMPLETE validation run's car rows. Guardrails
// per design: max 2 active dimensions, tercile/named buckets only,
// display floors — n >= 30 to show stats at all (below => "insufficient
// history"), wide-CI warning when n < 100. Beyond 2 dims the library
// becomes an overfitting machine with extra steps, so dim3+ is a 400.

import type { Handler } from '@netlify/functions';
import { sampleStats, terciles } from './shared/vector-study';
import { COHORT } from './shared/vector-constants';
import { VECTOR_COLLECTIONS } from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'vector-cohort' });

const DIMS = new Set(['sizeBucket', 'sector', 'quadrant', 'agreement', 'amihudTercile', 'fscoreBand', 'delisted']);

interface Row {
  type: string; sizeBucket: string; sector: string | null; quadrant: string;
  agreement: boolean; car: number; amihud63: number | null; fscore: number | null;
  delisted: boolean; date: string;
}

let cache: { runId: string; rows: Row[]; at: number } | null = null;
const CACHE_TTL = 10 * 60_000;

async function loadRows(): Promise<{ runId: string; rows: Row[] } | null> {
  if (cache && Date.now() - cache.at < CACHE_TTL) return cache;
  const db = getAdminDb();
  const runs = await db.collection(VECTOR_COLLECTIONS.runs)
    .where('status', '==', 'complete')
    .orderBy('completedAt', 'desc').limit(1).get();
  if (runs.empty) return null;
  const runId = runs.docs[0].id;
  const chunks = await runs.docs[0].ref.collection('cars').get();
  const rows: Row[] = [];
  for (const c of chunks.docs) rows.push(...((c.data().rows ?? []) as Row[]));
  cache = { runId, rows, at: Date.now() };
  return cache;
}

function matchDim(rows: Row[], dim: string, value: string): Row[] {
  switch (dim) {
    case 'sizeBucket': return rows.filter((r) => r.sizeBucket === value);
    case 'sector': return rows.filter((r) => (r.sector ?? '—') === value);
    case 'quadrant': return rows.filter((r) => r.quadrant === value);
    case 'agreement': return rows.filter((r) => r.agreement === (value === 'true'));
    case 'delisted': return rows.filter((r) => r.delisted === (value === 'true'));
    case 'fscoreBand':
      if (value === 'high') return rows.filter((r) => (r.fscore ?? -1) >= 7);
      if (value === 'mid') return rows.filter((r) => r.fscore != null && r.fscore >= 4 && r.fscore <= 6);
      return rows.filter((r) => r.fscore != null && r.fscore <= 3);
    case 'amihudTercile': {
      const [lo, mid, hi] = terciles(rows, (r) => r.amihud63);
      return value === 'low' ? lo : value === 'mid' ? mid : hi;
    }
    default: return rows;
  }
}

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const qp = event.queryStringParameters ?? {};
  const type = qp.type;
  if (!type || !['E1', 'E2', 'E3'].includes(type)) {
    return json(400, { ok: false, error: 'type=E1|E2|E3 required' });
  }
  const dims = [qp.dim1, qp.dim2].filter(Boolean) as string[];
  if (qp.dim3) return json(400, { ok: false, error: `max ${COHORT.maxActiveDimensions} active dimensions` });

  try {
    const lib = await loadRows();
    if (!lib) {
      return json(200, { ok: true, available: false, note: 'no complete validation run yet — the library is still being built' });
    }
    let rows = lib.rows.filter((r) => r.type === type);
    const applied: { dim: string; value: string }[] = [];
    for (const d of dims) {
      const [dim, value] = d.split(':');
      if (!DIMS.has(dim) || value == null) return json(400, { ok: false, error: `unknown dimension '${d}'` });
      rows = matchDim(rows, dim, value);
      applied.push({ dim, value });
    }

    if (rows.length < COHORT.minNForStats) {
      return json(200, {
        ok: true, available: true, runId: lib.runId, type, dims: applied,
        n: rows.length, insufficientHistory: true,
        note: `n=${rows.length} < ${COHORT.minNForStats} — insufficient history, no stats shown`,
      });
    }

    const stats = sampleStats(rows.map((r) => r.car))!;
    return json(200, {
      ok: true, available: true, runId: lib.runId, type, dims: applied,
      n: stats.n,
      wideCi: stats.n < COHORT.wideCiBelow,
      stats,
      cohortLine: `n=${stats.n} like this: median ${(stats.median * 100).toFixed(1)}% excess, ` +
        `${Math.round(stats.positiveShare * 100)}% positive, worst decile ${(stats.worstDecileMean * 100).toFixed(1)}%`,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('cohort_failed', { err: msg });
    return json(500, { ok: false, error: msg });
  }
};
