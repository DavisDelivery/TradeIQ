// scan-crosses-sp500-background — 15-min background worker.
//
// Dead-cron remediation (runtime audit 2026-07-15): this scan previously
// ran INLINE in its scheduled function. Netlify grants the 15-minute
// budget only to *-background names; the inline scan was killed at the
// synchronous ceiling before writeSnapshot — the same failure class the
// #95-#97 remediation fixed for four other boards. The cron file is now a
// thin dispatcher; the scan body below is verbatim from the old inline
// handler.

// Scheduled scan: SMA50/SMA200 golden + death crosses across the S&P 500.
//
// Board:    crosses
// Universe: sp500
// Schedule: 10 21 * * 1-5 (21:10 UTC — after the 20:00 UTC close, ahead of
//           the 21:30-21:45 insider/earnings Finnhub window; this scan is
//           Polygon-only so it shares no quota with those anyway)
//
// Each run refetches ~650 calendar days of bars per ticker (200-bar SMA
// warmup + a ~12-month event window) and re-detects every cross in the
// window, so the snapshot is a complete self-healing history — a missed
// night or a transient per-ticker failure is repaired by the next run,
// and the board has a year of history from its very first scan.
//
// Detection is on completed daily closes (see shared/cross-detect.ts), so
// an event is final the evening it forms: barsAgo === 0 rows are "tonight's
// crosses" and are what the Alerts view surfaces as fresh.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { detectCrosses, toCrossRows, type CrossRow } from './shared/cross-detect';
import { inIndex } from './shared/universe';
import { writeSnapshot, FRESHNESS_BUDGETS_MS } from './shared/snapshot-store';
import { MODEL_VERSION } from './shared/model-version';
import { logger } from './shared/logger';

const PER_SCAN_BUDGET_MS = 14 * 60_000; // 60s margin under the 15-min ceiling
const CONCURRENCY = 8;
// 200 trading days of warmup + ~250 trading days of event window, in
// calendar days with buffer for holidays.
const FETCH_CALENDAR_DAYS = 680;
const EVENT_WINDOW_CALENDAR_DAYS = 380;

export async function runCrossesScan(log = logger.child({ fn: 'scan-crosses-sp500' })) {
  const started = Date.now();
  const entries = inIndex('sp500');
  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - FETCH_CALENDAR_DAYS * 86_400_000)
    .toISOString().slice(0, 10);
  const sinceMs = Date.now() - EVENT_WINDOW_CALENDAR_DAYS * 86_400_000;

  const rows: CrossRow[] = [];
  let checked = 0;
  let errors = 0;
  let cursor = 0;

  async function worker() {
    while (cursor < entries.length && Date.now() - started < PER_SCAN_BUDGET_MS) {
      const entry = entries[cursor++];
      try {
        const bars = await getDailyBars(entry.ticker, from, to);
        checked++;
        if (bars.length < 201) continue; // recent IPO — SMA200 undefined
        const events = detectCrosses(bars, sinceMs);
        if (events.length) {
          rows.push(...toCrossRows(entry.ticker, entry.name ?? null, entry.sector ?? null, bars, events));
        }
      } catch (err) {
        errors++;
        log.warn('ticker_failed', { ticker: entry.ticker, err: String((err as Error)?.message ?? err) });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, worker));

  // Newest first by default; the endpoint/UI re-sort as requested.
  rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.ticker.localeCompare(b.ticker)));

  return {
    rows,
    universeChecked: checked,
    universeSize: entries.length,
    errors,
    scanDurationMs: Date.now() - started,
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }
  const log = logger.child({ fn: 'scan-crosses-sp500', universe: 'sp500' });
  log.info('scheduled_scan_started', { board: 'crosses', universe: 'sp500' });
  try {
    const scan = await runCrossesScan(log);
    const { snapshotId } = await writeSnapshot('crosses', 'sp500', {
      modelVersion: MODEL_VERSION,
      generatedAt: new Date().toISOString(),
      scanDurationMs: scan.scanDurationMs,
      universeChecked: scan.universeChecked,
      results: scan.rows,
      freshnessBudgetMs: FRESHNESS_BUDGETS_MS.crosses,
      warnings: scan.errors > 0 ? [`${scan.errors} tickers failed bar fetch`] : [],
    });
    const fresh = scan.rows.filter((r) => r.barsAgo === 0).length;
    log.info('snapshot_written', {
      snapshotId, rows: scan.rows.length, freshCrossesTonight: fresh,
      universeChecked: scan.universeChecked, errors: scan.errors,
      scanDurationMs: scan.scanDurationMs,
    });
    return {
      statusCode: 200,
      body: JSON.stringify({ ok: true, board: 'crosses', snapshotId, rows: scan.rows.length, freshCrossesTonight: fresh }),
    };
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('scheduled_scan_failed', { err: msg });
    return { statusCode: 500, body: JSON.stringify({ ok: false, board: 'crosses', error: msg }) };
  }
};
