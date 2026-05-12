// Fire-and-forget HTTP-invokable background seeder for any board/universe.
//
// Why this exists:
//   The scheduled scan-{board}-{universe} functions are wrapped with the
//   `schedule()` helper, which gives them a 15-min background container only
//   when invoked by Netlify's cron scheduler. When invoked via HTTP POST
//   directly (e.g. manual seeding), they get the synchronous 26s/210s gateway
//   timeout, which kills heavier russell2k scans (catalyst is the worst —
//   4 providers per ticker × 2037 tickers).
//
// Background functions in Netlify v1 are defined by a `-background.ts`
// filename suffix. They return 202 Accepted immediately to the caller and
// run async up to 15 minutes. Perfect for manual russell2k seeding.
//
// Usage:
//   curl -X POST "https://<site>/.netlify/functions/seed-scan-background?board=catalyst&universe=russell2k"
//   → returns 202 immediately. Snapshot lands in Firestore within 15 min.
//
// Boards + universes:
//   target-board:  sp500 | ndx | dow | russell2k
//   prophet:       largecap | russell | all
//   williams:      sp500 | ndx | dow | russell2k
//   catalyst:      sp500 | ndx | dow | russell2k
//   insider:       sp500 | ndx | dow | russell2k
//   lynch:         sp500 | ndx | dow | russell2k
//   earnings:      (monolithic — pass board=earnings without universe)
//
// All snapshot writes go through the same writeSnapshot path as scheduled
// scans, so freshness budgets and read paths work identically.

import type { Handler } from '@netlify/functions';
import { runTargetScan, type TargetUniverseKey } from './shared/scan-target';
import { runProphetScan, type ProphetUniverseKey } from './shared/scan-prophet';
import { runWilliamsScan, type WilliamsUniverseKey } from './shared/scan-williams';
import { runCatalystScan, type CatalystUniverseKey } from './shared/scan-catalyst';
import {
  runInsiderScan,
  type InsiderUniverseKey,
  INSIDER_SCHEDULED_WINDOW_DAYS,
} from './shared/scan-insider';
import { runLynchScan, type LynchUniverseKey } from './shared/scan-lynch';
import {
  runEarningsScan,
  EARNINGS_SCHEDULED_WINDOW_DAYS,
  POST_PRINT_LOOKBACK_DAYS,
} from './shared/scan-earnings';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  type UniverseKey,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s headroom under the 15-min background cap.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

type Board =
  | 'target-board'
  | 'prophet'
  | 'williams'
  | 'catalyst'
  | 'insider'
  | 'lynch'
  | 'earnings';

const VALID_BOARDS: ReadonlySet<Board> = new Set([
  'target-board',
  'prophet',
  'williams',
  'catalyst',
  'insider',
  'lynch',
  'earnings',
]);

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const board = (qs.board ?? '').toLowerCase() as Board;
  const universe = (qs.universe ?? '').toLowerCase();

  const log = logger.child({ fn: 'seed-scan-background', board, universe });
  const overallStart = Date.now();
  log.info('seed_started', { board, universe });

  if (!VALID_BOARDS.has(board)) {
    log.warn('invalid_board', { board });
    return {
      statusCode: 400,
      body: JSON.stringify({
        ok: false,
        error: `invalid board "${board}". Valid: ${Array.from(VALID_BOARDS).join(', ')}`,
      }),
    };
  }

  try {
    if (board === 'target-board') {
      const u = universe as TargetUniverseKey;
      const scan = await runTargetScan({
        universe: u,
        pass2Max: 100,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        analystConcurrency: 6,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('target-board', u as UniverseKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.results,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS['target-board'],
        warnings: scan.warnings,
      });
      log.info('snapshot_written', {
        snapshotId,
        results: scan.results.length,
        durationMs: scan.scanDurationMs,
        overallMs: Date.now() - overallStart,
      });
    } else if (board === 'prophet') {
      const u = universe as ProphetUniverseKey;
      const storeKey: UniverseKey = u === 'russell' ? 'russell2k' : (u as UniverseKey);
      const scan = await runProphetScan({
        universe: u,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('prophet', storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.picks,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.prophet,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, picks: scan.picks.length });
    } else if (board === 'williams') {
      const u = universe as WilliamsUniverseKey;
      const scan = await runWilliamsScan({
        universe: u,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('williams', u as UniverseKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.candidates,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.williams,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, candidates: scan.candidates.length });
    } else if (board === 'catalyst') {
      const u = universe as CatalystUniverseKey;
      const scan = await runCatalystScan({
        universe: u,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('catalyst', u as UniverseKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.picks,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.catalyst,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, picks: scan.picks.length });
    } else if (board === 'insider') {
      const u = universe as InsiderUniverseKey;
      const scan = await runInsiderScan({
        universe: u,
        windowDays: INSIDER_SCHEDULED_WINDOW_DAYS,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        enrichRoles: true,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('insider', u as UniverseKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.rows,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.insider,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, rows: scan.rows.length });
    } else if (board === 'lynch') {
      const u = universe as LynchUniverseKey;
      const scan = await runLynchScan({
        universe: u,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 8,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('lynch', u as UniverseKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.candidates,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.lynch,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, candidates: scan.candidates.length });
    } else if (board === 'earnings') {
      // Earnings ignores universe (monolithic by design — scans the calendar,
      // not a static universe). Universe param accepted but unused.
      const scan = await runEarningsScan({
        windowDays: EARNINGS_SCHEDULED_WINDOW_DAYS,
        postPrintLookbackDays: POST_PRINT_LOOKBACK_DAYS,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        concurrency: 10,
        logger: log,
      });
      const { snapshotId } = await writeSnapshot('earnings', 'all', {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.setups,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS.earnings,
        warnings: scan.warnings,
      });
      log.info('snapshot_written', { snapshotId, setups: scan.setups.length });
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        board,
        universe,
        overallDurationMs: Date.now() - overallStart,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('seed_failed', { err: msg });
    return {
      statusCode: 500,
      body: JSON.stringify({ ok: false, board, universe, error: msg }),
    };
  }
};
