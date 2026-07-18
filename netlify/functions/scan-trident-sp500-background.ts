// TRIDENT sp500 scan — background worker (15-min container).
// Dispatched by scan-trident-sp500.ts; pattern per #123's worker fleet.

import type { Handler } from '@netlify/functions';
import { runTridentScan } from './shared/trident/scan-trident';
import { loadActivistMap, makeInstitutionalFor } from './shared/trident/institutional';
import { getAdminDb } from './shared/firebase-admin';
import {
  writeSnapshot,
  assessSnapshotPublish,
  FRESHNESS_BUDGETS_MS,
} from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 13 * 60_000;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-trident-sp500-background', universe: 'sp500' });
  const started = Date.now();
  try {
    // Smart Money context: one Firestore read for all live 13D events;
    // short interest rides the provider cache per ticker.
    let institutionalFor;
    try {
      institutionalFor = makeInstitutionalFor(await loadActivistMap(getAdminDb()));
    } catch (err: any) {
      log.warn('institutional_context_unavailable', { err: String(err?.message ?? err) });
    }
    const scan = await runTridentScan({
      universe: 'sp500',
      scanBudgetMs: PER_SCAN_BUDGET_MS,
      concurrency: 8,
      logger: log,
      institutionalFor,
    });

    let status: 'complete' | 'partial' = scan.partial ? 'partial' : 'complete';
    const warnings = [...scan.warnings];
    if (status === 'complete') {
      const decision = assessSnapshotPublish({
        resultCount: scan.rows.length,
        universeChecked: scan.universeChecked,
      });
      if (decision.action === 'skip') {
        status = 'partial';
        warnings.push(`publish guard: ${decision.reason}`);
      }
    }

    const { snapshotId, promotedToLatest } = await writeSnapshot('trident', 'sp500', {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      universeSize: scan.universeSize,
      results: scan.rows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.trident,
      warnings,
      status,
      // Regime panel payload rides the snapshot (single source of truth).
      regime: scan.regime,
      stage1Survivors: scan.stage1Survivors,
    } as any);

    log.info('snapshot_written', {
      snapshotId, status, promotedToLatest,
      rows: scan.rows.length, survivors: scan.stage1Survivors,
      durationMs: Date.now() - started,
    });
    return { statusCode: 200, body: JSON.stringify({ ok: true, snapshotId, status, rows: scan.rows.length }) };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('trident_scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
