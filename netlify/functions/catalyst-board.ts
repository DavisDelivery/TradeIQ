// GET /api/catalyst-board
//   ?index=sp500|ndx|dow|russell2k|all
//   &limit=30
//   &filter=cluster|patents|political|contracts|setup|all
//   &minConviction=low|medium|high
//
// Surfaces tickers where insider buying, patent momentum, congressional
// activity, government contract flow, and technical setups align. Single
// most important view in the app for finding "why now".

import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { getInsiderActivity } from './shared/insider-provider';
import { getPatentActivity } from './shared/patent-provider';
import { getPoliticalActivity } from './shared/political-provider';
import { getGovContractActivity } from './shared/govcontracts-provider';
import { detectSetups } from './shared/technical-setups';
import { scoreCatalysts, type CatalystScore } from './shared/catalyst-scorer';
import { getDailyBars } from './shared/data-provider';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 30), 100);
  const filter = (qs.filter as 'cluster' | 'patents' | 'political' | 'contracts' | 'setup' | 'all') ?? 'all';
  const minConviction = (qs.minConviction as 'low' | 'medium' | 'high') ?? 'medium';

  const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
  if (tickers.length === 0) return json(400, { ok: false, error: `unknown index: ${indexFilter}` });

  // 5 API calls per ticker for the catalyst stack — cap aggressively
  const scanList = tickers.slice(0, Math.min(tickers.length, 100));

  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 220 * 86400000).toISOString().slice(0, 10);

    const results: Array<CatalystScore & {
      name: string;
      sector: string;
      price: number;
      priceChangePct: number;
      setupLabels: string[];
    }> = [];

    const concurrency = 5;
    for (let i = 0; i < scanList.length; i += concurrency) {
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(
        chunk.map(async (t) => {
          try {
            const [insider, patents, political, contracts, bars] = await Promise.all([
              getInsiderActivity(t.ticker, 90).catch(() => null),
              getPatentActivity(t.ticker, t.name, 180).catch(() => null),
              getPoliticalActivity(t.ticker, 180).catch(() => null),
              getGovContractActivity(t.ticker, 180).catch(() => null),
              getDailyBars(t.ticker, from, to).catch(() => []),
            ]);
            if (!insider || !patents || !political || !contracts || bars.length < 60) return null;

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
            };
          } catch {
            return null;
          }
        }),
      );
      for (const r of batch) if (r) results.push(r);
    }

    results.sort((a, b) => b.composite - a.composite);

    return json(200, {
      ok: true,
      picks: results.slice(0, limit),
      universeChecked: scanList.length,
      matched: results.length,
      filter,
      minConviction,
      generatedAt: new Date().toISOString(),
    });
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
