// Phase 4f W7 — Scheduled scan: daily institutional flow signals.
//
// Computes dark-pool ratio and block-trade aggregation for each
// largecap ticker, writes to Firestore at
// `institutionalFlow/largecap/{ticker}/{YYYY-MM-DD}`. Target Board
// Flow analyst reads from this cache instead of hitting Polygon
// directly (which would blow the per-scan rate budget).
//
// Schedule: 0 22 * * 1-5 (weekday 22:00 UTC, after US market close).
//
// Scope: dark-pool + block-trades only. Options-unusual computation
// is shipped + tested in `institutional-flow/options-unusual.ts` but
// not wired into this scan yet — the Polygon options-ticks fetcher is
// a follow-up because it requires per-ticker strike enumeration.
//
// Tick volume can be very large (millions of trades per day for the
// most active large-caps). We sample up to 5 pages × 50K trades per
// ticker per day; dark-pool ratios + block counts are ratio-based and
// stay accurate under truncation. The 30-day baseline is built by
// pulling a single sampled day's trades per day-in-window.

import { schedule } from '@netlify/functions';
import { Timestamp } from 'firebase-admin/firestore';
import { inIndex } from './shared/universe';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';
import { computeBlockTradeSignal } from './shared/institutional-flow/block-trades';
import { computeDarkPoolSignal } from './shared/institutional-flow/dark-pool';
import { getTradesForDay } from './shared/institutional-flow/polygon-trades';
import type {
  BlockTradeSignal,
  DarkPoolSignal,
  PolygonTrade,
  PolygonTradesByDay,
} from './shared/institutional-flow/types';

const LOOKBACK_DAYS = 30;
const TICKER_CONCURRENCY = 6;
const BASELINE_SAMPLE_PAGES = 1; // 50K trades per baseline day
const TODAY_SAMPLE_PAGES = 5; // up to 250K trades for today

function isoUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function priorTradingDays(asOf: Date, n: number): string[] {
  // Calendar-day rollback. Weekend/holiday days will return no trades
  // from Polygon; that's fine — those days are filtered out of the
  // dark-pool window automatically by the compute helper.
  const days: string[] = [];
  let cur = new Date(asOf.getTime() - 86_400_000);
  while (days.length < n) {
    days.push(isoUtcDate(cur));
    cur = new Date(cur.getTime() - 86_400_000);
  }
  return days;
}

async function buildTradesWindow(
  ticker: string,
  asOfDate: string,
): Promise<{ window: PolygonTradesByDay; todayTrades: PolygonTrade[]; warnings: string[] }> {
  const asOf = new Date(`${asOfDate}T00:00:00Z`);
  const baselineDays = priorTradingDays(asOf, LOOKBACK_DAYS);
  const byDate: Record<string, PolygonTrade[]> = {};
  const warnings: string[] = [];

  const today = await getTradesForDay(ticker, asOfDate, TODAY_SAMPLE_PAGES);
  warnings.push(...today.warnings);
  byDate[asOfDate] = today.trades;

  // Baseline: 1 page per day to keep total API calls bounded
  // (30 days × 1 page = 30 calls per ticker for baseline).
  for (const d of baselineDays) {
    const dayRes = await getTradesForDay(ticker, d, BASELINE_SAMPLE_PAGES);
    warnings.push(...dayRes.warnings);
    if (dayRes.trades.length > 0) byDate[d] = dayRes.trades;
  }

  return { window: { byDate }, todayTrades: today.trades, warnings };
}

async function scanOneTicker(
  ticker: string,
  asOfDate: string,
): Promise<{
  ticker: string;
  darkPool: DarkPoolSignal | null;
  blockTrades: BlockTradeSignal;
  warnings: string[];
}> {
  const { window, todayTrades, warnings } = await buildTradesWindow(ticker, asOfDate);
  const darkPool = computeDarkPoolSignal(ticker, asOfDate, window);
  const blockTrades = computeBlockTradeSignal({
    ticker,
    asOfDate,
    trades: todayTrades,
  });
  return { ticker, darkPool, blockTrades, warnings };
}

async function writeSignal(
  ticker: string,
  asOfDate: string,
  darkPool: DarkPoolSignal | null,
  blockTrades: BlockTradeSignal,
  warnings: string[],
): Promise<void> {
  await getAdminDb()
    .collection('institutionalFlow')
    .doc('largecap')
    .collection(ticker)
    .doc(asOfDate)
    .set({
      ticker,
      asOfDate,
      darkPool,
      blockTrades,
      warnings,
      writtenAt: Timestamp.now(),
    });
}

async function mapConcurrent<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  batchSize: number,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const results = await Promise.allSettled(batch.map((it, k) => fn(it).then((r) => ({ k: i + k, r }))));
    for (const r of results) {
      if (r.status === 'fulfilled') {
        out[r.value.k] = r.value.r;
      }
    }
  }
  return out;
}

export const handler = schedule('0 22 * * 1-5', async () => {
  const log = logger.child({ fn: 'scan-institutional-flow-largecap' });
  const overallStart = Date.now();
  const asOfDate = new Date().toISOString().slice(0, 10);

  // Largecap universe: sp500 ∪ ndx ∪ dow.
  const largecapTickers = Array.from(
    new Set([
      ...inIndex('sp500').map((e) => e.ticker),
      ...inIndex('ndx').map((e) => e.ticker),
      ...inIndex('dow').map((e) => e.ticker),
    ]),
  );

  log.info('scan_started', { universe: 'largecap', tickers: largecapTickers.length, asOfDate });

  let written = 0;
  let failed = 0;
  const sampleWarnings: string[] = [];

  await mapConcurrent(
    largecapTickers,
    async (ticker) => {
      try {
        const sig = await scanOneTicker(ticker, asOfDate);
        await writeSignal(
          ticker,
          asOfDate,
          sig.darkPool,
          sig.blockTrades,
          sig.warnings,
        );
        written++;
        if (sig.warnings.length > 0 && sampleWarnings.length < 10) {
          sampleWarnings.push(...sig.warnings.slice(0, 1));
        }
      } catch (err: any) {
        failed++;
        if (sampleWarnings.length < 10) {
          sampleWarnings.push(`${ticker}: ${String(err?.message ?? err)}`);
        }
      }
    },
    TICKER_CONCURRENCY,
  );

  const durationMs = Date.now() - overallStart;
  log.info('scan_complete', {
    universe: 'largecap',
    tickers: largecapTickers.length,
    written,
    failed,
    durationMs,
    sampleWarnings,
  });

  return {
    statusCode: 200,
    body: JSON.stringify({
      ok: true,
      asOfDate,
      tickersAttempted: largecapTickers.length,
      written,
      failed,
      durationMs,
    }),
  };
});

// Exposed for tests — drive the per-ticker logic against synthetic data.
export const _internals = {
  scanOneTicker,
  buildTradesWindow,
  priorTradingDays,
};
