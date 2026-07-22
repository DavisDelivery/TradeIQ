// GET /api/symbol-search?q=app
//
// Typeahead backing the global header ticker/company search. Proxies
// Polygon's reference `search` (matches ticker AND company name) and returns
// a compact [{ticker, name}] list the header dropdown renders. On select the
// client opens the ticker's full StockDetailPanel (generic board) — chart, AI
// brief, fundamentals, company info — so this endpoint is intentionally thin:
// it resolves a query to real, tradeable symbols and nothing more.

import type { Handler } from '@netlify/functions';
import { searchTickers } from './shared/vector-data';
import { createLogger } from './shared/logger';

const log = createLogger('symbol-search');

export const handler: Handler = async (event) => {
  const start = Date.now();
  const q = (event.queryStringParameters?.q ?? '').trim();
  if (q.length < 1) {
    return json(200, { ok: true, q, results: [] });
  }

  try {
    const results = await searchTickers(q, 12);
    log.info('response', { status: 200, q, count: results.length, durationMs: Date.now() - start });
    return json(200, { ok: true, q, results });
  } catch (err: any) {
    log.error('failed', { q, error: err, durationMs: Date.now() - start });
    return json(502, { ok: false, q, results: [], error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Reference data is effectively static; a short browser cache keeps
      // keystroke-debounced repeats off the function.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}
