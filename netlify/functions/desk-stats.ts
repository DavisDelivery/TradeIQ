// GET /api/desk-stats?tickers=AAPL,MSFT,...
//
// DESK-1 W1 — per-ticker derived stats for the Desk watchlist table.
// For each ticker, reads the cached 1Y daily bars (the SAME Firestore
// cache /api/price-history uses — priceHistory/{ticker}.ranges.1Y;
// populated on miss via Polygon) and derives:
//
//   spark          — last 30 closes (inline SVG sparkline)
//   atrPct14       — Wilder ATR(14) as % of last close
//   dist52wHighPct — % distance from the 52-week high (≤ 0 at/below high)
//   dist52wLowPct  — % distance from the 52-week low  (≥ 0 at/above low)
//   avgVol20       — mean volume over the last 20 bars
//   marketCap / sector / name — via the ticker-reference cache
//
// Budget discipline: NO Finnhub calls here (earnings-radar owns those);
// Polygon only on a 1Y-cache miss. Concurrency 6. A bad ticker never
// throws the batch — it is skipped and reported in `warnings`.

import type { Handler } from '@netlify/functions';
import { getDailyBars } from './shared/data-provider';
import { getTickerInfo } from './shared/ticker-reference';
import { findEntry } from './shared/universe';
import {
  readRangeCache, writeRangeCache, toPriceBar, todayUtc,
  type PriceBar,
} from './shared/price-history-cache';
import { createLogger } from './shared/logger';

const log = createLogger('desk-stats');

const MAX_TICKERS = 60;
const CONCURRENCY = 6;
const SPARK_LEN = 30;

export interface DeskStat {
  ticker: string;
  name: string | null;
  sector: string | null;
  marketCap: number | null;
  last: number | null;          // last cached daily close (UI overlays live quotes)
  spark: number[];              // last 30 closes, oldest → newest
  atrPct14: number | null;
  dist52wHighPct: number | null;
  dist52wLowPct: number | null;
  avgVol20: number | null;
  asOfDate: string | null;      // date of the last bar the stats derive from
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const raw = event.queryStringParameters?.tickers ?? '';
  const tickers = [...new Set(
    raw.split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  )].slice(0, MAX_TICKERS);

  if (tickers.length === 0) {
    return json(400, { ok: false, error: 'tickers required (comma-separated)' });
  }

  const stats: Record<string, DeskStat> = {};
  const warnings: Array<{ ticker: string; error: string }> = [];

  for (let i = 0; i < tickers.length; i += CONCURRENCY) {
    const batch = tickers.slice(i, i + CONCURRENCY);
    await Promise.all(batch.map(async (ticker) => {
      try {
        const bars = await get1yBars(ticker);
        if (bars.length === 0) {
          warnings.push({ ticker, error: 'no_bars' });
          return;
        }
        const info = await getTickerInfo(ticker).catch(() => null);
        stats[ticker] = deriveStats(ticker, bars, {
          name: info?.name ?? findEntry(ticker)?.name ?? null,
          sector: findEntry(ticker)?.sector ?? info?.industry ?? null,
          marketCap: info?.marketCap ?? null,
        });
      } catch (err: any) {
        warnings.push({ ticker, error: String(err?.message ?? err) });
        log.warn('ticker_failed', { ticker, err: String(err?.message ?? err) });
      }
    }));
  }

  log.info('response', {
    status: 200,
    requested: tickers.length,
    returned: Object.keys(stats).length,
    warnings: warnings.length,
    durationMs: Date.now() - start,
  });
  return json(200, {
    ok: true,
    asOf: new Date().toISOString(),
    stats,
    ...(warnings.length > 0 ? { warnings } : {}),
  });
};

// ---------------------------------------------------------------------------
// 1Y bars via the shared price-history cache (populate on miss)
// ---------------------------------------------------------------------------

async function get1yBars(ticker: string): Promise<PriceBar[]> {
  const today = todayUtc();
  const cached = await readRangeCache(ticker, '1Y');
  if (cached && cached.asOfDate === today && cached.bars.length > 0) return cached.bars;

  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 365 * 86_400_000)
    .toISOString().slice(0, 10);
  const bars = (await getDailyBars(ticker, from, today)).map(toPriceBar);
  if (bars.length > 0) {
    await writeRangeCache(ticker, '1Y', { asOfDate: today, bars }).catch((err) => {
      log.warn('cache_write_failed', { ticker, err: String(err?.message ?? err) });
    });
  }
  return bars;
}

// ---------------------------------------------------------------------------
// Derived math (exported for tests)
// ---------------------------------------------------------------------------

/**
 * Wilder ATR(14) as a % of the last close. First ATR is the simple mean
 * of the first `period` true ranges; subsequent values use Wilder
 * smoothing: ATR = (prevATR * (period - 1) + TR) / period.
 */
export function wilderAtrPct(bars: PriceBar[], period = 14): number | null {
  if (bars.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = 1; i < bars.length; i++) {
    const b = bars[i];
    const prevClose = bars[i - 1].close;
    trs.push(Math.max(
      b.high - b.low,
      Math.abs(b.high - prevClose),
      Math.abs(b.low - prevClose),
    ));
  }
  if (trs.length < period) return null;
  let atr = trs.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period;
  }
  const lastClose = bars[bars.length - 1].close;
  if (!Number.isFinite(atr) || !Number.isFinite(lastClose) || lastClose <= 0) return null;
  return round2((atr / lastClose) * 100);
}

export function deriveStats(
  ticker: string,
  bars: PriceBar[],
  ref: { name: string | null; sector: string | null; marketCap: number | null },
): DeskStat {
  const closes = bars.map((b) => b.close);
  const last = closes[closes.length - 1] ?? null;

  const hi52 = bars.length > 0 ? Math.max(...bars.map((b) => b.high)) : null;
  const lo52 = bars.length > 0 ? Math.min(...bars.map((b) => b.low)) : null;

  const vol20 = bars.slice(-20).map((b) => b.volume).filter((v) => Number.isFinite(v));
  const avgVol20 = vol20.length > 0
    ? Math.round(vol20.reduce((a, b) => a + b, 0) / vol20.length)
    : null;

  return {
    ticker,
    name: ref.name,
    sector: ref.sector,
    marketCap: ref.marketCap,
    last,
    spark: closes.slice(-SPARK_LEN),
    atrPct14: wilderAtrPct(bars),
    dist52wHighPct: last != null && hi52 != null && hi52 > 0
      ? round2(((last - hi52) / hi52) * 100)
      : null,
    dist52wLowPct: last != null && lo52 != null && lo52 > 0
      ? round2(((last - lo52) / lo52) * 100)
      : null,
    avgVol20,
    asOfDate: bars.length > 0 ? bars[bars.length - 1].date : null,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Stats derive from daily bars — a short browser cache smooths
      // rapid tab flips without hiding a new trading day.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}

// Exposed for tests.
export const _internals = { MAX_TICKERS, CONCURRENCY, SPARK_LEN };
