// GET /api/catalyst-board
//   ?index=sp500|ndx|dow|russell2k|all
//   &limit=30
//   &filter=cluster|patents|political|contracts|setup|all
//   &minConviction=low|medium|high
//
// Surfaces tickers where insider buying, congressional activity, government
// contract flow, and technical setups align. Single most important view in
// the app for finding "why now".
//
// v0.7.23 improvements:
//  - 5min result cache keyed by (index, filter, minConviction, limit) —
//    catalyst data shifts daily, not minute-to-minute, so a short cache is
//    safe and saves the 100-ticker × 5-provider scan on repeat visits.
//  - Concurrency bumped 5 → 8 (other boards run at 8-10 without issues).
//  - 22s scan budget guard prevents timeout on the 26s function ceiling.
//  - Patent fetch skipped entirely (dataset is subscription-gated to 403
//    on this plan, scoring weight is zero per catalyst-scorer rebalance).
//    Saves ~100 wasted Quiver calls per cold scan.
//  - Empty-cache guard (no cache write when 0 picks match) consistent with
//    v0.7.18/v0.7.19/v0.7.21 fix pattern.

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { getInsiderActivity } from './shared/insider-provider';
import { getPoliticalActivity } from './shared/political-provider';
import { getGovContractActivity } from './shared/govcontracts-provider';
import { detectSetups } from './shared/technical-setups';
import { scoreCatalysts, type CatalystScore } from './shared/catalyst-scorer';
import { getDailyBars } from './shared/data-provider';
import type { PatentActivity } from './shared/patent-provider';

type CatalystPick = CatalystScore & {
  name: string;
  sector: string;
  price: number;
  priceChangePct: number;
  setupLabels: string[];
};

type CatalystResponse = {
  ok: true;
  picks: CatalystPick[];
  universeChecked: number;
  matched: number;
  filter: string;
  minConviction: string;
  cached: boolean;
  generatedAt: string;
};

const resultCache = new Map<string, { data: CatalystResponse; at: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// Stub patent activity used in place of the dead Quiver path. Score 50 +
// confidence 0.1 means it contributes ~0 to composite (matching what the
// old getPatentActivity returned anyway when 403'd) but skips the round
// trip entirely. Re-enable by importing getPatentActivity and calling it
// in the Promise.all block when the dataset path is restored.
function patentStub(ticker: string): PatentActivity {
  return {
    ticker, companyName: '', lookbackDays: 180,
    totalGrants: 0, grantsLast30d: 0, grantsLast90d: 0,
    priorPeriodGrants: 0, velocityChangePct: 0, highValueGrants: 0,
    topCpcGroups: [], recentGrants: [],
    fetchedAt: new Date().toISOString(),
  };
}

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const filter = (qs.filter as 'cluster' | 'patents' | 'political' | 'contracts' | 'setup' | 'all') ?? 'all';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'medium';

  const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
  if (tickers.length === 0) return json(400, { ok: false, error: `unknown index: ${indexFilter}` });

  const cacheKey = `${indexFilter}|${filter}|${minConviction}|${limit}`;
  const cached = resultCache.get(cacheKey);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) {
    return json(200, { ...cached.data, cached: true });
  }

  // 4 live providers per ticker (insider/political/contracts/bars) + setups
  // computed locally from bars. Keep the cap at 100 to stay under Finnhub +
  // Quiver combined rate limits.
  const scanList = tickers.slice(0, Math.min(tickers.length, 100));

  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 220 * 86400000).toISOString().slice(0, 10);

    const results: CatalystPick[] = [];
    const concurrency = 8;
    const SCAN_BUDGET_MS = 22000;
    const startedAt = Date.now();

    for (let i = 0; i < scanList.length; i += concurrency) {
      if (Date.now() - startedAt > SCAN_BUDGET_MS) {
        console.warn(`[catalyst-board] scan budget hit at ticker ${i}/${scanList.length}`);
        break;
      }
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (t) => {
          try {
            // Patent fetch SKIPPED — dataset 403s on this plan, weight is 0
            // in catalyst-scorer. Stub returns immediately with empty activity.
            const [insider, political, contracts, bars] = await Promise.all([
              getInsiderActivity(t.ticker, 90).catch(() => null),
              getPoliticalActivity(t.ticker, 180).catch(() => null),
              getGovContractActivity(t.ticker, 180).catch(() => null),
              getDailyBars(t.ticker, from, to).catch(() => []),
            ]);
            const patents = patentStub(t.ticker);
            if (!insider || !political || !contracts || bars.length < 60) return null;

            const setups = detectSetups(bars);
            const cat = scoreCatalysts({
              ticker: t.ticker,
              insider,
              patents,
              political,
              contracts,
              setups,
            });

            // Apply filter
            if (filter === 'cluster' && !cat.hasClusterBuy) return null;
            if (filter === 'patents' && !cat.hasPatentBurst) return null;
            if (filter === 'political' && !cat.hasPoliticalTailwind) return null;
            if (filter === 'contracts' && !cat.hasContractWin) return null;
            if (filter === 'setup' && !cat.hasStackedSetup) return null;

            const convictionRank = { low: 0, medium: 1, high: 2 };
            if (convictionRank[cat.conviction] < convictionRank[minConviction]) return null;

            const latest = bars.at(-1)!;
            const prev = bars.at(-2);
            const priceChangePct = prev ? ((latest.c - prev.c) / prev.c) * 100 : 0;

            return {
              ...cat,
              name: t.name,
              sector: t.sector,
              price: +latest.c.toFixed(2),
              priceChangePct: +priceChangePct.toFixed(2),
              setupLabels: setups.map((s) => s.label),
            } satisfies CatalystPick;
          } catch {
            return null;
          }
        }),
      );
      for (const r of batch) if (r) results.push(r);
    }

    results.sort((a, b) => b.composite - a.composite);

    const response: CatalystResponse = {
      ok: true,
      picks: results.slice(0, limit),
      universeChecked: scanList.length,
      matched: results.length,
      filter,
      minConviction,
      cached: false,
      generatedAt: new Date().toISOString(),
    };

    // Empty-cache guard — don't pin a 0-pick result for 5 minutes if a
    // transient rate-limit or cold-start glitch produced an empty scan.
    if (results.length > 0) {
      resultCache.set(cacheKey, { data: response, at: Date.now() });
    }

    return json(200, response);
  } catch (e: any) {
    return json(500, { ok: false, error: e?.message ?? 'catalyst-board failed' });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=300' },
    body: JSON.stringify(body),
  };
}
