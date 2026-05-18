// GET /api/ticker-info?ticker=AAPL
//
// Phase 4j W2 — on-demand company-info read endpoint backing the detail-
// panel CompanyInfo block. Returns the full TickerInfo object (name,
// description, industry, key facts, logo URL, homepage).
//
// **Architectural guardrail (critical):** the description is fetched
// ON-DEMAND by the detail panel via this endpoint. It is NOT enriched
// onto snapshot picks - a ~500-char description × ~2,000 russell2k picks
// would push the snapshot document past Firestore's 1 MiB ceiling. The
// scan path keeps writing only `name`/`sector` onto picks (4h shape);
// the description and other long fields live in the tickerReference
// cache and are read one-at-a-time by this endpoint when a user opens
// a specific detail panel.
//
// Cache-first via shared/ticker-reference.ts (lazy 4h→4j schema
// migration). One Polygon call per uncached ticker, then effectively
// forever-cached because company reference data does not change.

import type { Handler } from '@netlify/functions';
import { getTickerInfo } from './shared/ticker-reference';
import { createLogger } from './shared/logger';

const log = createLogger('ticker-info');

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  if (!ticker) {
    return json(400, { ok: false, error: 'ticker required' });
  }

  try {
    const info = await getTickerInfo(ticker);
    if (!info) {
      log.info('response', { status: 404, ticker, durationMs: Date.now() - start });
      return json(404, { ok: false, ticker, error: 'ticker not found' });
    }
    // SECURITY: rewrite raw Polygon branding URLs (which would require
    // ?apiKey= to load) into proxy URLs that hit /api/logo - which
    // appends the key server-side. The raw URL and the Polygon API
    // key must NEVER leave this function in the response body.
    const safe = {
      ...info,
      logoUrl: info.logoUrl ? `/api/logo?ticker=${encodeURIComponent(ticker)}` : null,
      iconUrl: info.iconUrl ? `/api/logo?ticker=${encodeURIComponent(ticker)}&kind=icon` : null,
    };
    log.info('response', { status: 200, ticker, durationMs: Date.now() - start });
    return json(200, { ok: true, ...safe });
  } catch (err: any) {
    log.error('failed', { ticker, error: err, durationMs: Date.now() - start });
    return json(500, { ok: false, ticker, error: String(err?.message ?? err) });
  }
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'application/json',
      // Browser-side caching: the underlying Firestore doc is effectively
      // immutable (refetched only on Polygon-call → cache write), so a
      // short browser cache avoids re-hitting the function on repeated
      // detail-panel opens within the same session.
      'Cache-Control': 'public, max-age=300',
    },
    body: JSON.stringify(body),
  };
}
