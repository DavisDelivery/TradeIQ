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
// Scope: dark-pool + block-trades + options-unusual (Phase 4f-finish).
// The options channel uses `/v3/snapshot/options/{ticker}` which
// returns per-strike open interest + last-print quote — enough for
// OI-spike detection (the largest of the three sub-scores) but NOT
// enough for sweep/block tick detection. Per-contract tick fetching
// is a follow-up; sweep/block counts in the cached signal stay 0
// until that lands.
//
// Previous-day OI for the spike comparison is read from the prior
// day's signal in the same Firestore subcollection; first-day-after-
// deploy snapshots have no prior so oiSpikeStrikes = 0 by design.
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
import { computeOptionsFlowSignal } from './shared/institutional-flow/options-unusual';
import { getOptionsSnapshot } from './shared/institutional-flow/polygon-options-snapshot';
import { getTradesForDay } from './shared/institutional-flow/polygon-trades';
import type {
  BlockTradeSignal,
  DarkPoolSignal,
  OptionsFlowSignal,
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

async function readPrevDayOiByKey(
  ticker: string,
  asOfDate: string,
): Promise<Record<string, number>> {
  // Walk back up to 5 calendar days looking for the most recent
  // institutionalFlow document — weekends/holidays produce no scan,
  // so we don't always have yesterday's record. The cached field is
  // `_oiToday` map written by this same scan one day prior.
  for (let i = 1; i <= 5; i++) {
    const prev = new Date(`${asOfDate}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - i);
    const prevDate = prev.toISOString().slice(0, 10);
    const snap = await getAdminDb()
      .collection('institutionalFlow')
      .doc('largecap')
      .collection(ticker)
      .doc(prevDate)
      .get();
    if (!snap.exists) continue;
    const data = snap.data();
    const oiMap = data?.optionsFlow?._oiToday;
    if (oiMap && typeof oiMap === 'object') return oiMap as Record<string, number>;
  }
  return {};
}

async function scanOneTicker(
  ticker: string,
  asOfDate: string,
): Promise<{
  ticker: string;
  darkPool: DarkPoolSignal | null;
  blockTrades: BlockTradeSignal;
  optionsFlow: OptionsFlowSignal | null;
  oiToday: Record<string, number>;
  warnings: string[];
}> {
  const { window, todayTrades, warnings } = await buildTradesWindow(ticker, asOfDate);
  const darkPool = computeDarkPoolSignal(ticker, asOfDate, window);
  const blockTrades = computeBlockTradeSignal({
    ticker,
    asOfDate,
    trades: todayTrades,
  });

  // Options snapshot — independent of trades window. Read prior-day
  // OI from cache so the day-over-day spike comparison is meaningful.
  let optionsFlow: OptionsFlowSignal | null = null;
  let oiToday: Record<string, number> = {};
  try {
    const prevOi = await readPrevDayOiByKey(ticker, asOfDate);
    const snap = await getOptionsSnapshot(ticker, prevOi);
    warnings.push(...snap.warnings);
    if (snap.window.openInterest.length > 0 || snap.window.trades.length > 0) {
      optionsFlow = computeOptionsFlowSignal({
        ticker,
        asOfDate,
        window: snap.window,
      });
      oiToday = snap.oiToday;
    }
  } catch (err: any) {
    warnings.push(`options snapshot ${ticker}: ${String(err?.message ?? err)}`);
  }

  return { ticker, darkPool, blockTrades, optionsFlow, oiToday, warnings };
}

async function writeSignal(
  ticker: string,
  asOfDate: string,
  darkPool: DarkPoolSignal | null,
  blockTrades: BlockTradeSignal,
  optionsFlow: OptionsFlowSignal | null,
  oiToday: Record<string, number>,
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
      // optionsFlow is the signal consumers read; _oiToday is the
      // private map the next day's scan reads back as previous-day OI
      // for the spike comparison. Underscored to flag as
      // implementation-detail.
      optionsFlow: optionsFlow ? { ...optionsFlow, _oiToday: oiToday } : null,
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
          sig.optionsFlow,
          sig.oiToday,
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
