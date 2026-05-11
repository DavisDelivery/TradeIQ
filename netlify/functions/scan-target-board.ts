// Scheduled scan: target board, every 30 min during US market hours.
//
// Walks the full universe (all 1,930+ Russell 2K, all S&P 500, etc.) in
// background, writes one snapshot per universe to Firestore. Live endpoint
// reads from these snapshots so users get comprehensive coverage instantly.
//
// Schedule (in netlify.toml):
//   schedule = "0,30 13-21 * * 1-5"   # every :00 and :30 UTC, 13:00–21:30 UTC,
//                                       Mon–Fri (≈ 09:00–17:30 ET).
//   timeout  = 900                     # 15-min background timeout.
//
// IMPORTANT: this scan does NOT call Claude/Anthropic. Rule-based scoring only.
// AI surfaces (research, prophet narrative, chart-analysis) stay request-driven.

import { schedule } from '@netlify/functions';
import { runTargetScan, type TargetUniverseKey } from './shared/scan-target';
import { writeSnapshot, FRESHNESS_BUDGETS_MS, type UniverseKey } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

// 14 min — leaves 60s margin under the 15-min Netlify background timeout.
const PER_SCAN_BUDGET_MS = 14 * 60_000;

// Pass-2 caps per universe. Smaller universes can afford more survivors;
// Russell 2K is gated tighter to fit within the per-scan budget.
const PASS2_MAX_BY_UNIVERSE: Record<TargetUniverseKey, number> = {
  core: 33,
  dow: 30,
  ndx: 75,
  sp500: 100,
  russell: 200,
  russell2k: 200,
  all: 250,
};

const UNIVERSES_TO_SCAN: Array<{ key: TargetUniverseKey; storeKey: UniverseKey }> = [
  { key: 'sp500', storeKey: 'sp500' },
  { key: 'ndx', storeKey: 'ndx' },
  { key: 'dow', storeKey: 'dow' },
  { key: 'russell2k', storeKey: 'russell2k' },
];

export const handler = schedule('0,30 13-21 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-target-board' });
  const overallStart = Date.now();
  log.info('scheduled_scan_started', { board: 'target-board', universes: UNIVERSES_TO_SCAN.map(u => u.key) });

  const summary: Array<{
    universe: string;
    ok: boolean;
    resultsCount?: number;
    universeChecked?: number;
    durationMs?: number;
    err?: string;
  }> = [];

  for (const u of UNIVERSES_TO_SCAN) {
    const subLog = log.child({ universe: u.key });
    try {
      const scan = await runTargetScan({
        universe: u.key,
        // No pass1 cap → full universe sweep. Bar fetch handles batching internally.
        pass2Max: PASS2_MAX_BY_UNIVERSE[u.key] ?? 200,
        scanBudgetMs: PER_SCAN_BUDGET_MS,
        analystConcurrency: 6,
        logger: subLog,
      });

      // Snapshot stores the FULL ranked list — never trim before writing.
      // Phase 4 backtest and Phase 5 calibration depend on this.
      const { snapshotId } = await writeSnapshot('target-board', u.storeKey, {
        modelVersion: MODEL_VERSION,
        generatedAt: new Date().toISOString(),
        scanDurationMs: scan.scanDurationMs,
        universeChecked: scan.universeChecked,
        results: scan.results,
        freshnessBudgetMs: FRESHNESS_BUDGETS_MS['target-board'],
        warnings: scan.warnings,
      });

      subLog.info('snapshot_written', {
        snapshotId,
        resultsCount: scan.results.length,
        universeChecked: scan.universeChecked,
        scanDurationMs: scan.scanDurationMs,
        budgetExceeded: scan.budgetExceeded,
      });

      summary.push({
        universe: u.key,
        ok: true,
        resultsCount: scan.results.length,
        universeChecked: scan.universeChecked,
        durationMs: scan.scanDurationMs,
      });
    } catch (err: any) {
      const msg = String(err?.message ?? err);
      subLog.error('scan_failed', { err: msg });
      // Per spec: log + continue. Don't let one failed universe block the others.
      // Previous snapshot remains in place — never deleted on failure.
      summary.push({ universe: u.key, ok: false, err: msg });
    }
  }

  const totalMs = Date.now() - overallStart;
  log.info('scheduled_scan_complete', {
    totalMs,
    summary,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({ ok: true, totalMs, summary }),
  };
});
