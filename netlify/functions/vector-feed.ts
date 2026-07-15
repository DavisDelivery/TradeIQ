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

export const handler: Handler = async (event) => {
  const qp = event.queryStringParameters ?? {};
  const limit = Math.min(200, Math.max(1, parseInt(qp.limit ?? '50', 10) || 50));
  const type = qp.type && ['E1', 'E2', 'E3'].includes(qp.type) ? qp.type : null;

  try {
    const db = getAdminDb();
    // Composite-index-free: single-field orderBy only (where('type') +
    // orderBy('date') needs a composite index Firestore doesn't have).
    // Over-fetch and filter type in memory instead.
    const snap = await db.collection(VECTOR_COLLECTIONS.events)
      .orderBy('date', 'desc')
      .limit(type ? limit * 8 : limit * 3)
      .get();

    const events = snap.docs
      .map((d) => {
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
      })
      .filter((e) => (type ? e.type === type : true))
      // Display rule: E1 only when the agreement trigger fired.
      .filter((e) => e.type !== 'E1' || e.agreement === true)
      .slice(0, limit);

    return json(200, { ok: true, events, count: events.length, generatedAt: new Date().toISOString() });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('feed_failed', { err: msg });
    return json(500, { ok: false, error: msg });
  }
};
