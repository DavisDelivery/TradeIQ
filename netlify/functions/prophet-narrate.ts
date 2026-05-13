// POST /api/prophet-narrate
//
// On-demand narration for a single Prophet pick. The frontend calls this
// when the user expands a pick whose snapshot did not include a narrative
// (the W1 placeholder shows a "Generate AI thesis" button that triggers
// this endpoint).
//
// Body:
//   {
//     ticker: string,
//     composite: number,
//     layers: { [name]: { score, pass, details } },
//     conviction?: string,
//     flags?: string[],
//     entry?, stop?, targets?, invalidation?, price?, priceChangePct?,
//     name?, sector?, layersPassed?
//   }
//
// Response:
//   200 { ok: true, ticker, narrative, cached }    cached=true if served from
//                                                  the in-memory narrative cache
//   400 { ok: false, error: 'missing_fields' }
//   429 { ok: false, error: 'rate_limit' }         per-IP defense in depth
//   500 { ok: false, error }                       upstream failure
//
// Spend awareness: Anthropic budget cap was DROPPED 2026-05-12. This
// endpoint does NOT refuse on cost grounds. The existing infra-level
// BudgetExhaustedError / CircuitOpenError in anthropic-client may still
// short-circuit a call; in that case generateNarrative returns text:null
// and we surface 500 with a generic message so the UI re-shows the
// "Generate AI thesis" placeholder.
//
// Per-IP rate limit (30/hour) is purely defensive: it bounds a misbehaving
// client (or accidental loop) without ever blocking normal usage.

import type { Handler } from '@netlify/functions';
import { logger } from './shared/logger';
import { generateNarrative, type NarrativeInput } from './shared/narrative-generator';

const RATE_LIMIT_PER_HOUR = 30;
const RATE_WINDOW_MS = 60 * 60 * 1000;

interface RateState {
  count: number;
  windowStart: number;
}
const rateLimits = new Map<string, RateState>();

function clientKey(event: Parameters<Handler>[0]): string {
  // Netlify forwards client IP in x-nf-client-connection-ip and x-forwarded-for.
  const h = event.headers ?? {};
  return (
    (h['x-nf-client-connection-ip'] as string) ||
    ((h['x-forwarded-for'] as string)?.split(',')[0].trim() ?? '') ||
    'unknown'
  );
}

function checkRateLimit(key: string): boolean {
  const now = Date.now();
  const state = rateLimits.get(key);
  if (!state || now - state.windowStart > RATE_WINDOW_MS) {
    rateLimits.set(key, { count: 1, windowStart: now });
    return true;
  }
  if (state.count >= RATE_LIMIT_PER_HOUR) return false;
  state.count++;
  return true;
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return json(405, { ok: false, error: 'method_not_allowed' });
  }

  const log = logger.child({ fn: 'prophet-narrate' });

  // Rate-limit first — cheap check before any parse work.
  const ip = clientKey(event);
  if (!checkRateLimit(ip)) {
    log.warn('rate_limit_exceeded', { ip });
    return json(429, { ok: false, error: 'rate_limit' });
  }

  let body: NarrativeInput;
  try {
    body = JSON.parse(event.body ?? '{}') as NarrativeInput;
  } catch {
    return json(400, { ok: false, error: 'invalid_json' });
  }

  if (!body || typeof body.ticker !== 'string' || typeof body.composite !== 'number') {
    return json(400, { ok: false, error: 'missing_fields' });
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    log.error('anthropic_key_missing');
    return json(500, { ok: false, error: 'anthropic_not_configured' });
  }

  const t0 = Date.now();
  const { text, cached } = await generateNarrative(body);
  const ms = Date.now() - t0;

  if (!text) {
    log.warn('narrate_returned_null', { ticker: body.ticker, ms });
    return json(500, { ok: false, error: 'narration_unavailable' });
  }

  log.info('narrate_ok', { ticker: body.ticker, cached, ms, len: text.length });

  return json(200, { ok: true, ticker: body.ticker, narrative: text, cached });
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify(body),
  };
}

// Test hooks
export const __testInternals = {
  resetRateLimits: () => rateLimits.clear(),
  setRateLimit: (key: string, count: number, windowStart: number) =>
    rateLimits.set(key, { count, windowStart }),
  getRateLimit: (key: string) => rateLimits.get(key),
  RATE_LIMIT_PER_HOUR,
  RATE_WINDOW_MS,
};
