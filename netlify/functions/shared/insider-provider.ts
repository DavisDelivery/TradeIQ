// Insider activity provider — Quiver-backed.
import { quiverGet, q, qn, qdate } from './quiver-client';

export interface InsiderTransaction {
  name: string; share: number; change: number;
  filingDate: string; transactionDate: string;
  transactionPrice: number; transactionCode: string; position: string;
}

export interface InsiderCluster {
  windowStart: string; windowEnd: string;
  buyerCount: number; totalDollarValue: number;
  roles: string[];
  topBuyers: Array<{ name: string; role: string; dollars: number }>;
}

export interface InsiderActivity {
  ticker: string; lookbackDays: number;
  totalBuys: number; totalSells: number;
  netDollars: number; buyDollars: number; sellDollars: number;
  uniqueBuyers: number;
  clusters: InsiderCluster[];
  latestBuy?: { date: string; dollars: number; role: string; name: string };
  firstBuyInAYear: boolean;
  transactions: InsiderTransaction[];
  fetchedAt: string;
}

export async function getInsiderActivity(
  ticker: string,
  lookbackDays = 90,
): Promise<InsiderActivity> {
  const empty: InsiderActivity = {
    ticker, lookbackDays,
    totalBuys: 0, totalSells: 0, netDollars: 0,
    buyDollars: 0, sellDollars: 0, uniqueBuyers: 0,
    clusters: [], firstBuyInAYear: false, transactions: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const raw = await quiverGet<any>(`/live/insiders?ticker=${encodeURIComponent(ticker)}`);
    const rows: any[] = Array.isArray(raw)
      ? raw
      : Array.isArray(raw?.data) ? raw.data
      : Array.isArray(raw?.records) ? raw.records
      : [];
    if (rows.length === 0) return empty;

    const all = rows.map(normalizeTx).filter(Boolean) as InsiderTransaction[];
    const fromIso = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const priorYearIso = new Date(Date.now() - (lookbackDays + 365) * 86400000).toISOString().slice(0, 10);

    const inWindow = all.filter((t) => t.transactionDate >= fromIso);
    const priorYearWindow = all.filter((t) => t.transactionDate >= priorYearIso && t.transactionDate < fromIso);

    const buys = inWindow.filter((t) => t.transactionCode === 'P' && t.share > 0);
    const sells = inWindow.filter((t) => t.transactionCode === 'S' && t.share < 0);

    const buyDollars = buys.reduce((a, t) => a + t.share * t.transactionPrice, 0);
    const sellDollars = sells.reduce((a, t) => a + Math.abs(t.share) * t.transactionPrice, 0);
    const uniqueBuyers = new Set(buys.map((t) => t.name)).size;
    const clusters = detectClusters(buys);

    const latest = buys.length
      ? buys.reduce((a, b) => (a.transactionDate > b.transactionDate ? a : b))
      : undefined;

    const hadPriorYearPurchase = priorYearWindow.some((t) => t.transactionCode === 'P' && t.share > 0);
    const firstBuyInAYear = buys.length > 0 && !hadPriorYearPurchase;

    return {
      ticker, lookbackDays,
      totalBuys: buys.length, totalSells: sells.length,
      netDollars: buyDollars - sellDollars,
      buyDollars, sellDollars, uniqueBuyers, clusters,
      latestBuy: latest ? {
        date: latest.transactionDate,
        dollars: +(latest.share * latest.transactionPrice).toFixed(0),
        role: latest.position || 'Insider',
        name: latest.name,
      } : undefined,
      firstBuyInAYear,
      transactions: buys,
      fetchedAt: new Date().toISOString(),
    };
  } catch { return empty; }
}

function normalizeTx(raw: any): InsiderTransaction | null {
  if (!raw) return null;
  const name = String(q(raw, 'Name', 'name', 'Reporter') ?? '').trim();
  const share = qn(raw, 'Shares', 'shares', 'Amount', 'amount') ?? 0;
  const price = qn(raw, 'PricePerShare', 'Price', 'pricePerShare', 'price') ?? 0;
  const rawCode = String(q(raw, 'TransactionCode', 'transactionCode', 'Code', 'code') ?? '').trim().toUpperCase();
  const ad = String(q(raw, 'AcquiredDisposedCode', 'AcquistionOrDisposition', 'AD') ?? '').trim().toUpperCase();
  const code = rawCode || (ad === 'A' ? 'P' : ad === 'D' ? 'S' : '');

  if (!name || !Number.isFinite(share)) return null;

  return {
    name, share,
    change: qn(raw, 'SharesOwnedFollowingTransaction', 'Change', 'change') ?? 0,
    filingDate: qdate(raw, 'FilingDate', 'filingDate'),
    transactionDate: qdate(raw, 'Date', 'TransactionDate', 'transactionDate'),
    transactionPrice: price,
    transactionCode: code,
    position: String(q(raw, 'Title', 'Position', 'position') ?? '').trim(),
  };
}

function detectClusters(buys: InsiderTransaction[]): InsiderCluster[] {
  if (buys.length < 2) return [];
  const sorted = [...buys].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  const clusters: InsiderCluster[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    const startTs = Date.parse(start.transactionDate);
    let j = i;
    while (j < sorted.length && Date.parse(sorted[j].transactionDate) - startTs <= 14 * 86400000) j++;
    const window = sorted.slice(i, j);
    const names = new Set(window.map((t) => t.name));
    if (names.size >= 2) {
      const roles = Array.from(new Set(window.map((t) => t.position).filter(Boolean)));
      const byName = new Map<string, { dollars: number; role: string }>();
      for (const tx of window) {
        const cur = byName.get(tx.name) ?? { dollars: 0, role: tx.position || 'Insider' };
        cur.dollars += tx.share * tx.transactionPrice;
        byName.set(tx.name, cur);
      }
      const topBuyers = Array.from(byName.entries())
        .map(([name, v]) => ({ name, role: v.role, dollars: +v.dollars.toFixed(0) }))
        .sort((a, b) => b.dollars - a.dollars)
        .slice(0, 5);
      clusters.push({
        windowStart: window[0].transactionDate,
        windowEnd: window[window.length - 1].transactionDate,
        buyerCount: names.size,
        totalDollarValue: +window.reduce((a, t) => a + t.share * t.transactionPrice, 0).toFixed(0),
        roles, topBuyers,
      });
      i = j;
    } else { i++; }
  }
  return clusters;
}

export function scoreInsiderActivity(a: InsiderActivity): {
  score: number; confidence: number; rationale: string; tags: string[];
} {
  const tags: string[] = [];
  let raw = 0;
  const parts: string[] = [];

  if (a.totalBuys === 0 && a.totalSells === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no recent insider activity', tags: [] };
  }

  if (a.clusters.length > 0) {
    const biggest = a.clusters.reduce((x, y) => (y.buyerCount > x.buyerCount ? y : x));
    raw += Math.min(40, biggest.buyerCount * 10);
    tags.push(`${biggest.buyerCount}-insider cluster`);
    parts.push(`${biggest.buyerCount} insiders bought within 14d ($${fmtK(biggest.totalDollarValue)})`);
  }

  const leadershipBuy = a.transactions.some((t) => /(CEO|CFO|CHIEF|PRESIDENT|CHAIR)/i.test(t.position));
  if (leadershipBuy) { raw += 15; tags.push('C-suite buy'); parts.push('C-suite buying'); }

  if (a.netDollars > 5_000_000) { raw += 20; parts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 1_000_000) { raw += 12; parts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 250_000) { raw += 6; parts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars < -5_000_000) { raw -= 10; parts.push(`$${fmtK(Math.abs(a.netDollars))} net sells`); }

  if (a.firstBuyInAYear) {
    raw += 15; tags.push('first buy in 12mo'); parts.push('first insider purchase in 12mo');
  }

  if (a.uniqueBuyers >= 3) raw += 5;

  raw = Math.max(-50, Math.min(50, raw));
  const score = Math.round(50 + raw);
  const confidence = Math.min(1, (a.totalBuys + a.totalSells) / 6);

  return { score, confidence, rationale: parts.join(', ') || 'mixed insider activity', tags };
}

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
