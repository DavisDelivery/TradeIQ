// Shared scan orchestrator for the insider board.
//
// Strategy: scheduled scan always runs at the widest window (180 days) and
// stores the full filings array per row. Live endpoint reads the snapshot,
// filters filings by the user's requested window, and re-aggregates buy /
// award / sell dollars for that subset. This means one snapshot per
// universe per scan covers all 4 window variants (30/60/90/180) without
// 4× the storage or scan cost.

import { UNIVERSE, inIndex, type IndexTag } from './universe';
import { getFinnhubInsiderTransactions } from './data-provider';
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

      const row: InsiderBoardRow = {
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
        filings,
      };
      rows.push(row);
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
      filings,
    });
  }
  out.sort((a, b) => {
    if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
    return b.awardDollars - a.awardDollars;
  });
  return out;
}
