// GET /api/williams-board?index=sp500&side=both&limit=30
import type { Handler } from '@netlify/functions';
import { UNIVERSE, inIndex, type IndexTag } from './shared/universe';
import { runWilliams } from './styles/williams';
import { getDailyBars } from './shared/data-provider';
import { createLogger } from './shared/logger';

const log = createLogger('williams-board');

export const handler: Handler = async (event) => {
  const start = Date.now();
  const qs = event.queryStringParameters ?? {};
  const indexFilter = (qs.index as IndexTag | 'all') ?? 'all';
  const limit = Math.min(Number(qs.limit ?? 25), 100);
  const side = (qs.side as 'long' | 'short' | 'both') ?? 'both';
  log.info('request', { indexFilter, limit, side });

  const tickers = indexFilter === 'all' ? UNIVERSE : inIndex(indexFilter);
  if (tickers.length === 0) {
    log.warn('unknown_index', { indexFilter });
    return json(400, { ok: false, error: `Unknown index: ${indexFilter}` });
  }

  // Cap scan to keep under Netlify timeout
  const scanList = tickers.slice(0, Math.min(tickers.length, 200));

  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 120 * 86400000).toISOString().slice(0, 10);

    const results: any[] = [];
    const concurrency = 10;

    for (let i = 0; i < scanList.length; i += concurrency) {
      const chunk = scanList.slice(i, i + concurrency);
      const batch = await Promise.all(chunk.map(async (t) => {
        try {
          const bars = await getDailyBars(t.ticker, from, to);
          if (!bars || bars.length < 30) return null;
          const s = runWilliams({ ticker: t.ticker, bars });
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

    const filtered = side === 'both' ? results : results.filter((r) => r.side === side);
    filtered.sort((a, b) => Math.abs(b.score) - Math.abs(a.score));

    log.info('response', {
      status: 200, indexFilter, side, scored: results.length,
      universeSize: tickers.length, durationMs: Date.now() - start,
    });
    return json(200, {
      ok: true,
      index: indexFilter,
      side,
      generatedAt: new Date().toISOString(),
      universeSize: tickers.length,
      scanned: scanList.length,
      scored: results.length,
      count: Math.min(limit, filtered.length),
      candidates: filtered.slice(0, limit),
    });
  } catch (err: any) {
    log.error('failed', { indexFilter, side, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return { statusCode, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=900' }, body: JSON.stringify(body) };
}
