// VECTOR — live event feed.
//
// GET /api/vector-feed?limit=50&type=all|E1|E2|E3
//
// Newest events first from vector_events. E1 rows only surface when the
// agreement trigger fired (the design's live display trigger); E2/E3
// events are display-worthy by construction. Every card's cohort line is
// fetched separately via /api/vector-cohort so the feed stays cheap.

import type { Handler } from '@netlify/functions';
import { VECTOR_COLLECTIONS } from './shared/vector-store';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'vector-feed' });

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

// Cap on how many display-worthy rows we pull per event kind. Displayable
// events are rare (E1 only when agreement fired; E2/E3 by construction), so
// the whole library fits well under this — the fetch stays cheap.
const SCAN_CAP = 1500;

const mapDoc = (d: FirebaseFirestore.QueryDocumentSnapshot) => {
  const e = d.data() as any;
  return {
    id: d.id, type: e.type, ticker: e.ticker, date: e.date,
    sizeBucket: e.sizeBucket, sector: e.sector ?? null,
    agreement: e.agreement ?? null, payload: e.payload ?? {},
    features: {
      // The card renders pillar bars from a compact feature slice.
      sma50: e.features?.sma50 ?? null,
      sma200: e.features?.sma200 ?? null,
      close: e.features?.close ?? null,
      extension: e.features?.extension ?? null,
      drawdown: e.features?.drawdown ?? null,
    },
  };
};

export const handler: Handler = async (event) => {
  const qp = event.queryStringParameters ?? {};
  const limit = Math.min(200, Math.max(1, parseInt(qp.limit ?? '50', 10) || 50));
  const type = qp.type && ['E1', 'E2', 'E3'].includes(qp.type) ? qp.type : null;

  try {
    const db = getAdminDb();
    const col = db.collection(VECTOR_COLLECTIONS.events);

    // Query the DISPLAY-WORTHY events directly instead of over-fetching the
    // newest-by-date and filtering. Agreement E1 events are scattered across
    // the whole history, so a newest-N window almost never contains one —
    // that was the "board shows nothing" bug. Each query below is a single
    // equality filter (auto-indexed; NO composite index needed); we sort by
    // date in memory.
    const queries: FirebaseFirestore.Query[] = [];
    if (!type || type === 'E1') {
      // E1 surfaces only when the agreement trigger fired.
      queries.push(col.where('agreement', '==', true).limit(SCAN_CAP));
    }
    if (!type || type === 'E2') queries.push(col.where('type', '==', 'E2').limit(SCAN_CAP));
    if (!type || type === 'E3') queries.push(col.where('type', '==', 'E3').limit(SCAN_CAP));

    const snaps = await Promise.all(queries.map((q) => q.get()));
    const seen = new Set<string>();
    const events = snaps
      .flatMap((s) => s.docs)
      .map(mapDoc)
      // 'agreement==true' is E1-only in practice, but guard against a stray
      // non-E1 doc carrying the flag, and de-dupe across the merged queries.
      .filter((e) => (type ? e.type === type : true))
      .filter((e) => (e.type === 'E1' ? e.agreement === true : true))
      .filter((e) => (seen.has(e.id) ? false : (seen.add(e.id), true)))
      .sort((a, b) => String(b.date).localeCompare(String(a.date)))
      .slice(0, limit);

    return json(200, { ok: true, events, count: events.length, generatedAt: new Date().toISOString() });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('feed_failed', { err: msg });
    return json(500, { ok: false, error: msg });
  }
};
