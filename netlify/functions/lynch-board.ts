// GET /api/lynch-board?index=sp500&limit=30
import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { runLynch } from './styles/lynch';
import { getFundamentals, getEarningsHistory, getPreviousClose } from './shared/data-provider';

export const handler: Handler = async (event) => {
  const qs = event.queryStringParameters ?? {};
  const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 25), 100);
  const minConfidence = Number(qs.minConfidence ?? 0.5);

  const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
  if (tickers.length === 0) return json(400, { ok: false, error: `Unknown index: ${indexFilter}` });

  // Lynch needs more data per ticker — tighter cap
  const scanList = tickers.slice(0, Math.min(tickers.length, 150));

  try {
    const results: any[] = [];
    const concurrency = 8;

    for (let i = 0; i < scanList.length; i += concurrency) {
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map(async (t) => {
        try {
          const [fund, earnings, snap] = await Promise.all([
            getFundamentals(t.ticker).catch(() => null),
            getEarningsHistory(t.ticker, 4).catch(() => []),
            getPreviousClose(t.ticker).catch(() => null),
          ]);
          const s = runLynch({
            ticker: t.ticker,
            peRatio: fund?.ttmEps && snap ? snap.c / fund.ttmEps : undefined,
            epsGrowthYoY: fund?.epsGrowthYoY,
            revenueGrowthYoY: fund?.revenueGrowthYoY,
            debtToEquity: fund?.debtToEquity,
            operatingMargin: fund?.operatingMargin,
            earningsHistory: earnings,
            marketCapUsd: undefined,
            recentReturnPct: undefined,
            sector: t.sector,
          });
          if (s.confidence < minConfidence) return null;
          return {
            ticker: t.ticker,
            name: t.name,
            sector: t.sector,
            score: s.score,
            confidence: s.confidence,
            rationale: s.rationale,
            signals: s.signals,
            side: s.score >= 0 ? 'long' : 'short',
          };
        } catch { return null; }
      }));
      for (const r of batch) if (r) results.push(r);
    }

    results.sort((a, b) => b.score - a.score);

    return json(200, {
      ok: true,
      index: indexFilter,
      generatedAt: new Date().toISOString(),
      universeSize: tickers.length,
      scanned: scanList.length,
      scored: results.length,
      count: Math.min(limit, results.length),
      candidates: results.slice(0, limit),
    });
  } catch (err: any) {
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=3600' }, body: JSON.stringify(body) };
}
