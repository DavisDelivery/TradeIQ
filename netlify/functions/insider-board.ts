// GET /api/insider-board?days=90&limit=100&index=sp500|all
// Returns aggregated insider activity across the universe, sorted by
// total $ value bought (desc) by default. Each row carries summary stats
// + the underlying filings so the frontend can render expandable detail.
//
// Caching: per-window TTL 30min, NEVER cache empty results.

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { getInsiderActivity } from './shared/insider-provider';
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

    // Cap at 100 tickers per scan to fit the 26s budget. Quiver is fast (~200ms each)
    // but cold-start + 100 calls at concurrency 8 = ~3-4s, well within budget.
    const scanList = tickers.slice(0, Math.min(tickers.length, 120));

    const rows: InsiderBoardRow[] = [];
    const concurrency = 8;
    const SCAN_BUDGET_MS = 22000;
    const startedAt = Date.now();

    const now = Date.now();

    for (let i = 0; i < scanList.length; i += concurrency) {
      if (Date.now() - startedAt > SCAN_BUDGET_MS) break;
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (t) => {
          try {
            const activity = await getInsiderActivity(t.ticker, windowDays);
            // Only include tickers with actual activity in the window
            if (activity.totalBuys === 0 && activity.totalSells === 0) return null;

            const filings = activity.transactions
              .filter((tx) => {
                const txTs = new Date(tx.transactionDate).getTime();
                return now - txTs <= windowDays * 86400000;
              })
              .map((tx) => {
                const dollars = Math.abs(tx.share) * tx.transactionPrice;
                const txTs = new Date(tx.transactionDate).getTime();
                return {
                  name: tx.name,
                  role: tx.position || 'Insider',
                  shares: tx.share,
                  dollars: +dollars.toFixed(0),
                  filingDate: tx.filingDate,
                  transactionDate: tx.transactionDate,
                  code: tx.transactionCode,
                  daysSince: Math.max(0, Math.round((now - txTs) / 86400000)),
                };
              })
              .sort((a, b) => (a.daysSince - b.daysSince));

            // Find top buyer by aggregate $
            const buyerTotals = new Map<string, { name: string; role: string; dollars: number }>();
            for (const f of filings) {
              if (f.code !== 'P' || f.shares <= 0) continue;
              const cur = buyerTotals.get(f.name) ?? { name: f.name, role: f.role, dollars: 0 };
              cur.dollars += f.dollars;
              buyerTotals.set(f.name, cur);
            }
            const topBuyer = buyerTotals.size > 0
              ? Array.from(buyerTotals.values()).sort((a, b) => b.dollars - a.dollars)[0]
              : null;

            const latestFilingDate = filings.length > 0 ? filings[0].filingDate : null;
            const daysSinceLatest = filings.length > 0 ? filings[0].daysSince : null;

            const row: InsiderBoardRow = {
              ticker: t.ticker,
              buyDollars: +activity.buyDollars.toFixed(0),
              sellDollars: +activity.sellDollars.toFixed(0),
              netDollars: +activity.netDollars.toFixed(0),
              buyerCount: activity.uniqueBuyers,
              totalBuys: activity.totalBuys,
              totalSells: activity.totalSells,
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

    // Default sort: by $ bought (desc)
    rows.sort((a, b) => b.buyDollars - a.buyDollars);
    const trimmed = rows.slice(0, limit);

    const response: InsiderBoardResponse = {
      rows: trimmed,
      universeChecked: scanList.length,
      windowDays,
      generatedAt: new Date().toISOString(),
      cached: false,
    };

    // Don't cache empty (consistency with target-board / prophet / earnings-board)
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
