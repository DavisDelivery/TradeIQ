import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchReinvoke, inferFunctionUrl } from '../reinvoke';

describe('dispatchReinvoke', () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

  beforeEach(() => {
    fetchSpy.mockReset();
    consoleLog.mockClear();
    consoleErr.mockClear();
    (globalThis as any).fetch = fetchSpy;
  });
  afterEach(() => {
    (globalThis as any).fetch = originalFetch;
  });

  it('enqueues the fetch promise via ctx.waitUntil', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    const waitUntilSpy = vi.fn();
    const result = await dispatchReinvoke(
      'https://example.test/.netlify/functions/run-portfolio-backtest-background',
      'pb-x',
      { waitUntil: waitUntilSpy },
    );
    expect(result.ok).toBe(true);
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(waitUntilSpy.mock.calls[0][0]).toBeInstanceOf(Promise);
    // Fetch is invoked synchronously inside dispatchReinvoke (then enqueued).
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toMatch(/run-portfolio-backtest-background/);
    expect(init.method).toBe('POST');
    expect(init.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(init.body);
    expect(body).toEqual({ runId: 'pb-x', resume: true });
  });

  it('passes through extraBody fields alongside runId + resume', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    const waitUntilSpy = vi.fn();
    await dispatchReinvoke(
      'https://example.test/fn',
      'bt_xyz',
      { waitUntil: waitUntilSpy },
      { window: 'full', invocationCount: 3 },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ runId: 'bt_xyz', resume: true, window: 'full', invocationCount: 3 });
  });

  it('falls back to awaiting fetch when waitUntil is absent', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {});
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('logs the dispatch on 2xx response', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {});
    expect(consoleLog).toHaveBeenCalled();
    const logCall = consoleLog.mock.calls.find((c) => c[0] === 'reinvoke_dispatched');
    expect(logCall).toBeDefined();
  });

  it('logs an error on non-2xx response', async () => {
    fetchSpy.mockResolvedValue({ status: 500 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {});
    const errCall = consoleErr.mock.calls.find((c) => c[0] === 'reinvoke_dispatch_non_2xx');
    expect(errCall).toBeDefined();
  });

  it('logs an error when the fetch rejects (but does not throw)', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {});
    expect(result.ok).toBe(true); // dispatch was attempted; the await on the .catch chain swallows
    const errCall = consoleErr.mock.calls.find((c) => c[0] === 'reinvoke_fetch_error');
    expect(errCall).toBeDefined();
  });
});

describe('inferFunctionUrl', () => {
  it('uses x-forwarded-host + x-forwarded-proto when both present', () => {
    const url = inferFunctionUrl(
      { 'x-forwarded-host': 'preview-deploy.netlify.app', 'x-forwarded-proto': 'https' },
      '/.netlify/functions/run-portfolio-backtest-background',
    );
    expect(url).toBe(
      'https://preview-deploy.netlify.app/.netlify/functions/run-portfolio-backtest-background',
    );
  });

  it('defaults proto to https when forwarded-proto absent', () => {
    const url = inferFunctionUrl(
      { 'x-forwarded-host': 'example.com' },
      '/.netlify/functions/foo',
    );
    expect(url).toBe('https://example.com/.netlify/functions/foo');
  });

  it('falls back to host header when forwarded-host absent', () => {
    const url = inferFunctionUrl(
      { host: 'tradeiq-alpha.netlify.app' },
      '/.netlify/functions/foo',
    );
    expect(url).toBe('https://tradeiq-alpha.netlify.app/.netlify/functions/foo');
  });

  it('falls back to process.env.URL when no headers present', () => {
    const prevUrl = process.env.URL;
    process.env.URL = 'https://my-deploy.netlify.app';
    const url = inferFunctionUrl({}, '/.netlify/functions/foo');
    expect(url).toBe('https://my-deploy.netlify.app/.netlify/functions/foo');
    process.env.URL = prevUrl;
  });

  it('falls back to alpha deploy URL when env URL absent', () => {
    const prevUrl = process.env.URL;
    delete process.env.URL;
    const url = inferFunctionUrl({}, '/.netlify/functions/foo');
    expect(url).toBe('https://tradeiq-alpha.netlify.app/.netlify/functions/foo');
    if (prevUrl !== undefined) process.env.URL = prevUrl;
  });
});
