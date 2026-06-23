// GET /api/quotes?tickers=AAPL,MSFT,...
//
// Batched live price + intraday %-change for the board UIs. The boards
// score price into their daily snapshot and then freeze it; the frontend
// calls this on an interval to overlay CURRENT price/% on top of the older
// scored values (see shared/live-quotes.ts for the why).
//
// Always responds 200 with a (possibly empty) quotes map — a live-quote
// outage must never break a board render; the client falls back to the
// scored snapshot value for any missing ticker.

import type { Handler } from '@netlify/functions';
import { getLiveQuotes } from './shared/live-quotes';
import { logger } from './shared/logger';

// Hard cap so a pathological query can't fan out unbounded upstream calls.
// 300 covers the largest board view (50 cards / a few hundred table rows).
const MAX_TICKERS = 300;

export const handler: Handler = async (event) => {
  const log = logger.child({ fn: 'quotes' });
  const raw = event.queryStringParameters?.tickers ?? '';
  const tickers = raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, MAX_TICKERS);

  const headers = {
    'content-type': 'application/json',
    // Short edge cache — quotes move, but a 15s coalesce shields the
    // upstream from a thundering herd of board mounts.
    'cache-control': 'public, max-age=15',
  };

  if (tickers.length === 0) {
    return { statusCode: 200, headers, body: JSON.stringify({ asOf: new Date().toISOString(), quotes: {} }) };
  }

  try {
    const quotes = await getLiveQuotes(tickers);
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ asOf: new Date().toISOString(), quotes, count: Object.keys(quotes).length }),
    };
  } catch (err: any) {
    // Degrade to empty rather than error — the UI keeps the scored price.
    log.error('quotes_failed', { err: String(err?.message ?? err), requested: tickers.length });
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ asOf: new Date().toISOString(), quotes: {}, error: String(err?.message ?? err) }),
    };
  }
};
