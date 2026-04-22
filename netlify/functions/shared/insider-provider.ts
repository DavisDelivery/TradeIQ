// Insider activity provider.
//
// Pulls Form 4 insider transactions from Finnhub (already have the key) and
// normalizes into a shape the rest of the app can reason about.
//
// What matters in insider buying (from decades of academic research):
//   - Open-market PURCHASES only. Option exercises are usually comp, not
//     conviction. Gifts, planned 10b5-1 sales, and automatic ESPPs are noise.
//   - CLUSTER buys (2+ insiders in the same 14-day window) dramatically
//     outperform lone-insider signals (Cohen/Malloy/Pomorski 2012).
//   - Size relative to salary matters. A $50K buy by a $5M-comp CEO is a
//     rounding error. A $500K buy by a $400K-salary CFO is a signal.
//   - Role matters. CEO + CFO + Director cluster > three random VPs.
//   - Post-drawdown buys (stock down 15%+ in prior 30d) are the loudest: the
//     insider is explicitly saying "the street is wrong about this".
//   - First-buy-in-a-year events are statistically meaningful — an insider
//     who hasn't bought in 12+ months suddenly stepping up is high-signal.
//
// We do NOT try to detect sells for shorting ideas. Insider selling has very
// low predictive power (taxes, diversification, lifestyle — a hundred reasons
// to sell that have nothing to do with the stock).

const FINNHUB = 'https://finnhub.io/api/v1';

function finnhubKey(): string {
  const k = process.env.FINNHUB_API_KEY;
  if (!k) throw new Error('FINNHUB_API_KEY not set');
  return k;
}

export interface InsiderTransaction {
  name: string;
  share: number;        // +buys, -sells
  change: number;       // net change in shares held
  filingDate: string;   // ISO date
  transactionDate: string;
  transactionPrice: number;
  transactionCode: string; // P=purchase, S=sale, A=grant, M=exercise, F=tax
  position: string;        // "CEO", "Director", etc.
}

export interface InsiderCluster {
  windowStart: string;
  windowEnd: string;
  buyerCount: number;
  totalDollarValue: number;
  roles: string[];          // deduped roles in the cluster
  topBuyers: Array<{ name: string; role: string; dollars: number }>;
}

export interface InsiderActivity {
  ticker: string;
  lookbackDays: number;
  totalBuys: number;        // count of open-market purchases
  totalSells: number;
  netDollars: number;       // net buy - sell dollars
  buyDollars: number;
  sellDollars: number;
  uniqueBuyers: number;
  clusters: InsiderCluster[]; // any 14-day windows with 2+ distinct buyers
  latestBuy?: {
    date: string;
    dollars: number;
    role: string;
    name: string;
  };
  firstBuyInAYear: boolean;  // true if no purchases in prior 12mo before this window
  transactions: InsiderTransaction[];
  fetchedAt: string;
}

// In-memory cache per function invocation. Lambda cold-start gives us a fresh
// cache; warm invocations reuse it — saves a second per repeat ticker in a
// board scan.
const cache = new Map<string, { data: InsiderActivity; at: number }>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

export async function getInsiderActivity(
  ticker: string,
  lookbackDays = 90,
): Promise<InsiderActivity> {
  const cacheKey = `${ticker}:${lookbackDays}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.data;

  const empty: InsiderActivity = {
    ticker,
    lookbackDays,
    totalBuys: 0,
    totalSells: 0,
    netDollars: 0,
    buyDollars: 0,
    sellDollars: 0,
    uniqueBuyers: 0,
    clusters: [],
    firstBuyInAYear: false,
    transactions: [],
    fetchedAt: new Date().toISOString(),
  };

  try {
    const to = new Date();
    const from = new Date(Date.now() - lookbackDays * 86400000);
    // Also pull the prior year for first-buy-in-a-year detection
    const priorYearFrom = new Date(Date.now() - (lookbackDays + 365) * 86400000);

    const url = `${FINNHUB}/stock/insider-transactions?symbol=${ticker}&from=${priorYearFrom.toISOString().slice(0,10)}&to=${to.toISOString().slice(0,10)}&token=${finnhubKey()}`;
    const res = await fetch(url);
    if (!res.ok) {
      cache.set(cacheKey, { data: empty, at: Date.now() });
      return empty;
    }
    const data = (await res.json()) as { data?: any[] };
    const all = (data.data ?? []).map(normalizeTx).filter(Boolean) as InsiderTransaction[];

    const fromIso = from.toISOString().slice(0, 10);
    const inWindow = all.filter((t) => t.transactionDate >= fromIso);
    const beforeWindow = all.filter((t) => t.transactionDate < fromIso);

    // Open-market purchases only. Finnhub maps: P = purchase, S = sale.
    // A (grant), M (option exercise), F (tax withholding), G (gift) are not conviction events.
    const buys = inWindow.filter((t) => t.transactionCode === 'P' && t.share > 0);
    const sells = inWindow.filter((t) => t.transactionCode === 'S' && t.share < 0);

    const buyDollars = buys.reduce((a, t) => a + t.share * t.transactionPrice, 0);
    const sellDollars = sells.reduce((a, t) => a + Math.abs(t.share) * t.transactionPrice, 0);
    const uniqueBuyers = new Set(buys.map((t) => t.name)).size;

    const clusters = detectClusters(buys);

    const latest = buys.length
      ? buys.reduce((a, b) => (a.transactionDate > b.transactionDate ? a : b))
      : undefined;

    const hadPriorYearPurchase = beforeWindow.some(
      (t) => t.transactionCode === 'P' && t.share > 0,
    );
    const firstBuyInAYear = buys.length > 0 && !hadPriorYearPurchase;

    const out: InsiderActivity = {
      ticker,
      lookbackDays,
      totalBuys: buys.length,
      totalSells: sells.length,
      netDollars: buyDollars - sellDollars,
      buyDollars,
      sellDollars,
      uniqueBuyers,
      clusters,
      latestBuy: latest
        ? {
            date: latest.transactionDate,
            dollars: +(latest.share * latest.transactionPrice).toFixed(0),
            role: latest.position || 'Insider',
            name: latest.name,
          }
        : undefined,
      firstBuyInAYear,
      transactions: buys, // only surface the relevant ones; sells aren't actionable
      fetchedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, { data: out, at: Date.now() });
    return out;
  } catch {
    cache.set(cacheKey, { data: empty, at: Date.now() });
    return empty;
  }
}

function normalizeTx(raw: any): InsiderTransaction | null {
  if (!raw) return null;
  const name = String(raw.name ?? '').trim();
  const share = Number(raw.share ?? 0);
  const change = Number(raw.change ?? 0);
  const price = Number(raw.transactionPrice ?? 0);
  const code = String(raw.transactionCode ?? '').trim().toUpperCase();
  if (!name || !Number.isFinite(share) || !Number.isFinite(price)) return null;
  return {
    name,
    share,
    change,
    filingDate: String(raw.filingDate ?? ''),
    transactionDate: String(raw.transactionDate ?? ''),
    transactionPrice: price,
    transactionCode: code,
    position: String(raw.position ?? '').trim(),
  };
}

// A cluster = 2+ distinct insiders buying within a 14-day rolling window.
// We scan by earliest buy date and grow the window; this over-counts slightly
// (a single burst can be reported as one big cluster) but that's what we want —
// a wave of insiders is the signal.
function detectClusters(buys: InsiderTransaction[]): InsiderCluster[] {
  if (buys.length < 2) return [];
  const sorted = [...buys].sort((a, b) => a.transactionDate.localeCompare(b.transactionDate));
  const clusters: InsiderCluster[] = [];
  let i = 0;
  while (i < sorted.length) {
    const start = sorted[i];
    const startTs = Date.parse(start.transactionDate);
    let j = i;
    while (
      j < sorted.length &&
      Date.parse(sorted[j].transactionDate) - startTs <= 14 * 86400000
    ) {
      j++;
    }
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
      roles,
        topBuyers,
      });
      i = j;
    } else {
      i++;
    }
  }
  return clusters;
}

// 0-100 insider bullishness score with rationale. Centralized here so every
// analyst, board, and view uses the same formula.
export function scoreInsiderActivity(a: InsiderActivity): {
  score: number;
  confidence: number;
  rationale: string;
  tags: string[];
} {
  const tags: string[] = [];
  let raw = 0;
  const rationaleParts: string[] = [];

  if (a.totalBuys === 0 && a.totalSells === 0) {
    return { score: 50, confidence: 0.1, rationale: 'no recent insider activity', tags: [] };
  }

  // Cluster buys are the loudest signal
  if (a.clusters.length > 0) {
    const biggest = a.clusters.reduce((x, y) => (y.buyerCount > x.buyerCount ? y : x));
    raw += Math.min(40, biggest.buyerCount * 10);
    tags.push(`${biggest.buyerCount}-insider cluster`);
    rationaleParts.push(`${biggest.buyerCount} insiders bought within 14d ($${fmtK(biggest.totalDollarValue)})`);
  }

  // Leadership buying (CEO/CFO) matters more than director buying
  const leadershipBuy = a.transactions.some((t) =>
    /(CEO|CFO|CHIEF|PRESIDENT|CHAIR)/i.test(t.position),
  );
  if (leadershipBuy) {
    raw += 15;
    tags.push('C-suite buy');
    rationaleParts.push('C-suite buying');
  }

  // Net dollar magnitude
  if (a.netDollars > 5_000_000) { raw += 20; rationaleParts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 1_000_000) { raw += 12; rationaleParts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars > 250_000) { raw += 6; rationaleParts.push(`$${fmtK(a.netDollars)} net buys`); }
  else if (a.netDollars < -5_000_000) { raw -= 10; rationaleParts.push(`$${fmtK(Math.abs(a.netDollars))} net sells`); }

  // First buy in a year — strong regime-change signal
  if (a.firstBuyInAYear) {
    raw += 15;
    tags.push('first buy in 12mo');
    rationaleParts.push('first insider purchase in 12mo');
  }

  // Unique buyers beyond the cluster threshold
  if (a.uniqueBuyers >= 3) raw += 5;

  raw = Math.max(-50, Math.min(50, raw));
  const score = Math.round(50 + raw);
  const confidence = Math.min(1, (a.totalBuys + a.totalSells) / 6);

  return {
    score,
    confidence,
    rationale: rationaleParts.join(', ') || 'mixed insider activity',
    tags,
  };
}

function fmtK(n: number): string {
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(0)}K`;
  return String(Math.round(n));
}
