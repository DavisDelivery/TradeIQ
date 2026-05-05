// GET /api/insider-board?days=90&limit=100&index=sp500|all
// Returns aggregated insider activity across the universe, sorted by
// total $ value bought (desc) by default. Each row carries summary stats
// + the underlying filings so the frontend can render expandable detail.
//
// Data source: Finnhub /stock/insider-transactions (Form 4 feed).
// (We previously planned on Quiver's /live/insiders, but that endpoint
// is gated to a higher subscription tier on this account — returns 403
// "Upgrade your subscription". Finnhub exposes the same SEC Form 4 data
// on the plan we already use.)
//
// Caveat vs Quiver: Finnhub does not include the insider's role/title
// (CEO/CFO/Director/etc.). Role columns therefore render as "—".
//
// Caching: per-window TTL 30min, NEVER cache empty results (consistent
// with v0.7.18/v0.7.19/v0.7.21 cache-poisoning fix pattern).

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { getFinnhubInsiderTransactions } from './shared/data-provider';
import type { InsiderBoardResponse, InsiderBoardRow } from './shared/types';

const ALLOWED_WINDOWS = [30, 60, 90, 180] as const;
const resultCache = new Map<string, { data: InsiderBoardResponse; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

export const handler: Handler = async (event) => {
  try {
    const qs = event.queryStringParameters ?? {};
    const rawDays = Number(qs.days);
    const windowDays: number = (ALLOWED_WINDOWS as readonly number[]).includes(rawDays)
      ? rawDays
      : 90;
    const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
    const limit = Math.min(Number(qs.limit ?? 100), 200);

    const cacheKey = `${windowDays}|${indexFilter}|${limit}`;
    const cached = resultCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      return json(200, { ...cached.data, cached: true });
    }

    const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
    if (tickers.length === 0) return json(400, { error: `unknown index: ${indexFilter}` });

    // Cap at 120 tickers per scan to fit the 26s budget.
    const scanList = tickers.slice(0, Math.min(tickers.length, 120));
    const now = Date.now();
    const cutoffTs = now - windowDays * 86400000;

    const rows: InsiderBoardRow[] = [];
    const concurrency = 8;
    const SCAN_BUDGET_MS = 22000;
    const startedAt = Date.now();

    for (let i = 0; i < scanList.length; i += concurrency) {
      if (Date.now() - startedAt > SCAN_BUDGET_MS) break;
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (t) => {
          try {
            const txs = await getFinnhubInsiderTransactions(t.ticker, windowDays);
            if (txs.length === 0) return null;

            // Filter to window + skip derivative-only rows (option exercises etc.)
            // Open-market buys (P) and sales (S) on common stock are what carry signal.
            const inWindow = txs.filter((tx) => {
              if (!tx.transactionDate) return false;
              if (tx.isDerivative) return false;
              const txTs = new Date(tx.transactionDate).getTime();
              return txTs >= cutoffTs;
            });
            if (inWindow.length === 0) return null;

            // Build filings list with derived $ value & day-since.
            // Use change (signed delta) as ground truth for buy/sell direction.
            const filings = inWindow
              .map((tx) => {
                const sharesAbs = Math.abs(tx.change);
                const dollars = sharesAbs * tx.transactionPrice;
                const txTs = new Date(tx.transactionDate).getTime();
                return {
                  name: tx.name,
                  role: '—', // Finnhub doesn't expose this; intentional placeholder
                  shares: tx.change, // keep signed so frontend can color
                  dollars: +dollars.toFixed(0),
                  filingDate: tx.filingDate || tx.transactionDate,
                  transactionDate: tx.transactionDate,
                  code: tx.transactionCode || (tx.change > 0 ? 'P' : 'S'),
                  daysSince: Math.max(0, Math.round((now - txTs) / 86400000)),
                };
              })
              .sort((a, b) => a.daysSince - b.daysSince);

            // Aggregates
            let buyDollars = 0;
            let sellDollars = 0;
            let totalBuys = 0;
            let totalSells = 0;
            const buyers = new Set<string>();
            const buyerTotals = new Map<string, { name: string; role: string; dollars: number }>();
            for (const f of filings) {
              const isBuy = f.shares > 0 && (f.code === 'P' || f.code === 'A');
              const isSell = f.shares < 0 && (f.code === 'S' || f.code === 'D');
              if (isBuy) {
                buyDollars += f.dollars;
                totalBuys += 1;
                buyers.add(f.name);
                const cur = buyerTotals.get(f.name) ?? { name: f.name, role: f.role, dollars: 0 };
                cur.dollars += f.dollars;
                buyerTotals.set(f.name, cur);
              } else if (isSell) {
                sellDollars += f.dollars;
                totalSells += 1;
              }
            }

            // No activity at all (e.g. only derivative or unrecognized codes) — skip.
            if (totalBuys === 0 && totalSells === 0) return null;

            const topBuyer = buyerTotals.size > 0
              ? Array.from(buyerTotals.values()).sort((a, b) => b.dollars - a.dollars)[0]
              : null;

            const latestFilingDate = filings.length > 0 ? filings[0].filingDate : null;
            const daysSinceLatest = filings.length > 0 ? filings[0].daysSince : null;

            const row: InsiderBoardRow = {
              ticker: t.ticker,
              buyDollars: +buyDollars.toFixed(0),
              sellDollars: +sellDollars.toFixed(0),
              netDollars: +(buyDollars - sellDollars).toFixed(0),
              buyerCount: buyers.size,
              totalBuys,
              totalSells,
              topBuyer,
              latestFilingDate,
              daysSinceLatest,
              filings,
            };
            return row;
          } catch {
            return null;
          }
        }),
      );
      for (const r of batch) if (r) rows.push(r);
    }

    rows.sort((a, b) => b.buyDollars - a.buyDollars);
    const trimmed = rows.slice(0, limit);

    const response: InsiderBoardResponse = {
      rows: trimmed,
      universeChecked: scanList.length,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    if (trimmed.length > 0) {
      resultCache.set(cacheKey, { data: response, at: Date.now() });
    }

    return json(200, response);
  } catch (err: any) {
    return json(500, { error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' },
    body: JSON.stringify(body),
  };
}
