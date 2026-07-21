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
      // Clear any stale fatal/degraded from a prior failed run — this run
      // reached the success path, so the doc must not still read "fatal".
      fatal: null,
      degraded: false,
    }, { merge: true }).catch(() => {});

    log.info('watch_done', { daysProcessed, stored, errors: errors.length, ms: Date.now() - started });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, daysProcessed, stored, errors }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    // SEC EDGAR persistently WAF-blocks datacenter egress IPs (403) even with
    // a compliant User-Agent + backoff ladder — the CIK-map fetch is the
    // usual casualty. That's an external-infra condition, not a bug in our
    // code, so record it as DEGRADED (warn, no Sentry page / no 5xx) instead
    // of a hard error. A genuinely unexpected failure still pages.
    const edgarBlocked = /\b403\b|forbidden|\bwaf\b|rate.?threshold|sec\.gov|edgar/i.test(msg);
    if (edgarBlocked) {
      log.warn('watch_degraded_edgar_blocked', { err: msg });
    } else {
      log.error('watch_failed', { err: msg });
    }
    // Fatal path must still be visible from ?smartmoney=1 — write to _meta.
    try {
      await getAdminDb().collection(ACTIVIST_COLLECTION).doc('_meta').set({
        lastRunAt: new Date().toISOString(),
        backfillDays,
        daysProcessed: 0,
        stored: 0,
        fatal: msg.slice(0, 200),
        degraded: edgarBlocked,
      }, { merge: true });
    } catch { /* firestore down too — nothing left to do */ }
    // 200 on the known EDGAR block so Netlify doesn't flag a function failure
    // and the scheduler keeps retrying quietly; 500 only for real faults.
    return { statusCode: edgarBlocked ? 200 : 500, body: JSON.stringify({ ok: !edgarBlocked ? false : true, degraded: edgarBlocked, error: msg }) };
  }
};
