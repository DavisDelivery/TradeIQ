// Insider activity provider — Finnhub-backed.
//
// Quiver's /live/insiders endpoint is gated to a higher subscription tier
// on this account (returns 403 "Upgrade your subscription"). Finnhub's
// /stock/insider-transactions exposes the same SEC Form 4 data on the plan
// we already use, so we route through there instead.
//
// API contract for the rest of the codebase is unchanged — same exported
// types (InsiderActivity / InsiderCluster / InsiderTransaction), same
// scoring function, same caller signatures. Catalyst board, Prophet,
// and analyst-runner are unaffected (they all just import getInsiderActivity).
//
// Caveat vs Quiver: Finnhub does not expose the insider's role/title
// (CEO/CFO/Director). The `position` field on InsiderTransaction will be
// empty, and the C-suite-buy bonus in scoreInsiderActivity is therefore
// unreachable. We compensate by leaning more weight onto the buyer-count
// and net-dollars signals which Finnhub does carry cleanly.

import { getFinnhubInsiderTransactions, type FinnhubInsiderTx } from './data-provider';
import { lookupInsiderRole } from './edgar-roles';

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
    // Pull lookback + 365d so firstBuyInAYear has reference data.
    const fetchDays = lookbackDays + 365;
    const raw = await getFinnhubInsiderTransactions(ticker, fetchDays);
    if (raw.length === 0) return empty;

    const all = raw.map(normalizeFinnhubTx).filter(Boolean) as InsiderTransaction[];
    const fromIso = new Date(Date.now() - lookbackDays * 86400000).toISOString().slice(0, 10);
    const priorYearIso = new Date(Date.now() - (lookbackDays + 365) * 86400000).toISOString().slice(0, 10);

    const inWindow = all.filter((t) => t.transactionDate >= fromIso);
    const priorYearWindow = all.filter((t) => t.transactionDate >= priorYearIso && t.transactionDate < fromIso);

    // NOTE: code 'P' (open-market purchase) is the high-signal signal. Code
    // 'A' (award/grant — RSUs, stock comp) is mechanically a holding increase
    // but carries near-zero signal because executives don't choose to receive
    // grants on a particular date — they're scheduled. We exclude 'A' from
    // buys to keep the score signal-clean. Same logic as the new insider-board
    // dedicated tab. Sells: 'S' = open-market sale (mostly noisy due to 10b5-1
    // plans, but at least real economic exits).
    const buys = inWindow.filter((t) => t.transactionCode === 'P' && t.share > 0);
    const sells = inWindow.filter((t) => t.transactionCode === 'S' && t.share < 0);

    const buyDollars = buys.reduce((a, t) => a + t.share * t.transactionPrice, 0);
    const sellDollars = sells.reduce((a, t) => a + Math.abs(t.share) * t.transactionPrice, 0);
    const uniqueBuyers = new Set(buys.map((t) => t.name)).size;

    // EDGAR role enrichment — fills in the `position` field on each buy
    // so scoreInsiderActivity's C-suite detection (regex match on position)
    // can fire. Bounded by a tight 2s budget to keep catalyst-board's
    // per-ticker scan fast. Falls through silently on timeout — the
    // unenriched path still produces a valid score, just without the
    // C-suite +15 bonus.
    if (buys.length > 0 && buys.length <= 10) {
      try {
        const uniqueNames = Array.from(new Set(buys.map((b) => b.name)));
        const ENRICH_BUDGET_MS = 2000;
        const enrichStarted = Date.now();
        const roleByName = new Map<string, string | null>();
        // Limit to 5 unique names per ticker to bound the work — the top 5
        // by frequency are the ones most likely to be C-suite anyway.
        const namesToLookup = uniqueNames.slice(0, 5);
        await Promise.all(
          namesToLookup.map(async (n) => {
            if (Date.now() - enrichStarted > ENRICH_BUDGET_MS) return;
            const role = await lookupInsiderRole(n, ticker).catch(() => null);
            if (role) roleByName.set(n, role);
          }),
        );
        // Fill enriched roles back onto the buy transactions
        for (const b of buys) {
          const r = roleByName.get(b.name);
          if (r) b.position = r;
        }
      } catch {
        // Swallow — score still works without role data
      }
    }

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

function normalizeFinnhubTx(raw: FinnhubInsiderTx): InsiderTransaction | null {
  if (!raw || !raw.name || !raw.transactionDate) return null;
  // Finnhub's `change` is the signed delta. `share` in their schema is the
  // post-transaction holding count, which we don't need here. We use change
  // as the count (with sign) because the consumers below check sign for
  // direction (share > 0 = buy, share < 0 = sell).
  if (!Number.isFinite(raw.change)) return null;

  return {
    name: raw.name,
    share: raw.change,                     // signed delta — direction-bearing
    change: raw.change,                    // keep both for future-proofing
    filingDate: raw.filingDate || raw.transactionDate,
    transactionDate: raw.transactionDate,
    transactionPrice: raw.transactionPrice,
    transactionCode: raw.transactionCode,
    position: '',                          // not exposed by Finnhub
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

  // C-suite detection only fires if a downstream caller fills `position`.
  // Finnhub doesn't, so this branch effectively returns false on the new path.
  // We keep the check (rather than removing) so that if Quiver/EDGAR sources
  // are added later with role data, the bonus reactivates automatically.
  const leadershipBuy = a.transactions.some((t) => /(CEO|CFO|CHIEF|PRESIDENT|CHAIR)/i.test(t.position));
  if (leadershipBuy) { raw += 15; tags.push('C-suite buy'); parts.push('C-suite buying'); }

  // Compensate for the lost C-suite bonus by giving slightly more weight to
  // raw-dollar size. Without role data, a $5M buy by 'an insider' is the
  // most actionable signal we have.
  if (a.netDollars > 5_000_000) { raw += 22; parts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 1_000_000) { raw += 14; parts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 250_000) { raw += 7; parts.push(`$${fmtK(a.netDollars)} net buys`); }
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
