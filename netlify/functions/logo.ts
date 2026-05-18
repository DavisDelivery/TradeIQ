// GET /api/logo?ticker=AAPL[&kind=icon]
//
// Phase 4j hotfix — server-side proxy for Polygon branding images so
// the Polygon API key never reaches the browser.
//
// Polygon's /v1/reference/branding/{ticker}/images/* URLs return 401
// without ?apiKey=. The naive approach is to embed the keyed URL in
// the JSON we return to the client and let the browser load it
// directly via <img src> — but that puts the key in network traffic
// and the DOM. This proxy does the keyed fetch server-side and
// streams the image bytes back to the client.
//
// kind=logo (default) → wider full-color logo
// kind=icon          → square monogram icon
//
// Cache-first via the ticker-reference cache. On a true cache miss
// for a ticker we have never seen the proxy returns 404 - the
// browser's CompanyInfo component has a ticker-monogram fallback for
// that case. We do NOT trigger a Polygon /v3/reference/tickers fetch
// from inside the image proxy: the detail panel already calls
// /api/ticker-info before requesting the logo, which warms the cache.

import type { Handler } from '@netlify/functions';
import { getTickerInfo } from './shared/ticker-reference';
import { createLogger } from './shared/logger';

const log = createLogger('logo');

const POLYGON_TIMEOUT_MS = 5_000;
const VALID_KINDS = ['logo', 'icon'] as const;
type Kind = (typeof VALID_KINDS)[number];

export const handler: Handler = async (event) => {
  const start = Date.now();
  const ticker = (event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
  const kindRaw = (event.queryStringParameters?.kind ?? 'logo').trim();

  if (!ticker) return text(400, 'ticker required');
  if (!isKind(kindRaw)) return text(400, `invalid kind: ${kindRaw}`);
  const kind: Kind = kindRaw;

  const apiKey = process.env.POLYGON_API_KEY;
  if (!apiKey) {
    log.error('missing_env', { var: 'POLYGON_API_KEY' });
    return text(500, 'POLYGON_API_KEY not set');
  }

  try {
    const info = await getTickerInfo(ticker);
    const rawUrl = kind === 'logo' ? info?.logoUrl : info?.iconUrl;
    if (!rawUrl) {
      log.info('response', {
        status: 404,
        ticker,
        kind,
        reason: 'no branding',
        durationMs: Date.now() - start,
      });
      return text(404, `no ${kind} for ${ticker}`);
    }

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), POLYGON_TIMEOUT_MS);
    let res: Response;
    try {
      // Append the API key SERVER-SIDE so it never reaches the client.
      const url = `${rawUrl}?apiKey=${apiKey}`;
      res = await fetch(url, { signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      log.warn('upstream_failed', { ticker, kind, status: res.status });
      return text(res.status === 404 ? 404 : 502, `upstream ${res.status}`);
    }

    const buf = Buffer.from(await res.arrayBuffer());
    // Forward Polygon's content type; fall back to a sensible default
    // since branding files are typically SVG or PNG.
    const contentType = res.headers.get('content-type') ?? inferContentType(rawUrl);

    log.info('response', {
      status: 200,
      ticker,
      kind,
      bytes: buf.length,
      durationMs: Date.now() - start,
    });
    return {
      statusCode: 200,
      headers: {
        'Content-Type': contentType,
        // Branding doesn't change often; cache aggressively at the edge
        // and in the browser. The /api/logo URL is keyed by (ticker,
        // kind) so it's safe to share across users.
        'Cache-Control': 'public, max-age=86400, immutable',
      },
      body: buf.toString('base64'),
      isBase64Encoded: true,
    };
  } catch (err: any) {
    log.error('failed', { ticker, kind, error: err, durationMs: Date.now() - start });
    return text(500, String(err?.message ?? err));
  }
};

function isKind(s: string): s is Kind {
  return (VALID_KINDS as readonly string[]).includes(s);
}

function inferContentType(url: string): string {
  const u = url.toLowerCase();
  if (u.endsWith('.svg')) return 'image/svg+xml';
  if (u.endsWith('.png')) return 'image/png';
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return 'image/jpeg';
  if (u.endsWith('.gif')) return 'image/gif';
  if (u.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

function text(statusCode: number, body: string) {
  return {
    statusCode,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
    },
    body,
  };
}
