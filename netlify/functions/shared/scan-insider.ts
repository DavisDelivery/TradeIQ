// Shared scan orchestrator for the insider board.
//
// Strategy: scheduled scan always runs at the widest window (180 days) and
// stores the full filings array per row. Live endpoint reads the snapshot,
// filters filings by the user's requested window, and re-aggregates buy /
// award / sell dollars for that subset. This means one snapshot per
// universe per scan covers all 4 window variants (30/60/90/180) without
// 4× the storage or scan cost.
//
// Phase 4l W2 splits the per-ticker scan loop out of `runInsiderScan` into
// `runInsiderScanBatch` so the russell2k background worker can iterate
// batches against the same Firestore cursor + reinvoke chain used by
// 4h target-board. `runInsiderScan` (single-pass) stays for the
// sp500/ndx/dow scheduled scans whose universe fits the 14-min budget.

import { UNIVERSE, inIndex, type IndexTag } from './universe';
import { getFinnhubInsiderTransactions, getPreviousClose } from './data-provider';
import { lookupInsiderRole } from './edgar-roles';
import type { InsiderBoardRow } from './types';
import { mapWithConcurrency } from './full-scan-iterator';
import type { Logger } from './logger';

export type InsiderUniverseKey = IndexTag | 'all';

export const INSIDER_SCHEDULED_WINDOW_DAYS = 180;

export interface RunInsiderScanOpts {
  universe: InsiderUniverseKey;
  windowDays: number;
  scanCap?: number;
  scanBudgetMs: number;
  concurrency?: number;
  /** True for scheduled scans — enables EDGAR role enrichment (slow). */
  enrichRoles?: boolean;
  /** True for scheduled scans — enables Polygon price enrichment (cheap). */
  enrichPrice?: boolean;
  logger?: Logger;
}

export interface RunInsiderScanResult {
  rows: InsiderBoardRow[];
  scanDurationMs: number;
  universeChecked: number;
  scanned: number;
  warnings: string[];
  budgetExceeded: boolean;
}

interface InsiderFiling {
  name: string;
  role: string;
  shares: number;
  dollars: number;
  filingDate: string;
  transactionDate: string;
  code: string;
  daysSince: number;
}

/**
 * Resolve a universe key to the full ticker list. Mirrors
 * `resolveTargetUniverse` from scan-target.ts so the bg-worker can iterate.
 */
export function resolveInsiderUniverse(universe: InsiderUniverseKey): string[] {
  if (universe === 'all') return UNIVERSE.map((u) => u.ticker);
  return inIndex(universe).map((u) => u.ticker);
}

export interface RunInsiderScanBatchOpts {
  universe: InsiderUniverseKey;
  windowDays: number;
  /** Inclusive start index into the universe ticker list. */
  startIdx: number;
  /** Max tickers to consume in this batch. */
  batchSize: number;
  concurrency?: number;
  /** True for scheduled scans — enables EDGAR role enrichment for top buyers
   *  found in this batch. Off for live (capped) paths. */
  enrichRoles?: boolean;
  /** True for scheduled scans — fetches a Polygon previous-close per
   *  surviving row. ~1 call per ticker with insider activity in window. */
  enrichPrice?: boolean;
  logger?: Logger;
}

export interface RunInsiderScanBatchResult {
  rows: InsiderBoardRow[];
  tickersConsumed: number;
  warnings: string[];
}

/**
 * Phase 4l W2 — process a contiguous slice of the universe for the insider
 * scan. Per-ticker logic mirrors `runInsiderScan` exactly (same
 * Finnhub call, same window filter, same aggregation). Optional role and
 * price enrichment runs over the rows this batch produced (top buyers /
 * surviving tickers only), bounded so a single batch can't blow its
 * caller's wall-clock budget.
 *
 * Used by `scan-insider-russell2k-background.ts`. The bg-worker
 * appends each batch's rows to a partial subcollection and reinvokes
 * itself when the watchdog trips; the terminal batch reads back the
 * full partial set, sorts, and writes one snapshot.
 */
export async function runInsiderScanBatch(
  opts: RunInsiderScanBatchOpts,
): Promise<RunInsiderScanBatchResult> {
  const log = opts.logger;
  const warnings: string[] = [];
  const allTickers = resolveInsiderUniverse(opts.universe);
  const slice = allTickers.slice(opts.startIdx, opts.startIdx + opts.batchSize);

  if (slice.length === 0) {
    return { rows: [], tickersConsumed: 0, warnings };
  }

  const now = Date.now();
  const cutoffTs = now - opts.windowDays * 86_400_000;
  const rows: InsiderBoardRow[] = [];

  await mapWithConcurrency(
    slice,
    async (ticker) => {
      const txs = await getFinnhubInsiderTransactions(ticker, opts.windowDays);
      if (txs.length === 0) return null;
      const row = buildRowFromTxs(ticker, txs, cutoffTs, now);
      if (row) rows.push(row);
      return row;
    },
    {
      batchSize: opts.concurrency ?? 8,
      onError: (err, ticker) => {
        log?.warn('insider_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  // Polygon price enrichment for the rows this batch produced. Cheap:
  // ~1 call per ticker with insider activity. Failures are tolerated —
  // `price: null` flows through to the UI which shows "—".
  if (opts.enrichPrice && rows.length > 0) {
    const byTicker = new Map(rows.map((r) => [r.ticker, r] as const));
    await mapWithConcurrency(
      rows.map((r) => r.ticker),
      async (ticker) => {
        try {
          const prev = await getPreviousClose(ticker);
          if (prev) {
            const r = byTicker.get(ticker);
            if (r) r.price = +prev.c.toFixed(2);
          }
        } catch (err: any) {
          log?.warn('insider_price_enrich_failed', { ticker, err: String(err) });
        }
      },
      { batchSize: opts.concurrency ?? 8 },
    );
  }

  // EDGAR role enrichment for the top buyers in this batch's rows.
  if (opts.enrichRoles) {
    const enrichTargets = rows.filter((r) => r.topBuyer !== null);
    for (let i = 0; i < enrichTargets.length; i += 5) {
      const chunk = enrichTargets.slice(i, i + 5);
      const roles = await Promise.all(
        chunk.map((r) => lookupInsiderRole(r.topBuyer!.name, r.ticker).catch(() => null)),
      );
      for (let j = 0; j < chunk.length; j++) {
        const role = roles[j];
        if (role && chunk[j].topBuyer) {
          chunk[j].topBuyer = { ...chunk[j].topBuyer!, role };
        }
      }
    }
  }

  log?.debug('insider_batch_complete', {
    universe: opts.universe,
    startIdx: opts.startIdx,
    consumed: slice.length,
    scored: rows.length,
  });

  return { rows, tickersConsumed: slice.length, warnings };
}

/**
 * Build a single InsiderBoardRow from a list of Finnhub insider
 * transactions filtered to the window. Returns null when nothing in the
 * window is a non-derivative buy/award/sell. Shared between the
 * single-pass `runInsiderScan` and the batch-based `runInsiderScanBatch`.
 */
function buildRowFromTxs(
  ticker: string,
  txs: Awaited<ReturnType<typeof getFinnhubInsiderTransactions>>,
  cutoffTs: number,
  now: number,
): InsiderBoardRow | null {
  const inWindow = txs.filter((tx) => {
    if (!tx.transactionDate) return false;
    if (tx.isDerivative) return false;
    const txTs = new Date(tx.transactionDate).getTime();
    return txTs >= cutoffTs;
  });
  if (inWindow.length === 0) return null;

  const filings: InsiderFiling[] = inWindow
    .map((tx) => {
      const sharesAbs = Math.abs(tx.change);
      const dollars = sharesAbs * tx.transactionPrice;
      const txTs = new Date(tx.transactionDate).getTime();
      return {
        name: tx.name,
        role: '—',
        shares: tx.change,
        dollars: +dollars.toFixed(0),
        filingDate: tx.filingDate || tx.transactionDate,
        transactionDate: tx.transactionDate,
        code: tx.transactionCode || (tx.change > 0 ? 'P' : 'S'),
        daysSince: Math.max(0, Math.round((now - txTs) / 86_400_000)),
      };
    })
    .sort((a, b) => a.daysSince - b.daysSince);

  const agg = aggregate(filings);
  if (agg.totalBuys === 0 && agg.totalAwards === 0 && agg.totalSells === 0) return null;

  return {
    ticker,
    buyDollars: +agg.buyDollars.toFixed(0),
    awardDollars: +agg.awardDollars.toFixed(0),
    sellDollars: +agg.sellDollars.toFixed(0),
    netDollars: +(agg.buyDollars - agg.sellDollars).toFixed(0),
    buyerCount: agg.buyers.size,
    totalBuys: agg.totalBuys,
    totalAwards: agg.totalAwards,
    totalSells: agg.totalSells,
    topBuyer: agg.topBuyer,
    latestFilingDate: filings.length > 0 ? filings[0].filingDate : null,
    daysSinceLatest: filings.length > 0 ? filings[0].daysSince : null,
    price: null,
    filings,
  };
}

export async function runInsiderScan(opts: RunInsiderScanOpts): Promise<RunInsiderScanResult> {
  const log = opts.logger;
  const start = Date.now();
  const warnings: string[] = [];

  const all = opts.universe === 'all' ? UNIVERSE : inIndex(opts.universe);
  const universeChecked = all.length;
  const cap = opts.scanCap ?? Infinity;
  const scanList = isFinite(cap) ? all.slice(0, cap) : all;

  log?.info('insider_scan_started', {
    universe: opts.universe,
    universeSize: universeChecked,
    windowDays: opts.windowDays,
    scanCap: cap === Infinity ? 'Infinity' : cap,
    enrichRoles: !!opts.enrichRoles,
    enrichPrice: !!opts.enrichPrice,
    budgetMs: opts.scanBudgetMs,
  });

  const now = Date.now();
  const cutoffTs = now - opts.windowDays * 86_400_000;
  let budgetExceeded = false;
  const rows: InsiderBoardRow[] = [];

  await mapWithConcurrency(
    scanList.map((t) => t.ticker),
    async (ticker) => {
      const txs = await getFinnhubInsiderTransactions(ticker, opts.windowDays);
      if (txs.length === 0) return null;
      const row = buildRowFromTxs(ticker, txs, cutoffTs, now);
      if (row) rows.push(row);
      return row;
    },
    {
      batchSize: opts.concurrency ?? 8,
      shouldAbort: () => {
        if (Date.now() - start > opts.scanBudgetMs) {
          budgetExceeded = true;
          warnings.push('insider scan budget exceeded; results may be partial');
          return true;
        }
        return false;
      },
      onError: (err, ticker) => {
        log?.warn('insider_ticker_error', { ticker, err: String(err) });
      },
    },
  );

  rows.sort((a, b) => {
    if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
    return b.awardDollars - a.awardDollars;
  });

  // Polygon price enrichment for scheduled scans (cheap: ~1 call per
  // surviving ticker, concurrency-limited). The live capped path leaves
  // it off because the snapshot path will refresh price next scan.
  if (opts.enrichPrice && rows.length > 0) {
    const byTicker = new Map(rows.map((r) => [r.ticker, r] as const));
    await mapWithConcurrency(
      rows.map((r) => r.ticker),
      async (ticker) => {
        if (Date.now() - start > opts.scanBudgetMs) {
          warnings.push('insider price-enrichment budget exceeded');
          return;
        }
        try {
          const prev = await getPreviousClose(ticker);
          if (prev) {
            const r = byTicker.get(ticker);
            if (r) r.price = +prev.c.toFixed(2);
          }
        } catch (err: any) {
          log?.warn('insider_price_enrich_failed', { ticker, err: String(err) });
        }
      },
      { batchSize: opts.concurrency ?? 8 },
    );
  }

  // EDGAR role enrichment — only for scheduled scans (we have 14 min there).
  if (opts.enrichRoles) {
    const enrichTargets = rows.filter((r) => r.topBuyer !== null);
    for (let i = 0; i < enrichTargets.length; i += 5) {
      if (Date.now() - start > opts.scanBudgetMs) {
        warnings.push('insider role-enrichment budget exceeded');
        break;
      }
      const chunk = enrichTargets.slice(i, i + 5);
      const roles = await Promise.all(
        chunk.map((r) => lookupInsiderRole(r.topBuyer!.name, r.ticker).catch(() => null)),
      );
      for (let j = 0; j < chunk.length; j++) {
        const role = roles[j];
        if (role && chunk[j].topBuyer) {
          chunk[j].topBuyer = { ...chunk[j].topBuyer!, role };
        }
      }
    }
  }

  const scanDurationMs = Date.now() - start;
  log?.info('insider_scan_complete', {
    universe: opts.universe,
    universeChecked,
    scanned: scanList.length,
    rows: rows.length,
    scanDurationMs,
    enriched: !!opts.enrichRoles,
    priceEnriched: !!opts.enrichPrice,
  });

  return {
    rows,
    scanDurationMs,
    universeChecked,
    scanned: scanList.length,
    warnings,
    budgetExceeded,
  };
}

function aggregate(filings: InsiderFiling[]): {
  buyDollars: number;
  awardDollars: number;
  sellDollars: number;
  totalBuys: number;
  totalAwards: number;
  totalSells: number;
  buyers: Set<string>;
  topBuyer: { name: string; role: string; dollars: number } | null;
} {
  let buyDollars = 0;
  let awardDollars = 0;
  let sellDollars = 0;
  let totalBuys = 0;
  let totalAwards = 0;
  let totalSells = 0;
  const buyers = new Set<string>();
  const buyerTotals = new Map<string, { name: string; role: string; dollars: number }>();
  for (const f of filings) {
    const isBuy = f.shares > 0 && f.code === 'P';
    const isAward = f.shares > 0 && f.code === 'A';
    const isSell = f.shares < 0 && (f.code === 'S' || f.code === 'D');
    if (isBuy) {
      buyDollars += f.dollars;
      totalBuys += 1;
      buyers.add(f.name);
      const cur = buyerTotals.get(f.name) ?? { name: f.name, role: f.role, dollars: 0 };
      cur.dollars += f.dollars;
      buyerTotals.set(f.name, cur);
    } else if (isAward) {
      awardDollars += f.dollars;
      totalAwards += 1;
    } else if (isSell) {
      sellDollars += f.dollars;
      totalSells += 1;
    }
  }
  const topBuyer =
    buyerTotals.size > 0
      ? Array.from(buyerTotals.values()).sort((a, b) => b.dollars - a.dollars)[0]
      : null;
  return {
    buyDollars,
    awardDollars,
    sellDollars,
    totalBuys,
    totalAwards,
    totalSells,
    buyers,
    topBuyer,
  };
}

/**
 * Re-filter a stored snapshot's rows to a narrower windowDays. Used by the
 * live endpoint when the snapshot was taken at the maximal window (180d) but
 * the user requested a narrower window (30/60/90).
 *
 * Re-aggregates buy/award/sell dollars from the surviving filings.
 */
export function filterRowsToWindow(
  rows: InsiderBoardRow[],
  windowDays: number,
  now: number = Date.now(),
): InsiderBoardRow[] {
  const cutoffTs = now - windowDays * 86_400_000;
  const out: InsiderBoardRow[] = [];
  for (const r of rows) {
    const filings = (r.filings as InsiderFiling[]).filter(
      (f) => new Date(f.transactionDate).getTime() >= cutoffTs,
    );
    if (filings.length === 0) continue;
    const agg = aggregate(filings);
    if (agg.totalBuys === 0 && agg.totalAwards === 0 && agg.totalSells === 0) continue;
    out.push({
      ticker: r.ticker,
      buyDollars: +agg.buyDollars.toFixed(0),
      awardDollars: +agg.awardDollars.toFixed(0),
      sellDollars: +agg.sellDollars.toFixed(0),
      netDollars: +(agg.buyDollars - agg.sellDollars).toFixed(0),
      buyerCount: agg.buyers.size,
      totalBuys: agg.totalBuys,
      totalAwards: agg.totalAwards,
      totalSells: agg.totalSells,
      topBuyer: agg.topBuyer ?? r.topBuyer, // keep enriched role if cached
      latestFilingDate: filings[0].filingDate,
      daysSinceLatest: filings[0].daysSince,
      price: r.price ?? null, // carry through any enriched price from the source row
      filings,
    });
  }
  out.sort((a, b) => {
    if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
    return b.awardDollars - a.awardDollars;
  });
  return out;
}
