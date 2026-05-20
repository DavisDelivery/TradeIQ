// GET /api/diag-insider-pit?ticker=NVDA&asOfDate=2020-06-30
//
// Phase 4t W1c probe — diagnostic-only. Surfaces raw Finnhub responses
// for insider transactions in both PIT and live modes side-by-side, plus
// the resulting `InsiderActivity` shape, plus the PIT cache state. Used
// to discriminate between three hypotheses for the insider analyst's
// chronic 70-98% silent rate in the sp500 composite backtest:
//
//   I-A — Finnhub historical-depth limit (provider returns empty for
//         historical windows beyond ~recent months on the deployed plan).
//   I-B — Transaction-code filter exclusion (insider-provider.ts:94-95
//         only counts 'P' and 'S'; if Finnhub's historical Form 4 feed
//         classifies sells under 'F'/'M'/'A'/'G' instead, the count is 0
//         even though raw activity is rich).
//   I-C — Stale PIT cache (a prior bugged run cached the `empty` shape
//         for many (ticker, asOfDate) keys; subsequent runs serve those
//         stale entries even after upstream provider behaviour changed).
//
// Full diagnosis context: reports/phase-4t-w1c/diagnosis.md (§ Insider).
//
// This endpoint is permanent and gated only by "the URL is private" — no
// auth check, same model as /api/target-rationale. Lives in the W1c
// branch ahead of the W2 fix PR. Surfaces ground truth for follow-on
// insider-data debugging; keep it.

import type { Handler } from '@netlify/functions';
import { getFinnhubInsiderTransactionsWithStatus } from './shared/data-provider';
import { getInsiderActivity } from './shared/insider-provider';
import { pitCacheGet, pitCacheHas, type PitCacheKey } from './shared/pit-cache';
import { createLogger } from './shared/logger';

const log = createLogger('diag-insider-pit');

interface Histogram {
  [code: string]: number;
}

interface RawSummary {
  rowCount: number;
  earliestTransactionDate: string | null;
  latestTransactionDate: string | null;
  earliestFilingDate: string | null;
  latestFilingDate: string | null;
  /** Per-transactionCode histogram across the ENTIRE raw response. */
  codeHistogramAll: Histogram;
  /** Per-code histogram restricted to the 90-day window relative to asOfDate
   *  (or "now" when no asOfDate is set). Mirrors the in-window filter
   *  `insider-provider.ts:84` applies. */
  codeHistogramInWindow: Histogram;
  rateLimited: boolean;
  rateLimitExhausted: boolean;
  errorMessage?: string;
  /** Up to 5 sample rows so we can eyeball Finnhub's shape. */
  sampleRows: Array<{
    transactionDate: string;
    filingDate: string;
    transactionCode: string;
    change: number;
    transactionPrice: number;
  }>;
}

interface ProcessedSummary {
  totalBuys: number;
  totalSells: number;
  netDollars: number;
  uniqueBuyers: number;
  clusterCount: number;
}

interface CacheState {
  hit: boolean;
  cachedShape: 'null' | 'empty' | 'real' | 'absent';
  cachedTotalBuys?: number;
  cachedTotalSells?: number;
  cachedFetchedAt?: string;
}

interface DiagResponse {
  ok: boolean;
  ticker: string;
  asOfDate: string;
  liveAnchorDate: string;
  pit: {
    raw: RawSummary;
    processed: ProcessedSummary | { empty: true };
    cache: CacheState;
  };
  live: {
    raw: RawSummary;
    processed: ProcessedSummary | { empty: true };
  };
  hypotheses: {
    I_A_provider_depth: 'consistent' | 'inconsistent' | 'inconclusive';
    I_B_code_exclusion: 'consistent' | 'inconsistent' | 'inconclusive';
    I_C_stale_cache: 'consistent' | 'inconsistent' | 'inconclusive';
    leadingRead: string;
  };
  notes: string[];
}

function summarizeRaw(
  rows: Array<{
    transactionDate: string;
    filingDate: string;
    transactionCode: string;
    change: number;
    transactionPrice: number;
  }>,
  anchorDate: string,
  lookbackDays: number,
  envelope: { rateLimited: boolean; rateLimitExhausted: boolean; errorMessage?: string },
): RawSummary {
  const anchorMs = Date.parse(anchorDate + 'T23:59:59Z');
  const fromIso = new Date(anchorMs - lookbackDays * 86400000)
    .toISOString()
    .slice(0, 10);

  const all: Histogram = {};
  const win: Histogram = {};
  let earliestTx: string | null = null;
  let latestTx: string | null = null;
  let earliestFi: string | null = null;
  let latestFi: string | null = null;
  for (const r of rows) {
    const code = r.transactionCode || '_blank';
    all[code] = (all[code] ?? 0) + 1;
    if (r.transactionDate) {
      if (!earliestTx || r.transactionDate < earliestTx) earliestTx = r.transactionDate;
      if (!latestTx || r.transactionDate > latestTx) latestTx = r.transactionDate;
    }
    if (r.filingDate) {
      if (!earliestFi || r.filingDate < earliestFi) earliestFi = r.filingDate;
      if (!latestFi || r.filingDate > latestFi) latestFi = r.filingDate;
    }
    if (r.transactionDate >= fromIso && r.transactionDate <= anchorDate) {
      win[code] = (win[code] ?? 0) + 1;
    }
  }
  return {
    rowCount: rows.length,
    earliestTransactionDate: earliestTx,
    latestTransactionDate: latestTx,
    earliestFilingDate: earliestFi,
    latestFilingDate: latestFi,
    codeHistogramAll: all,
    codeHistogramInWindow: win,
    rateLimited: envelope.rateLimited,
    rateLimitExhausted: envelope.rateLimitExhausted,
    errorMessage: envelope.errorMessage,
    sampleRows: rows.slice(0, 5).map((r) => ({
      transactionDate: r.transactionDate,
      filingDate: r.filingDate,
      transactionCode: r.transactionCode,
      change: r.change,
      transactionPrice: r.transactionPrice,
    })),
  };
}

function summarizeProcessed(
  a: Awaited<ReturnType<typeof getInsiderActivity>>,
): ProcessedSummary | { empty: true } {
  if (a.totalBuys === 0 && a.totalSells === 0) {
    return { empty: true };
  }
  return {
    totalBuys: a.totalBuys,
    totalSells: a.totalSells,
    netDollars: Math.round(a.netDollars),
    uniqueBuyers: a.uniqueBuyers,
    clusterCount: a.clusters.length,
  };
}

export const handler: Handler = async (event) => {
  const ticker = (event.queryStringParameters?.ticker ?? 'NVDA').toUpperCase().trim();
  const asOfDate = (event.queryStringParameters?.asOfDate ?? '2020-06-30').trim();
  const liveAnchorDate = new Date().toISOString().slice(0, 10);

  if (!/^[A-Z][A-Z.\-]{0,9}$/.test(ticker)) {
    return json(400, { ok: false, error: 'ticker must be uppercase 1-10 chars' });
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    return json(400, { ok: false, error: 'asOfDate must be YYYY-MM-DD' });
  }

  log.info('probe_start', { ticker, asOfDate });

  try {
    const pitKey: PitCacheKey = {
      provider: 'finnhub',
      dataClass: 'insider',
      ticker,
      asOfDate,
      extra: 'lb=90',
    };

    const [pitRawStatus, liveRawStatus, pitProcessed, liveProcessed, cacheValue, cacheExists] =
      await Promise.all([
        // Raw historical — directly through the provider, bypasses pitCacheWrap.
        getFinnhubInsiderTransactionsWithStatus(ticker, 455, { asOfDate }),
        // Raw live — no asOfDate.
        getFinnhubInsiderTransactionsWithStatus(ticker, 455, {}),
        // Processed historical — uses the same insider-provider path the backtest engine uses.
        getInsiderActivity(ticker, 90, { asOfDate }),
        // Processed live.
        getInsiderActivity(ticker, 90, {}),
        // PIT cache state — what does the cache hold for the canonical key the backtest engine uses?
        pitCacheGet<Awaited<ReturnType<typeof getInsiderActivity>>>(pitKey),
        pitCacheHas(pitKey),
      ]);

    const pitRaw = summarizeRaw(pitRawStatus.data, asOfDate, 90, {
      rateLimited: pitRawStatus.rateLimited,
      rateLimitExhausted: pitRawStatus.rateLimitExhausted,
      errorMessage: pitRawStatus.errorMessage,
    });
    const liveRaw = summarizeRaw(liveRawStatus.data, liveAnchorDate, 90, {
      rateLimited: liveRawStatus.rateLimited,
      rateLimitExhausted: liveRawStatus.rateLimitExhausted,
      errorMessage: liveRawStatus.errorMessage,
    });

    let cacheState: CacheState;
    if (!cacheExists) {
      cacheState = { hit: false, cachedShape: 'absent' };
    } else if (cacheValue == null) {
      cacheState = { hit: true, cachedShape: 'null' };
    } else if (cacheValue.totalBuys === 0 && cacheValue.totalSells === 0) {
      cacheState = {
        hit: true,
        cachedShape: 'empty',
        cachedTotalBuys: 0,
        cachedTotalSells: 0,
        cachedFetchedAt: cacheValue.fetchedAt,
      };
    } else {
      cacheState = {
        hit: true,
        cachedShape: 'real',
        cachedTotalBuys: cacheValue.totalBuys,
        cachedTotalSells: cacheValue.totalSells,
        cachedFetchedAt: cacheValue.fetchedAt,
      };
    }

    // Hypothesis tagging — best-effort inference, not authoritative.
    const notes: string[] = [];
    let IA: 'consistent' | 'inconsistent' | 'inconclusive' = 'inconclusive';
    let IB: 'consistent' | 'inconsistent' | 'inconclusive' = 'inconclusive';
    let IC: 'consistent' | 'inconsistent' | 'inconclusive' = 'inconclusive';
    let leadingRead = '';

    if (pitRaw.rowCount === 0 && liveRaw.rowCount > 0) {
      IA = 'consistent';
      notes.push(
        `Finnhub returned ZERO rows for the historical window (${asOfDate} - 455d -> ${asOfDate}) ` +
          `but RICH rows for live (${liveRaw.rowCount}). Strong signal that Finnhub /stock/insider-transactions ` +
          `does not cover historical dates on this plan (I-A).`,
      );
      leadingRead = 'I-A (provider depth)';
    } else if (pitRaw.rowCount > 0 && pitRaw.codeHistogramInWindow.P === undefined && pitRaw.codeHistogramInWindow.S === undefined) {
      IB = 'consistent';
      notes.push(
        `Finnhub returned ${pitRaw.rowCount} historical rows but ZERO 'P'/'S' in the 90d window. ` +
          `Codes present in window: ${JSON.stringify(pitRaw.codeHistogramInWindow)}. ` +
          `The insider-provider.ts:94-95 filter excludes everything (I-B).`,
      );
      leadingRead = 'I-B (transactionCode filter exclusion)';
    } else if (pitRaw.rowCount > 0 && ('processed' in pitProcessed) === false) {
      // pit raw has data but processed is empty — points at code-side filter or sign-convention issue
      IB = 'consistent';
      notes.push(
        `Finnhub returned ${pitRaw.rowCount} historical rows; ` +
          `in-window code histogram: ${JSON.stringify(pitRaw.codeHistogramInWindow)}. ` +
          `Processed result is empty (totalBuys==0, totalSells==0). ` +
          `Likely transactionCode filter + share-sign convention issue (I-B).`,
      );
      leadingRead = 'I-B (transactionCode filter exclusion)';
    }
    if (cacheState.cachedShape === 'empty' || cacheState.cachedShape === 'null') {
      IC = 'consistent';
      notes.push(
        `PIT cache for (${ticker}, ${asOfDate}, lb=90) was previously cached as ` +
          `${cacheState.cachedShape}. The deployed scoreTargetAtDate path serves this stale ` +
          `entry without re-fetching. Backtest results depend on the cache state at the time ` +
          `the run executed, not on current provider behaviour. (I-C)`,
      );
      if (!leadingRead) leadingRead = 'I-C (stale cache)';
      else leadingRead = leadingRead + ' + I-C (stale cache)';
    }

    if (!leadingRead) {
      leadingRead = 'inconclusive — see counters and decide';
    }

    const body: DiagResponse = {
      ok: true,
      ticker,
      asOfDate,
      liveAnchorDate,
      pit: {
        raw: pitRaw,
        processed: summarizeProcessed(pitProcessed),
        cache: cacheState,
      },
      live: {
        raw: liveRaw,
        processed: summarizeProcessed(liveProcessed),
      },
      hypotheses: {
        I_A_provider_depth: IA,
        I_B_code_exclusion: IB,
        I_C_stale_cache: IC,
        leadingRead,
      },
      notes,
    };

    log.info('probe_done', {
      ticker,
      asOfDate,
      pitRows: pitRaw.rowCount,
      liveRows: liveRaw.rowCount,
      cacheShape: cacheState.cachedShape,
      leadingRead,
    });
    return json(200, body);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('probe_failed', { ticker, asOfDate, error: msg });
    return json(500, { ok: false, error: msg });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body: JSON.stringify(body, null, 2),
  };
}
