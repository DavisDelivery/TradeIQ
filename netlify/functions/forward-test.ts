// GET /api/forward-test            → the league table (single-doc read)
// GET /api/forward-test?board=trident[&status=open|matured][&limit=100]
//                                   → that board's pick log, best alpha first
//
// Read side of the forward test (see shared/forward-test.ts). The league is
// precomputed by the nightly run; per-board pick lists query the cohort
// directly (bounded per board: ≤ ~20 new entries/night).

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { FORWARD_COLLECTION, LEAGUE_DOC_ID, type ForwardPick } from './shared/forward-test';
import { logger } from './shared/logger';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const board = (qs.board ?? '').trim();
  const status = qs.status === 'open' || qs.status === 'matured' ? qs.status : null;
  const limit = Math.min(Number(qs.limit ?? 100), 500);
  const log = logger.child({ fn: 'forward-test', board: board || '(league)' });

  try {
    const db = getAdminDb();

    if (!board) {
      const doc = await db.collection(FORWARD_COLLECTION).doc(LEAGUE_DOC_ID).get();
      if (!doc.exists) {
        return json(200, {
          ok: true,
          league: [],
          totalPicks: 0,
          updatedAt: null,
          note: 'first nightly forward-test run has not completed yet',
        });
      }
      const data = doc.data() as any;
      return json(200, {
        ok: true,
        league: data.rows ?? [],
        totalPicks: data.totalPicks ?? 0,
        evalDate: data.evalDate ?? null,
        updatedAt: data.updatedAt ?? null,
      });
    }

    let q = db.collection(FORWARD_COLLECTION).where('board', '==', board);
    if (status) q = q.where('status', '==', status);
    const snap = await q.get();
    const picks = snap.docs
      .filter((d) => d.id !== LEAGUE_DOC_ID)
      .map((d) => d.data() as ForwardPick)
      .sort((a, b) => b.currentAlpha - a.currentAlpha)
      .slice(0, limit);
    log.info('served', { picks: picks.length });
    return json(200, { ok: true, board, picks });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('failed', { err: msg });
    return json(500, { ok: false, error: msg });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(body),
  };
}
