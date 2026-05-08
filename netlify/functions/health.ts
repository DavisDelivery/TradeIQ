// GET /api/health
//
// Phase 1 expansion: exposes per-board snapshot ages so we can tell at a
// glance whether scheduled scans are running. Status drops to "degraded" if
// any snapshot is older than 2× its freshness budget, which means scheduled
// scans are silently failing.

import type { Handler } from '@netlify/functions';
import {
  FRESHNESS_BUDGETS_MS,
  snapshotAgesForBoard,
  type BoardName,
  type UniverseKey,
} from './shared/snapshot-store';
import { logger } from './shared/logger';

const BOARD_UNIVERSES: Record<BoardName, UniverseKey[]> = {
  'target-board': ['sp500', 'ndx', 'dow', 'russell2k'],
  prophet: ['sp500', 'ndx', 'dow', 'russell2k'],
  catalyst: ['sp500', 'ndx', 'dow', 'russell2k'],
  insider: ['sp500', 'ndx', 'dow', 'russell2k'],
  williams: ['sp500', 'ndx', 'dow', 'russell2k'],
  lynch: ['sp500', 'ndx', 'dow', 'russell2k'],
  earnings: ['sp500', 'ndx', 'dow', 'russell2k'],
};

export const handler: Handler = async () => {
  const log = logger.child({ fn: 'health' });

  const apiKeys = {
    polygon: !!process.env.POLYGON_API_KEY,
    finnhub: !!process.env.FINNHUB_API_KEY,
    fred: !!process.env.FRED_API_KEY,
    anthropic: !!process.env.ANTHROPIC_API_KEY,
    quiver: !!process.env.QUIVER_API_KEY,
    firebaseAdmin: !!process.env.FIREBASE_SERVICE_ACCOUNT,
  };

  // Snapshot ages — wrapped in try/catch because Firestore can fail
  // independently of the API-key checks.
  const snapshots: Record<string, Record<string, { ageMs: number; generatedAt: string } | null>> = {};
  let snapshotsError: string | null = null;
  let degraded = false;

  if (apiKeys.firebaseAdmin) {
    try {
      const boards = Object.keys(BOARD_UNIVERSES) as BoardName[];
      await Promise.all(
        boards.map(async (b) => {
          const ages = await snapshotAgesForBoard(b, BOARD_UNIVERSES[b]);
          snapshots[b] = ages;
          const budget = FRESHNESS_BUDGETS_MS[b];
          for (const u of Object.keys(ages)) {
            const a = ages[u];
            if (!a) continue; // missing is informational, not degraded by itself
            if (a.ageMs > 2 * budget) degraded = true;
          }
        }),
      );
    } catch (err: any) {
      snapshotsError = String(err?.message ?? err);
      log.error('snapshot_age_check_failed', { err: snapshotsError });
      degraded = true;
    }
  }

  const apiKeysGreen = Object.values(apiKeys).every(Boolean);
  const ok = apiKeysGreen && !degraded;

  return {
    statusCode: ok ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify({
      ok,
      status: ok ? 'healthy' : degraded ? 'degraded' : 'misconfigured',
      service: 'tradeiq-alpha',
      version: '0.9.0-alpha',
      checks: apiKeys,
      snapshots,
      snapshotsError,
      timestamp: new Date().toISOString(),
    }),
  };
};
