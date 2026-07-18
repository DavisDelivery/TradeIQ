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
import { APP_VERSION } from './shared/app-version';

// FIX-1 W1 — check each board under the universe keys its producer
// ACTUALLY writes. The previous table checked prophet + earnings under
// the four index keys, but the prophet producers store under
// 'largecap' / 'russell2k' / 'all' (see prophet-snapshot-runner.ts,
// scan-prophet-{largecap,russell,all}.ts) and the earnings scan stores
// ONE calendar-driven snapshot under 'all' (see scan-earnings.ts). The
// mismatch made /api/health report prophet sp500/ndx/dow and all four
// earnings universes as permanently NULL even while the scans were
// publishing on schedule — a false "degraded" that masked the real
// outages (insider sp500/russell2k, empty earnings snapshots).
const BOARD_UNIVERSES: Record<BoardName, UniverseKey[]> = {
  'target-board': ['sp500', 'ndx', 'dow', 'russell2k'],
  prophet: ['largecap', 'russell2k', 'all'],
  catalyst: ['sp500', 'ndx', 'dow', 'russell2k'],
  insider: ['sp500', 'ndx', 'dow', 'russell2k'],
  fable: ['sp500'],
  williams: ['sp500', 'ndx', 'dow', 'russell2k'],
  lynch: ['sp500', 'ndx', 'dow', 'russell2k'],
  earnings: ['all'],
  crosses: ['sp500'],
  trident: ['sp500', 'russell2k'],
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
      version: APP_VERSION,
      checks: apiKeys,
      snapshots,
      snapshotsError,
      timestamp: new Date().toISOString(),
    }),
  };
};
