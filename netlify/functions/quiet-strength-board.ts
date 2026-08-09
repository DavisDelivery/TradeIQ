// GET /api/quiet-strength-board?limit=40
//
// Snapshot-first reader (serve-stale, never inline-scan — the M1 pattern).
// The scan is ~160 provider calls, so an inline fallback is not merely slow,
// it would be a different and much worse thing than serving yesterday's.
//
// The response ALWAYS carries `banner`. It is lifted from the snapshot when
// one exists and rebuilt from the policy module when one does not, so there
// is no reachable code path — not snapshot-missing, not stale, not error —
// on which this endpoint returns rows without the evidence grade and the
// haircut attached to them.

import type { Handler } from '@netlify/functions';
import { latestSnapshot, isSnapshotFresh, snapshotAgeMs } from './shared/snapshot-store';
import { buildEvidenceBanner } from './shared/quiet-strength';
import { logger } from './shared/logger';

const BOARD = 'quiet-strength' as const;
const UNIVERSE = 'all' as const;

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const limit = Math.min(Math.max(Number(qs.limit) || 40, 1), 200);
  const log = logger.child({ fn: 'quiet-strength-board' });

  try {
    const snap = await latestSnapshot(BOARD, UNIVERSE);
    if (!snap) {
      return json(200, {
        ok: true,
        universe: UNIVERSE,
        rows: [],
        source: 'snapshot-missing',
        banner: buildEvidenceBanner(),
        note: 'first Quiet Strength scan has not completed yet',
      });
    }

    const fresh = isSnapshotFresh(snap);
    const rows = Array.isArray(snap.results) ? (snap.results as any[]).slice(0, limit) : [];
    log.info('served', { rows: rows.length, fresh });

    return json(200, {
      ok: true,
      universe: UNIVERSE,
      generatedAt: snap.generatedAt,
      ageMs: snapshotAgeMs(snap),
      stale: !fresh,
      source: fresh ? 'snapshot' : 'snapshot-stale',
      modelVersion: snap.modelVersion,
      universeChecked: snap.universeChecked,
      universeSize: (snap as any).universeSize ?? null,
      scored: (snap as any).scored ?? null,
      excludedCounts: (snap as any).excludedCounts ?? null,
      unscorableCounts: (snap as any).unscorableCounts ?? null,
      // Never null: a stored banner is preferred so the user sees the one the
      // rows were actually published under, but a snapshot written before
      // this field existed still gets the current policy's banner.
      banner: (snap as any).banner ?? buildEvidenceBanner(),
      exposure: (snap as any).exposure ?? null,
      factorLatestYm: (snap as any).factorLatestYm ?? null,
      scoringEndYm: (snap as any).scoringEndYm ?? null,
      returnBasis: (snap as any).returnBasis ?? 'price',
      warnings: snap.warnings ?? [],
      rows,
      disclosure:
        'Quiet Strength ranks residual momentum — the part of a stock\'s 12-1 move its ' +
        'Fama-French factor exposures do not explain. The sleeve rules (vol-scaled ' +
        'exposure, three staggered tranches, bear dimmer) exist to cut drawdown, not to ' +
        'raise return. The forward league scores the NAMES equal-weighted and therefore ' +
        'does not measure the sleeve.',
    });
  } catch (err: any) {
    log.error('quiet_strength_board_failed', { err: String(err?.message ?? err) });
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
