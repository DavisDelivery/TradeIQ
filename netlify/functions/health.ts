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
import { SCREENS } from './shared/finviz-screens';

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
  // QS-1 — the residual-momentum scan writes ONE cross-universe snapshot
  // under 'all' (see scan-quiet-strength-background.ts), so health probes
  // 'all'. Listing index names here would reproduce the FIX-1 bug above.
  'quiet-strength': ['all'],
  // COMP-1 — the compounders scan writes ONE snapshot under 'largecap'
  // (see scan-compounders-background.ts), the key its producer actually
  // uses. Same discipline as quiet-strength above.
  compounders: ['largecap'],
  crosses: ['sp500'],
  trident: ['sp500', 'russell2k'],
  sentiment: ['sp500'],
  // NOTE: retired boards stay in this table on purpose — their ages are still
  // worth reporting. What they must NOT do is set `degraded`. See
  // RETIRED_BOARDS below.
  // FVZ-6 — the screens producer writes ONE snapshot per screen, keyed by
  // SCREEN ID, not by index name. Listing index names here would reproduce
  // exactly the FIX-1 bug described above: permanently-null entries for a
  // board that is publishing fine. Derived from the catalog so a new screen
  // is monitored the day it ships.
  screens: SCREENS.map((s) => s.id as unknown as UniverseKey),
};

/**
 * Boards whose scheduled scans were deliberately removed.
 *
 * FIX-2 (2026-08-12). The comment above describes a false "degraded" that
 * masked real outages. It happened AGAIN, from the opposite direction: #194
 * retired six boards by moving their scans to netlify/functions-retired/, and
 * the 2026-08-07 decision retired prophet. Their snapshots then aged forever,
 * because nothing writes them any more — and this endpoint read that as an
 * outage. /api/health had been returning 503 continuously for days, and no
 * amount of the app being healthy could ever have cleared it.
 *
 * An alarm that cannot go green is not an alarm. A real failure — the kind
 * FIX-1 was written to expose — would have arrived as one more red among
 * six permanent reds.
 *
 * Their ages are still REPORTED (a retired board's last snapshot is useful
 * history), but they cannot set `degraded`. health-retirement.test.ts checks
 * this list against which scans actually exist, so the next retirement fails
 * a test instead of silently re-breaking the endpoint.
 */
export const RETIRED_BOARDS: ReadonlySet<BoardName> = new Set<BoardName>([
  'target-board', 'fable', 'williams', 'lynch', 'sentiment', 'prophet',
]);

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
          // A retired board has no producer, so its age only ever grows.
          // Reported, never alarming.
          if (RETIRED_BOARDS.has(b)) return;
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
      // Named explicitly so a stale age in `snapshots` reads as "retired",
      // not as "broken and nobody noticed".
      retiredBoards: [...RETIRED_BOARDS],
      snapshotsError,
      timestamp: new Date().toISOString(),
    }),
  };
};
