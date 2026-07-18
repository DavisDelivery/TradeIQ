// GET /api/trident-board?universe=sp500|russell2k&limit=40
//
// Snapshot-first reader (serve-stale, never inline-scan — the M1 pattern).
// The response carries the rows AND the regime panel payload (NQ/SPX/R2K)
// from the same snapshot, plus the standing screener disclosure.

import type { Handler } from '@netlify/functions';
import { latestSnapshot, isSnapshotFresh, snapshotAgeMs } from './shared/snapshot-store';
import { getAdminDb } from './shared/firebase-admin';
import { ACTIVIST_COLLECTION } from './shared/trident/institutional';
import { logger } from './shared/logger';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const universe = qs.universe === 'russell2k' ? 'russell2k' : 'sp500';
  const limit = Math.min(Math.max(Number(qs.limit) || 40, 1), 200);
  const log = logger.child({ fn: 'trident-board', universe });

  // Observability: ?smartmoney=1 lists the stored activist events (the
  // watcher's Firestore output) so feed health is checkable without
  // Firestore console access.
  if (qs.smartmoney === '1') {
    try {
      const db = getAdminDb();
      const [snap, meta] = await Promise.all([
        db.collection(ACTIVIST_COLLECTION).orderBy('filedAt', 'desc').limit(50).get(),
        db.collection(ACTIVIST_COLLECTION).doc('_meta').get(),
      ]);
      const events = snap.docs.map((d) => d.data()).filter((e: any) => e.ticker);
      return json(200, { ok: true, count: events.length, watcher: meta.exists ? meta.data() : null, events });
    } catch (err: any) {
      return json(500, { ok: false, error: String(err?.message ?? err) });
    }
  }

  try {
    const snap = await latestSnapshot('trident', universe);
    if (!snap) {
      return json(200, {
        ok: true, universe, rows: [], regime: null,
        source: 'snapshot-missing',
        note: 'first TRIDENT scan has not completed yet',
      });
    }
    const fresh = isSnapshotFresh(snap);
    const rows = Array.isArray(snap.results) ? (snap.results as any[]).slice(0, limit) : [];
    log.info('served', { rows: rows.length, fresh });
    return json(200, {
      ok: true,
      universe,
      generatedAt: snap.generatedAt,
      ageMs: snapshotAgeMs(snap),
      stale: !fresh,
      source: fresh ? 'snapshot' : 'snapshot-stale',
      universeChecked: snap.universeChecked,
      universeSize: (snap as any).universeSize ?? null,
      stage1Survivors: (snap as any).stage1Survivors ?? null,
      regime: (snap as any).regime ?? null,
      warnings: snap.warnings ?? [],
      rows,
      disclosure:
        'TRIDENT is a labelled screener: the pre-committed backtest (reports/trident/design.md §5) has not yet stamped a verdict. Discipline: 21-63 trading day horizon, stops per entry card, regime gate applies.',
    });
  } catch (err: any) {
    log.error('trident_board_failed', { err: String(err?.message ?? err) });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
    body: JSON.stringify(body),
  };
}
