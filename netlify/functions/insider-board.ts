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
import { lookupInsiderRole } from './shared/edgar-roles';
import type { InsiderBoardResponse, InsiderBoardRow } from './shared/types';
import { createLogger } from './shared/logger';

const log = createLogger('insider-board');

const ALLOWED_WINDOWS = [30, 60, 90, 180] as const;
const resultCache = new Map<string, { data: InsiderBoardResponse; at: number }>();
const CACHE_TTL_MS = 30 * 60 * 1000;

// Test-only export: exposes the module-scoped cache so the cache-poisoning
// regression suite can assert empty results never poison the cache.
export const __testInternals = {
  resultCache,
  reset: () => resultCache.clear(),
};

export const handler: Handler = async (event) => {
  const start = Date.now();
  try {
    const qs = event.queryStringParameters ?? {};
    const rawDays = Number(qs.days);
    const windowDays: number = (ALLOWED_WINDOWS as readonly number[]).includes(rawDays)
      ? rawDays
      : 90;
    const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
    const limit = Math.min(Number(qs.limit ?? 100), 200);
    log.info('request', { windowDays, indexFilter, limit });

    const cacheKey = `${windowDays}|${indexFilter}|${limit}`;
    const cached = resultCache.get(cacheKey);
    if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
      log.info('response', { status: 200, cached: true, windowDays, indexFilter, durationMs: Date.now() - start });
      return json(200, { ...cached.data, cached: true });
    }

    const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
    if (tickers.length === 0) return json(400, { error: `unknown index: ${indexFilter}` });

    // Cap at 80 tickers per scan. Finnhub's free-tier limit is 60 req/min and
    // earnings-board may also be hitting Finnhub from the same user session;
    // 80 here + 25 from earnings-board calendar+history leaves margin under
    // the 60/min ceiling once concurrency staggers requests.
    const scanList = tickers.slice(0, Math.min(tickers.length, 80));
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
            let buyDollars = 0;     // code P only — open-market purchases (signal)
            let awardDollars = 0;   // code A — RSU vests / grants (mechanical, no signal)
            let sellDollars = 0;    // code S/D — sales / dispositions
            let totalBuys = 0;
            let totalAwards = 0;
            let totalSells = 0;
            const buyers = new Set<string>();
            const buyerTotals = new Map<string, { name: string; role: string; dollars: number }>();
            for (const f of filings) {
              // Only code 'P' (open-market purchase) is a signal-bearing buy.
              // Code 'A' (award/grant) is RSU vesting / stock comp — scheduled
              // by the comp committee, not chosen by the insider, so it's
              // tracked separately and excluded from buyDollars / topBuyer /
              // buyerCount. The frontend shows an 'AWARD' chip distinct from
              // 'BUY' so the user can see the distinction at a glance.
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

            // Include ticker if it has any of: open-market buys, awards, or sells.
            // Pure-derivative or unrecognized-code rows are still excluded above.
            if (totalBuys === 0 && totalAwards === 0 && totalSells === 0) return null;

            const topBuyer = buyerTotals.size > 0
              ? Array.from(buyerTotals.values()).sort((a, b) => b.dollars - a.dollars)[0]
              : null;

            const latestFilingDate = filings.length > 0 ? filings[0].filingDate : null;
            const daysSinceLatest = filings.length > 0 ? filings[0].daysSince : null;

            const row: InsiderBoardRow = {
              ticker: t.ticker,
              buyDollars: +buyDollars.toFixed(0),
              awardDollars: +awardDollars.toFixed(0),
              sellDollars: +sellDollars.toFixed(0),
              netDollars: +(buyDollars - sellDollars).toFixed(0),
              buyerCount: buyers.size,
              totalBuys,
              totalAwards,
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

    // Sort: real open-market buys first, then by award size (so tickers with
    // any P-buy always rank above pure-A tickers regardless of award size).
    rows.sort((a, b) => {
      if (a.buyDollars !== b.buyDollars) return b.buyDollars - a.buyDollars;
      return b.awardDollars - a.awardDollars;
    });
    const trimmed = rows.slice(0, limit);

    // EDGAR enrichment — fill in topBuyer.role for visible rows only.
    // Bounded to ~40 lookups per scan (limit caps at 200 but most queries
    // request the default 100 rows and most rows don't have a topBuyer).
    // Cached aggressively per (ticker, name) pair so repeat scans cost
    // nothing. Falls through to the existing '—' placeholder on timeout
    // or no-match. Never blocks the response — bounded by the per-lookup
    // 1500ms timeout × concurrency 5.
    const ROLE_ENRICHMENT_BUDGET_MS = 6000;
    const roleStartedAt = Date.now();
    const enrichTargets = trimmed.filter((r) => r.topBuyer !== null);
    for (let i = 0; i < enrichTargets.length; i += 5) {
      if (Date.now() - roleStartedAt > ROLE_ENRICHMENT_BUDGET_MS) break;
      const chunk = enrichTargets.slice(i, i + 5);
      const roles = await Promise.all(
        chunk.map((r) => lookupInsiderRole(r.topBuyer!.name, r.ticker).catch(() => null))
      );
      for (let j = 0; j < chunk.length; j++) {
        const role = roles[j];
        if (role && chunk[j].topBuyer) {
          chunk[j].topBuyer = { ...chunk[j].topBuyer!, role };
        }
      }
    }

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

    log.info('response', {
      status: 200, cached: false, rows: trimmed.length,
      universeChecked: scanList.length, durationMs: Date.now() - start,
    });
    return json(200, response);
  } catch (err: any) {
    log.error('failed', { error: err, durationMs: Date.now() - start });
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
