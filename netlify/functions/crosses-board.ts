// GET /api/crosses?type=golden|death|all&days=365&limit=500
//
// Serves the nightly crosses snapshot (scan-crosses-sp500.ts). Snapshot-only:
// the scan refetches ~650 days of bars per ticker, which is never viable
// inline — a missing/stale snapshot serves what exists with a stale flag
// rather than attempting a live scan.

import type { Handler } from '@netlify/functions';
import {
  isSnapshotFresh,
  latestSnapshot,
  snapshotAgeMs,
} from './shared/snapshot-store';
import type { CrossRow } from './shared/cross-detect';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'crosses-board' });

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const qp = event.queryStringParameters ?? {};
  const type = (qp.type ?? 'all') as 'golden' | 'death' | 'all';
  const days = Math.min(380, Math.max(1, parseInt(qp.days ?? '365', 10) || 365));
  const limit = Math.min(1000, Math.max(1, parseInt(qp.limit ?? '500', 10) || 500));

  try {
    const snap = await latestSnapshot('crosses', 'sp500');
    if (!snap) {
      log.warn('no_snapshot');
      return json(200, {
        ok: true, rows: [], universeChecked: 0, generatedAt: null, stale: true,
        note: 'no crosses snapshot yet — first scheduled scan has not completed',
      });
    }

    const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
    let rows = (snap.results as CrossRow[]).filter((r) => r.date >= cutoff);
    if (type !== 'all') rows = rows.filter((r) => r.type === type);

    const stale = !isSnapshotFresh(snap);
    log.info('response', {
      status: 200, rows: rows.length, type, days, stale,
      ageMs: snapshotAgeMs(snap), durationMs: Date.now() - start,
    });
    return json(200, {
      ok: true,
      rows: rows.slice(0, limit),
      totalInWindow: rows.length,
      universeChecked: snap.universeChecked,
      generatedAt: snap.generatedAt,
      modelVersion: snap.modelVersion,
      ...(stale ? { stale: true } : {}),
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('failed', { err: msg, durationMs: Date.now() - start });
    return json(500, { ok: false, error: msg });
  }
};
