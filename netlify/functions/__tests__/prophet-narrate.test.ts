// Unit tests for the prophet-narrate endpoint (4c-1 W2).
//
// We mock the shared narrative-generator so tests don't hit Anthropic.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { HandlerEvent } from '@netlify/functions';

vi.mock('../shared/narrative-generator', () => ({
  generateNarrative: vi.fn(),
}));

import { handler, __testInternals } from '../prophet-narrate';
import { generateNarrative } from '../shared/narrative-generator';

const ORIGINAL_KEY = process.env.ANTHROPIC_API_KEY;

beforeEach(() => {
  vi.resetAllMocks();
  __testInternals.resetRateLimits();
  process.env.ANTHROPIC_API_KEY = 'test-key';
});

function makeEvent(body: any, headers: Record<string, string> = {}): HandlerEvent {
  return {
    httpMethod: 'POST',
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...headers },
    queryStringParameters: {},
    path: '/api/prophet-narrate',
    isBase64Encoded: false,
    multiValueHeaders: {},
    multiValueQueryStringParameters: {},
    rawUrl: '',
    rawQuery: '',
  } as any;
}

const validPick = {
  ticker: 'AAPL',
  composite: 75,
  layers: { momentum: { score: 80, pass: true, details: {} } },
  conviction: 'HIGH',
  flags: [],
  entry: 180,
  stop: 170,
  targets: [190, 200],
  invalidation: 165,
};

describe('method gating', () => {
  it('returns 405 for non-POST', async () => {
    const event = { ...makeEvent({}), httpMethod: 'GET' } as any;
    const r = await (handler as any)(event, {} as any, () => {});
    expect(r.statusCode).toBe(405);
  });
});

describe('input validation', () => {
  it('returns 400 on missing ticker', async () => {
    const r = await (handler as any)(makeEvent({ composite: 50 }), {} as any, () => {});
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('missing_fields');
  });

  it('returns 400 on missing composite', async () => {
    const r = await (handler as any)(makeEvent({ ticker: 'AAPL' }), {} as any, () => {});
    expect(r.statusCode).toBe(400);
  });

  it('returns 400 on invalid JSON', async () => {
    const r = await (handler as any)(makeEvent('not json{'), {} as any, () => {});
    expect(r.statusCode).toBe(400);
    expect(JSON.parse(r.body).error).toBe('invalid_json');
  });
});

describe('happy path', () => {
  it('returns 200 with narrative on successful generation', async () => {
    (generateNarrative as any).mockResolvedValue({
      text: 'Strong setup with multi-layer confluence...',
      cached: false,
    });

    const r = await (handler as any)(makeEvent(validPick), {} as any, () => {});
    expect(r.statusCode).toBe(200);
    const body = JSON.parse(r.body);
    expect(body.ok).toBe(true);
    expect(body.ticker).toBe('AAPL');
    expect(body.narrative).toContain('Strong setup');
    expect(body.cached).toBe(false);
  });

  it('passes through cached=true when narrative came from cache', async () => {
    (generateNarrative as any).mockResolvedValue({
      text: 'Cached thesis...',
      cached: true,
    });

    const r = await (handler as any)(makeEvent(validPick), {} as any, () => {});
    expect(JSON.parse(r.body).cached).toBe(true);
  });
});

describe('upstream failure', () => {
  it('returns 500 when generator returns null text', async () => {
    (generateNarrative as any).mockResolvedValue({ text: null, cached: false });

    const r = await (handler as any)(makeEvent(validPick), {} as any, () => {});
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).error).toBe('narration_unavailable');
    expect(JSON.parse(r.body).diagnostic).toBe('unknown');
  });

  it('surfaces the generator errorCode as diagnostic in the response body', async () => {
    (generateNarrative as any).mockResolvedValue({
      text: null,
      cached: false,
      errorCode: 'anthropic_http_401',
      errorDetail: 'invalid x-api-key',
    });

    const r = await (handler as any)(makeEvent(validPick), {} as any, () => {});
    expect(r.statusCode).toBe(500);
    const body = JSON.parse(r.body);
    expect(body.error).toBe('narration_unavailable');
    expect(body.diagnostic).toBe('anthropic_http_401');
    // errorDetail must NOT be echoed to the wire (may contain upstream body)
    expect(body.errorDetail).toBeUndefined();
  });

  it('returns 500 when ANTHROPIC_API_KEY is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY;
    const r = await (handler as any)(makeEvent(validPick), {} as any, () => {});
    expect(r.statusCode).toBe(500);
    expect(JSON.parse(r.body).error).toBe('anthropic_not_configured');
  });
});

describe('rate limit (per-IP, defense in depth)', () => {
  it('returns 429 after the per-hour threshold from a single IP', async () => {
    (generateNarrative as any).mockResolvedValue({ text: 'ok', cached: false });

    // Pre-load the bucket to the limit
    __testInternals.setRateLimit('1.2.3.4', __testInternals.RATE_LIMIT_PER_HOUR, Date.now());

    const r = await (handler as any)(
      makeEvent(validPick, { 'x-nf-client-connection-ip': '1.2.3.4' }),
      {} as any,
      () => {},
    );
    expect(r.statusCode).toBe(429);
    expect(JSON.parse(r.body).error).toBe('rate_limit');
  });

  it('does not rate-limit different IPs against each other', async () => {
    (generateNarrative as any).mockResolvedValue({ text: 'ok', cached: false });
    __testInternals.setRateLimit('1.2.3.4', __testInternals.RATE_LIMIT_PER_HOUR, Date.now());

    const r = await (handler as any)(
      makeEvent(validPick, { 'x-nf-client-connection-ip': '5.6.7.8' }),
      {} as any,
      () => {},
    );
    expect(r.statusCode).toBe(200);
  });

  it('resets after the window expires', async () => {
    (generateNarrative as any).mockResolvedValue({ text: 'ok', cached: false });

    __testInternals.setRateLimit(
      '1.2.3.4',
      __testInternals.RATE_LIMIT_PER_HOUR,
      Date.now() - __testInternals.RATE_WINDOW_MS - 1000,
    );

    const r = await (handler as any)(
      makeEvent(validPick, { 'x-nf-client-connection-ip': '1.2.3.4' }),
      {} as any,
      () => {},
    );
    expect(r.statusCode).toBe(200);
  });
});

// Cleanup
if (ORIGINAL_KEY) process.env.ANTHROPIC_API_KEY = ORIGINAL_KEY;
else delete process.env.ANTHROPIC_API_KEY;
