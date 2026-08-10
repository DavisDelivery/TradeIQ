// P1-S3 — consensus archive worker.
//
// One Firestore doc per trading day holding the whole cross-section, written
// with create(). One doc per day is ~250/year and a revision study reads two
// of them; one doc per TICKER per day would be ~500k/year for the same
// information and would make the diff a query instead of a read.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { fetchFinvizScreener, FINVIZ_UNIVERSE_FILTERS } from './shared/finviz';
import { buildConsensusSnapshot, CONSENSUS_COLLECTION } from './shared/consensus-archive';
import { etTradingDate } from './shared/forward-test';
import { logger } from './shared/logger';

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'archive-consensus-background' });
  const date = etTradingDate();

  try {
    const parts = await Promise.all([
      fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS.sp500]),
      fetchFinvizScreener([FINVIZ_UNIVERSE_FILTERS.russell2k]),
    ]);
    if (parts.every((p) => p === null)) {
      // Never write an empty day. A zero-count record is indistinguishable
      // afterwards from "consensus covered nothing", and it is permanent.
      log.error('universe_fetch_failed', { date });
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'universe fetch failed' }) };
    }

    const rows = parts.flatMap((p) => p?.rows ?? []);
    const snapshot = buildConsensusSnapshot(rows, date, new Date().toISOString());
    if (snapshot.count === 0) {
      log.error('empty_cross_section', { date, rows: rows.length });
      return { statusCode: 502, body: JSON.stringify({ ok: false, error: 'empty cross-section' }) };
    }

    const ref = getAdminDb().collection(CONSENSUS_COLLECTION).doc(date);
    try {
      // create() — the first write of a day is permanent. A re-run must not
      // overwrite the morning's observation with the evening's, and nothing
      // may edit it once returns are knowable.
      await ref.create(snapshot as unknown as Record<string, unknown>);
    } catch (err: any) {
      if (String(err?.code) === '6' || /already exists/i.test(String(err?.message ?? err))) {
        log.info('already_archived', { date });
        return {
          statusCode: 200,
          body: JSON.stringify({ ok: true, date, skipped: 'already-archived' }),
        };
      }
      throw err;
    }

    log.info('archived', { date, count: snapshot.count });
    return { statusCode: 200, body: JSON.stringify({ ok: true, date, count: snapshot.count }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('archive_consensus_failed', { date, err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
