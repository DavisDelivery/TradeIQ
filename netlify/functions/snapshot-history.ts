// GET /api/snapshot-history
//
// Two modes (Phase 1 HistoryView replay surface):
//
//   ?board=X&universe=Y                       → list of available snapshot IDs
//                                               (newest first, capped at 60).
//   ?board=X&universe=Y&snapshotId=Z          → single full snapshot for replay.
//
// All board+universe pairs from the snapshot store are queryable. UI gates
// the picker to the boards that actually exist for a given universe.

import type { Handler } from '@netlify/functions';
import {
  listSnapshots,
  getSnapshotById,
  type BoardName,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';
import { SCREENS_BY_ID } from './shared/finviz-screens';

const VALID_BOARDS: BoardName[] = [
  'target-board',
  'prophet',
  'catalyst',
  'insider',
  'williams',
  'lynch',
  'earnings',
  // Boards added after the original picker (audit 2026-07-24): all four
  // write snapshots via the same store, so history/replay just works.
  'fable',
  'crosses',
  'trident',
  'sentiment',
  'screens',
  // QS-1. Registered here at the same time as the board itself — the
  // screens rollout is the cautionary tale (see
  // __tests__/snapshot-history-screens.test.ts): the board was added to the
  // union and the nightly worker wrote picks correctly, while every History
  // request 400'd in production because this list was never updated.
  'quiet-strength',
];

const VALID_UNIVERSES: UniverseKey[] = [
  'sp500',
  'ndx',
  'dow',
  'russell2k',
  'all',
  'core',
  'largecap',
];

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const board = qs.board as BoardName | undefined;
  const universe = qs.universe as UniverseKey | undefined;
  const snapshotId = qs.snapshotId;
  const limit = Math.min(Math.max(Number(qs.limit) || 60, 1), 200);

  const log = logger.child({ fn: 'snapshot-history', board, universe });

  if (!board || !VALID_BOARDS.includes(board)) {
    return json(400, { error: 'invalid or missing board' });
  }
  // FVZ-6 — the 'screens' board keys its snapshots by SCREEN ID rather than
  // by index name (one cohort per published strategy), so the index-name
  // allow-list would reject every valid screens request. Validate against
  // the screen catalog instead: still a closed set, just a different one.
  const universeAllowed =
    board === 'screens'
      ? SCREENS_BY_ID.has(String(universe))
      : Boolean(universe) && VALID_UNIVERSES.includes(universe as UniverseKey);
  if (!universeAllowed) {
    return json(400, {
      error: 'invalid or missing universe',
      ...(board === 'screens' ? { validScreens: [...SCREENS_BY_ID.keys()] } : {}),
    });
  }

  // Narrowed by the allow-list check above; the store uses it as an opaque
  // document key, which is what lets a screen id stand in for an index name.
  const universeKey = universe as UniverseKey;

  try {
    if (snapshotId) {
      const snap = await getSnapshotById(board, universeKey, snapshotId);
      if (!snap) {
        log.warn('snapshot_not_found', { snapshotId });
        return json(404, { error: 'snapshot not found', snapshotId });
      }
      log.info('snapshot_fetched', { snapshotId, resultsCount: snap.results.length });
      return json(200, {
        ok: true,
        snapshotId,
        snapshot: snap,
      });
    }

    const items = await listSnapshots(board, universeKey, limit);
    log.info('snapshots_listed', { count: items.length });
    return json(200, {
      ok: true,
      board,
      universe,
      snapshots: items,
    });
  } catch (err: any) {
    log.error('snapshot_history_failed', { err: String(err?.message ?? err) });
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=120' },
    body: JSON.stringify(body),
  };
}
