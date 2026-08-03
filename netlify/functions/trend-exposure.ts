// GET /api/trend-exposure?q=<phrase>&forms=10-K&days=730&wiki=1
//
// ATTRIBUTION endpoint. Answers "which public filers write this phrase into
// their filings?" and, optionally, "what has attention to it looked like?".
//
// It deliberately returns NO score, NO ranking by expected return, and NO
// buy/sell language. The consumer-attention study that motivated this work
// failed its placebo test (verdicts.ts `trend` row); the attribution layer
// survived because it answers a factual question instead of a predictive
// one. Keep it that way.
//
// ROUTING: this needs an explicit `/api/trend-exposure` redirect in
// netlify.toml. There is no `/api/*` wildcard — all 60 endpoints are routed
// one by one — and the SPA catch-all (`/* -> /index.html`, status 200) will
// happily answer an unrouted /api call with HTML at status 200. The client
// then throws a JSON parse error that points nowhere near the real cause.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import {
  fetchExposure,
  fetchPageviews,
  isoDaysAgo,
  resolveArticle,
} from './shared/trend-exposure';

const log = logger.child({ fn: 'trend-exposure' });

const ALLOWED_FORMS = new Set(['10-K', '10-Q', '8-K', 'S-1', 'DEF 14A', '20-F']);
const MAX_PHRASE = 120;

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: {
      'content-type': 'application/json',
      // EDGAR data changes on filing cadence, not intraday. A short public
      // cache keeps repeated lookups off SEC's 10 req/sec budget.
      'cache-control': 'public, max-age=1800',
    },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  const start = Date.now();
  const qp = event.queryStringParameters ?? {};
  const phrase = (qp.q ?? '').trim();

  if (!phrase) return json(400, { ok: false, error: 'q (phrase) is required' });
  if (phrase.length > MAX_PHRASE) {
    return json(400, { ok: false, error: `q must be <= ${MAX_PHRASE} chars` });
  }
  // The phrase is interpolated into an EDGAR query string, so reject the
  // quote characters that would let a caller break out of the exact-phrase
  // wrapper and run an arbitrary boolean query against SEC on our UA.
  if (/["\\]/.test(phrase)) {
    return json(400, { ok: false, error: 'q must not contain quote or backslash characters' });
  }

  const forms = (qp.forms ?? '10-K')
    .split(',')
    .map((f) => f.trim())
    .filter((f) => ALLOWED_FORMS.has(f));
  if (!forms.length) {
    return json(400, { ok: false, error: `forms must be one of: ${[...ALLOWED_FORMS].join(', ')}` });
  }

  const days = Math.min(9000, Math.max(30, parseInt(qp.days ?? '730', 10) || 730));
  const wantWiki = qp.wiki !== '0';

  try {
    const exposure = await fetchExposure(phrase, {
      forms,
      startDate: isoDaysAgo(days),
      limit: Math.min(25, Math.max(1, parseInt(qp.limit ?? '12', 10) || 12)),
    });

    // Pageviews are context, not evidence. A failure here must never fail
    // the attribution answer, which is the part that is actually reliable.
    let pageviews = null;
    let pageviewsError: string | null = null;
    if (wantWiki) {
      try {
        const article = await resolveArticle(phrase);
        pageviews = article ? await fetchPageviews(article) : null;
      } catch (err: any) {
        pageviewsError = String(err?.message ?? err);
        log.warn('pageviews_failed', { phrase, err: pageviewsError });
      }
    }

    log.info('response', {
      status: 200,
      phrase,
      totalFilings: exposure.totalFilings,
      ambiguous: exposure.ambiguous,
      durationMs: Date.now() - start,
    });

    return json(200, {
      ok: true,
      ...exposure,
      pageviews,
      ...(pageviewsError ? { pageviewsError } : {}),
      // Carried in the payload so the disclaimer cannot be dropped by a
      // future UI refactor without deleting it from the API contract too.
      disclaimer:
        'Attribution only. Filing mentions describe disclosure, not demand, ' +
        'materiality, or expected return.',
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('failed', { phrase, err: msg, durationMs: Date.now() - start });
    // Map an upstream throttle to 429 rather than 502. The frontend's
    // fetchWithRetry retries 502/503/504 — retrying a rate-limit error
    // would turn one SEC throttle into three more requests against the
    // same shared budget and make the block worse.
    const throttled = /\b429\b|throttl/i.test(msg);
    return json(throttled ? 429 : 502, { ok: false, error: msg });
  }
};
