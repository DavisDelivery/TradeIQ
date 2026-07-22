// Single-shot background worker for the sp500 news-sentiment board.
//
// One 13-min budget comfortably sweeps the ~500-name S&P 500: each ticker is
// a single Finnhub /company-news call, paced by the shared token bucket
// (~55 rpm), so a full pass lands well inside the window. Unlike the insider
// scan there is NO checkpoint chain — if the wall-clock budget trips early we
// still write what we scored (a sentiment snapshot is a rolling signal; a
// subset is a valid, honest snapshot — universeChecked reflects the actual
// count). The scheduled trigger (scan-sentiment-sp500.ts) POSTs this.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { MODEL_VERSION } from './shared/model-version';
import { runSentimentScan } from './shared/sentiment';
import {
  writeSnapshot,
  FRESHNESS_BUDGETS_MS,
  pruneOldSnapshots,
  assessSnapshotPublish,
  trimResultsForDocLimit,
  type UniverseKey,
} from './shared/snapshot-store';

const BOARD = 'sentiment';
const STORE_KEY: UniverseKey = 'sp500';
const BUDGET_MS = Number(process.env.SENTIMENT_SCAN_BUDGET_MS ?? 13 * 60_000);
const CONCURRENCY = Number(process.env.SENTIMENT_SCAN_CONCURRENCY ?? 4);
const NEWS_WINDOW_DAYS = Number(process.env.SENTIMENT_NEWS_DAYS ?? 7);
const RETENTION_KEEP = 30;

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };
  const log = logger.child({ fn: 'scan-sentiment-sp500-background' });
  const started = Date.now();

  try {
    const scan = await runSentimentScan({
      universe: 'sp500',
      daysBack: NEWS_WINDOW_DAYS,
      concurrency: CONCURRENCY,
      shouldAbort: () => Date.now() - started > BUDGET_MS,
      logger: log,
    });

    const decision = assessSnapshotPublish({
      resultCount: scan.rows.length,
      universeChecked: scan.tickersChecked,
      totalCalls: scan.finnhubCalls,
      rateLimitedCalls: scan.finnhubRateLimited,
      errorCalls: scan.finnhubErrors,
    });
    log.info('publish_guard_decision', {
      action: decision.action,
      reason: decision.reason,
      resultCount: scan.rows.length,
      tickersChecked: scan.tickersChecked,
      finnhubCalls: scan.finnhubCalls,
      finnhubRateLimited: scan.finnhubRateLimited,
      finnhubErrors: scan.finnhubErrors,
    });

    if (decision.action === 'skip') {
      log.warn('publish_guard_skip', { reason: decision.reason });
      return {
        statusCode: 200,
        body: JSON.stringify({ ok: true, published: false, reason: decision.reason }),
      };
    }

    const sized = trimResultsForDocLimit(scan.rows);
    const warnings = [...scan.warnings];
    if (sized.truncated) {
      warnings.push(
        `snapshot results truncated for doc-size safety: ${sized.storedCount}/${sized.originalCount} rows kept`,
      );
    }

    const written = await writeSnapshot(BOARD, STORE_KEY, {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: Date.now() - started,
      universeChecked: scan.tickersChecked,
      results: sized.results,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS[BOARD],
      warnings,
      degraded: decision.action === 'publish-degraded' ? true : undefined,
      degradedReason: decision.action === 'publish-degraded' ? decision.reason : undefined,
      truncated: sized.truncated ? true : undefined,
      originalResultCount: sized.truncated ? sized.originalCount : undefined,
    });

    try {
      const { deleted, kept } = await pruneOldSnapshots(BOARD, STORE_KEY, RETENTION_KEEP);
      log.info('snapshot_retention_pruned', { universe: STORE_KEY, deleted, kept });
    } catch (err: any) {
      log.warn('snapshot_retention_prune_failed', { err: String(err?.message ?? err) });
    }

    log.info('scan_complete', {
      snapshotId: written.snapshotId,
      rows: scan.rows.length,
      tickersChecked: scan.tickersChecked,
      ms: Date.now() - started,
      publishAction: decision.action,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({
        ok: true,
        published: true,
        snapshotId: written.snapshotId,
        rows: scan.rows.length,
        tickersChecked: scan.tickersChecked,
        publishAction: decision.action,
      }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, error: msg }) };
  }
};
