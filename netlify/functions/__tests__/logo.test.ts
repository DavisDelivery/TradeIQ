// Phase 4j hotfix — /api/logo image proxy contract tests.
//
// SECURITY: the entire point of this proxy is that the Polygon API key
// never reaches the browser. These tests verify:
//   - the key is appended only to the SERVER-SIDE Polygon fetch URL,
//     never to the client response
//   - the response body is the binary image (base64 + isBase64Encoded)
//   - 404 when the ticker has no branding (CompanyInfo falls back to
//     the monogram, never crashes)
//   - 502 when Polygon's upstream fetch fails for other reasons

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getTickerInfoMock = vi.fn();

vi.mock('../shared/ticker-reference', () => ({
  getTickerInfo: (...args: unknown[]) => getTickerInfoMock(...args),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
  }),
}));

import { handler } from '../logo';

function evt(qs: Record<string, string>) {
  return {
    httpMethod: 'GET',
    queryStringParameters: qs,
    headers: {},
    body: null,
  } as any;
}

const fetchSpy = vi.fn();
const originalFetch = globalThis.fetch;

beforeEach(() => {
  getTickerInfoMock.mockReset();
  fetchSpy.mockReset();
  (globalThis as any).fetch = fetchSpy;
  process.env.POLYGON_API_KEY = 'test-secret-key';
});

afterEach(() => {
  (globalThis as any).fetch = originalFetch;
  delete process.env.POLYGON_API_KEY;
});

function pngBytes(): ArrayBuffer {
  // Minimal valid 1x1 PNG-ish payload — bytes don't matter, we're
  // verifying transport. Real Polygon returns proper images.
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).buffer;
}

function mockUpstreamOk(buf: ArrayBuffer, contentType = 'image/png') {
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => buf,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? contentType : null) },
  };
}

describe('GET /api/logo', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid kind', async () => {
    const res = await handler(evt({ ticker: 'AAPL', kind: 'banner' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
  });

  it('returns 500 when POLYGON_API_KEY is not set', async () => {
    delete process.env.POLYGON_API_KEY;
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
    expect((res as any).body).toMatch(/POLYGON_API_KEY/i);
  });

  it('returns 404 when the ticker has no branding URL in cache', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'OBSC', name: 'OBSC', description: null, homepageUrl: null,
      logoUrl: null, iconUrl: null, employees: null, marketCap: null,
      listDate: null, industry: null,
    });
    const res = await handler(evt({ ticker: 'OBSC' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the cached raw URL, appends the API key SERVER-SIDE, and streams bytes back', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/aapl-logo.svg',
      iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue(mockUpstreamOk(pngBytes(), 'image/svg+xml'));

    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);

    // SECURITY: the OUTBOUND fetch URL contains the key.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const fetchedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchedUrl).toContain('apiKey=test-secret-key');
    expect(fetchedUrl).toContain('aapl-logo.svg');

    // SECURITY: the RESPONSE to the client carries the image bytes
    // (base64) and content type - never the URL or the key.
    expect((res as any).isBase64Encoded).toBe(true);
    expect((res as any).headers['Content-Type']).toBe('image/svg+xml');
    expect((res as any).body).not.toContain('apiKey');
    expect((res as any).body).not.toContain('test-secret-key');
  });

  it('selects the iconUrl when kind=icon', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/aapl-logo.svg',
      iconUrl: 'https://api.polygon.io/branding/aapl-icon.png',
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue(mockUpstreamOk(pngBytes(), 'image/png'));

    await handler(evt({ ticker: 'AAPL', kind: 'icon' }), {} as any, () => {});
    const fetchedUrl = fetchSpy.mock.calls[0][0] as string;
    expect(fetchedUrl).toContain('aapl-icon.png');
    expect(fetchedUrl).not.toContain('aapl-logo.svg');
  });

  it('forwards a 404 from the upstream Polygon image endpoint as a 404', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/missing.svg', iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue({
      ok: false, status: 404,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
  });

  it('returns 502 when Polygon returns a non-404 error', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/x.svg', iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue({
      ok: false, status: 500,
      arrayBuffer: async () => new ArrayBuffer(0),
      headers: { get: () => null },
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(502);
  });

  it('falls back to extension-inferred Content-Type when upstream omits it', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/aapl-logo.svg', iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue({
      ok: true, status: 200,
      arrayBuffer: async () => pngBytes(),
      headers: { get: () => null }, // no content-type
    });
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    expect((res as any).headers['Content-Type']).toBe('image/svg+xml');
  });

  it('sets a long browser cache header on success', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/aapl-logo.svg', iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue(mockUpstreamOk(pngBytes()));
    const res = await handler(evt({ ticker: 'AAPL' }), {} as any, () => {});
    const cc = (res as any).headers['Cache-Control'];
    expect(cc).toMatch(/max-age=86400/);
    expect(cc).toMatch(/immutable/);
  });

  it('uppercases the ticker before lookup', async () => {
    getTickerInfoMock.mockResolvedValue({
      ticker: 'AAPL', name: 'Apple', description: null, homepageUrl: null,
      logoUrl: 'https://api.polygon.io/branding/aapl-logo.svg', iconUrl: null,
      employees: null, marketCap: null, listDate: null, industry: null,
    });
    fetchSpy.mockResolvedValue(mockUpstreamOk(pngBytes()));
    await handler(evt({ ticker: 'aapl' }), {} as any, () => {});
    expect(getTickerInfoMock).toHaveBeenCalledWith('AAPL');
  });
});
