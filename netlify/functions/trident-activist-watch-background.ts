// TRIDENT Smart Money — 13D activist watcher worker.
//
// POST {} → process the last 3 calendar days' EDGAR daily form indexes
// (idempotent catch-up; the nightly index posts ~22:00 ET, weekends 404).
// POST {backfillDays: N} → walk N days back (one-shot seeding, N ≤ 120)
// so the axis isn't empty on day one. Events upsert into
// `tridentActivist/{accession}-{ticker}` — re-runs are no-ops.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { fetchDayEvents } from './shared/trident/activist-watch';
import { ACTIVIST_COLLECTION, getCachedCikTickerMap } from './shared/trident/institutional';
import { logger } from './shared/logger';

const MAX_BACKFILL_DAYS = 120;
const BUDGET_MS = 13 * 60_000;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'trident-activist-watch-background' });
  const started = Date.now();

  let backfillDays = 3;
  try {
    const body = event.body ? JSON.parse(event.body) : {};
    if (Number.isFinite(body.backfillDays)) {
      backfillDays = Math.min(Math.max(Number(body.backfillDays), 1), MAX_BACKFILL_DAYS);
    }
  } catch {
    /* defaults */
  }

  try {
    const db = getAdminDb();
    const cikMap = await getCachedCikTickerMap();
    log.info('watch_started', { backfillDays, cikMapSize: cikMap.size });

    let stored = 0;
    let daysProcessed = 0;
    const errors: string[] = [];
    for (let d = 1; d <= backfillDays; d++) {
      if (Date.now() - started > BUDGET_MS) {
        errors.push(`budget hit at day offset ${d}; re-fire with backfillDays=${backfillDays - d + 1} later`);
        break;
      }
      const date = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      try {
        const events = await fetchDayEvents(date, cikMap, log);
        for (const ev of events) {
          await db
            .collection(ACTIVIST_COLLECTION)
            .doc(`${ev.accession}-${ev.ticker}`)
            .set(ev, { merge: true });
          stored += 1;
        }
        daysProcessed += 1;
      } catch (err: any) {
        errors.push(`${date}: ${String(err?.message ?? err).slice(0, 100)}`);
      }
    }

    // Health doc — background responses are discarded, so the run's
    // outcome must land somewhere readable (?smartmoney=1 shows events;
    // this shows whether the WATCHER itself is running and what EDGAR did).
    await db.collection(ACTIVIST_COLLECTION).doc('_meta').set({
      lastRunAt: new Date().toISOString(),
      backfillDays,
      daysProcessed,
      stored,
      errors: errors.slice(0, 10),
    }, { merge: true }).catch(() => {});

    log.info('watch_done', { daysProcessed, stored, errors: errors.length, ms: Date.now() - started });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, daysProcessed, stored, errors }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('watch_failed', { err: msg });
    // Fatal path (e.g. the CIK-map fetch itself WAF-blocked) must still be
    // visible from ?smartmoney=1 — write the failure to _meta.
    try {
      await getAdminDb().collection(ACTIVIST_COLLECTION).doc('_meta').set({
        lastRunAt: new Date().toISOString(),
        backfillDays,
        daysProcessed: 0,
        stored: 0,
        fatal: msg.slice(0, 200),
      }, { merge: true });
    } catch { /* firestore down too — nothing left to do */ }
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
