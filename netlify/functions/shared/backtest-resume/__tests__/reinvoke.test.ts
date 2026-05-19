import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dispatchReinvoke, inferFunctionUrl } from '../reinvoke';

describe('dispatchReinvoke', () => {
  const fetchSpy = vi.fn();
  const originalFetch = globalThis.fetch;
  const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
  const consoleErr = vi.spyOn(console, 'error').mockImplementation(() => {});

  // Fast, deterministic sleep + random for retry tests.
  const sleepSpy = vi.fn((_ms: number): Promise<void> => Promise.resolve());
  const random = () => 0;

  beforeEach(() => {
    fetchSpy.mockReset();
    sleepSpy.mockClear();
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
      {},
      { sleep: sleepSpy, random },
    );
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(202);
    expect(waitUntilSpy).toHaveBeenCalledTimes(1);
    expect(waitUntilSpy.mock.calls[0][0]).toBeInstanceOf(Promise);
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
      { sleep: sleepSpy, random },
    );
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body);
    expect(body).toEqual({ runId: 'bt_xyz', resume: true, window: 'full', invocationCount: 3 });
  });

  it('returns ok=true on first 2xx without retrying', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      sleep: sleepSpy, random,
    });
    expect(result).toMatchObject({ ok: true, attempts: 1, lastStatus: 202 });
    expect(result.error).toBeUndefined();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('retries on 429 with backoff and reports the eventual success', async () => {
    fetchSpy
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 429 })
      .mockResolvedValueOnce({ status: 202 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 4, baseBackoffMs: 100, sleep: sleepSpy, random,
    });
    expect(result).toMatchObject({ ok: true, attempts: 3, lastStatus: 202 });
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(sleepSpy).toHaveBeenCalledTimes(2); // two backoffs between three attempts
  });

  it('retries on 503 (transient 5xx)', async () => {
    fetchSpy
      .mockResolvedValueOnce({ status: 503 })
      .mockResolvedValueOnce({ status: 200 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 4, baseBackoffMs: 100, sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(result.lastStatus).toBe(200);
  });

  it('retries on a network-level fetch rejection then succeeds', async () => {
    fetchSpy
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce({ status: 202 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 4, baseBackoffMs: 100, sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(true);
    expect(result.attempts).toBe(2);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it('does NOT retry on a non-transient 4xx (e.g. 400)', async () => {
    fetchSpy.mockResolvedValue({ status: 400 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 4, baseBackoffMs: 100, sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(1);
    expect(result.lastStatus).toBe(400);
    expect(result.error).toBe('HTTP 400');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('returns ok=false with the last error after exhausting attempts on persistent 429', async () => {
    fetchSpy.mockResolvedValue({ status: 429 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 3, baseBackoffMs: 50, sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(3);
    expect(result.lastStatus).toBe(429);
    expect(result.error).toBe('HTTP 429');
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const exhaustedLog = consoleErr.mock.calls.find((c) => c[0] === 'reinvoke_dispatch_exhausted');
    expect(exhaustedLog).toBeDefined();
  });

  it('returns ok=false on a persistent network rejection', async () => {
    fetchSpy.mockRejectedValue(new Error('network down'));
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 2, baseBackoffMs: 50, sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(false);
    expect(result.attempts).toBe(2);
    expect(result.error).toBe('network down');
  });

  it('applies startup jitter sleep when jitterMs > 0', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 1, jitterMs: 1000, sleep: sleepSpy, random: () => 0.5,
    });
    // jitter sleep was the only sleep (no backoff for a single attempt).
    expect(sleepSpy).toHaveBeenCalledTimes(1);
    expect(sleepSpy.mock.calls[0][0]).toBe(500); // floor(0.5 * 1000)
  });

  it('does NOT sleep when jitterMs is omitted or zero', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 1, sleep: sleepSpy, random,
    });
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  it('falls back to awaiting the chain when waitUntil is absent', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    const result = await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      sleep: sleepSpy, random,
    });
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('logs the dispatch on 2xx response with the attempt number', async () => {
    fetchSpy.mockResolvedValue({ status: 202 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      sleep: sleepSpy, random,
    });
    const logCall = consoleLog.mock.calls.find((c) => c[0] === 'reinvoke_dispatched');
    expect(logCall).toBeDefined();
    expect(logCall![1]).toMatchObject({ status: 202, attempt: 1 });
  });

  it('logs transient errors distinctly from non-2xx config errors', async () => {
    fetchSpy.mockResolvedValueOnce({ status: 502 }).mockResolvedValueOnce({ status: 200 });
    await dispatchReinvoke('https://example.test/fn', 'pb-x', {}, {}, {
      maxAttempts: 4, baseBackoffMs: 50, sleep: sleepSpy, random,
    });
    const transientLog = consoleErr.mock.calls.find((c) => c[0] === 'reinvoke_dispatch_transient');
    expect(transientLog).toBeDefined();
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
