// Phase 4o W1 — token bucket + 429-aware fetch wrapper.
//
// Hermetic: no real timers, no real fetch. We drive a fake clock + fake
// sleep so the suite runs instantly regardless of the configured rate.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  createTokenBucket,
  fetchWithRateLimit,
  getFinnhubBucket,
  resolveFinnhubRpm,
  _resetFinnhubBucketForTests,
} from '../rate-limiter';

function fakeClock() {
  let t = 0;
  let sleeps: number[] = [];
  return {
    now: () => t,
    sleep: async (ms: number) => {
      sleeps.push(ms);
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    sleeps,
    reset: () => {
      t = 0;
      sleeps.length = 0;
    },
  };
}

describe('createTokenBucket', () => {
  it('starts full at capacity and lets the first `capacity` calls through without sleeping', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 60,
      capacity: 60,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(b.available()).toBe(60);
    expect(b.capacity()).toBe(60);
    for (let i = 0; i < 60; i++) await b.acquire();
    // No sleeps — bucket was full and never starved.
    expect(clk.sleeps).toEqual([]);
    // Bucket is drained.
    expect(b.available()).toBeLessThan(1);
  });

  it('initialTokens caps the cold-start burst without touching the sustained rate', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 60,
      capacity: 60,
      initialTokens: 8,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(b.available()).toBe(8);
    expect(b.capacity()).toBe(60); // burst ceiling unchanged
    for (let i = 0; i < 8; i++) await b.acquire();
    expect(clk.sleeps).toEqual([]); // first 8 free
    await b.acquire(); // 9th must wait for refill (60/min ⇒ ~1s)
    expect(clk.sleeps.length).toBeGreaterThan(0);
    expect(clk.sleeps[0]).toBeGreaterThan(800);
  });

  it('initialTokens is clamped to capacity', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 60,
      capacity: 10,
      initialTokens: 999,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(b.available()).toBe(10);
  });

  it('blocks the 61st call until the bucket has refilled enough for one token', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 60,
      capacity: 60,
      windowMs: 60_000,
      now: clk.now,
      sleep: clk.sleep,
    });
    for (let i = 0; i < 60; i++) await b.acquire();
    expect(clk.sleeps).toEqual([]);
    // Drained — the 61st call must sleep.
    await b.acquire();
    expect(clk.sleeps.length).toBe(1);
    // refillPerMs = 60 / 60_000 = 0.001 — one token takes 1000ms.
    expect(clk.sleeps[0]).toBe(1000);
  });

  it('refills naturally as the clock advances between calls', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 60,
      capacity: 60,
      windowMs: 60_000,
      now: clk.now,
      sleep: clk.sleep,
    });
    for (let i = 0; i < 60; i++) await b.acquire();
    // Advance 30s — should refill ~30 tokens.
    clk.advance(30_000);
    expect(b.available()).toBeGreaterThanOrEqual(29);
    // The next 30 acquire()s should all be free.
    for (let i = 0; i < 30; i++) await b.acquire();
    expect(clk.sleeps).toEqual([]);
  });

  it('serializes concurrent acquire() calls so the bucket never goes negative-by-races', async () => {
    const clk = fakeClock();
    const b = createTokenBucket({
      callsPerWindow: 2,
      capacity: 2,
      windowMs: 1000,
      now: clk.now,
      sleep: clk.sleep,
    });
    // Fire 4 acquires concurrently. With capacity=2, first 2 are free; the
    // next two must each wait ~500ms (refill = 2/1000 = 0.002 tok/ms).
    const promises = [b.acquire(), b.acquire(), b.acquire(), b.acquire()];
    await Promise.all(promises);
    // Two of the acquires triggered a sleep (no race-doublespending).
    expect(clk.sleeps.length).toBe(2);
  });
});

describe('fetchWithRateLimit', () => {
  it('returns the response directly when the first attempt is 2xx', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 200,
      ok: true,
      headers: { get: () => null },
    })) as any;
    const r = await fetchWithRateLimit('http://x', undefined, { fetchImpl });
    expect(r.rateLimitHits).toBe(0);
    expect(r.rateLimitExhausted).toBe(false);
    expect(r.res.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('retries on 429 with exponential backoff and succeeds when the next response is 200', async () => {
    const sleeps: number[] = [];
    let callIdx = 0;
    const fetchImpl = vi.fn(async () => {
      callIdx += 1;
      if (callIdx < 3) {
        return {
          status: 429,
          ok: false,
          headers: { get: () => null },
        } as any;
      }
      return { status: 200, ok: true, headers: { get: () => null } } as any;
    });
    const r = await fetchWithRateLimit('http://x', undefined, {
      fetchImpl: fetchImpl as any,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      initialBackoffMs: 100,
    });
    expect(r.res.status).toBe(200);
    expect(r.rateLimitHits).toBe(2);
    expect(r.rateLimitExhausted).toBe(false);
    // Exponential backoff: 100, 200.
    expect(sleeps).toEqual([100, 200]);
  });

  it('honors Retry-After when present (seconds)', async () => {
    const sleeps: number[] = [];
    let idx = 0;
    const fetchImpl = vi.fn(async () => {
      idx += 1;
      if (idx === 1) {
        return {
          status: 429,
          ok: false,
          headers: { get: (k: string) => (k.toLowerCase() === 'retry-after' ? '2' : null) },
        } as any;
      }
      return { status: 200, ok: true, headers: { get: () => null } } as any;
    });
    const r = await fetchWithRateLimit('http://x', undefined, {
      fetchImpl: fetchImpl as any,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    expect(r.res.status).toBe(200);
    expect(sleeps).toEqual([2000]);
  });

  it('exhausts retries and returns the final 429 with rateLimitExhausted=true', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: { get: () => null },
    })) as any;
    const r = await fetchWithRateLimit('http://x', undefined, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 2,
      initialBackoffMs: 10,
    });
    expect(r.res.status).toBe(429);
    expect(r.rateLimitExhausted).toBe(true);
    // 1 initial + 2 retries = 3 fetches; 2 sleeps between the retries.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([10, 20]);
  });

  it('does NOT retry on non-429 errors (e.g. 500)', async () => {
    const fetchImpl = vi.fn(async () => ({
      status: 500,
      ok: false,
      headers: { get: () => null },
    })) as any;
    const r = await fetchWithRateLimit('http://x', undefined, { fetchImpl });
    expect(r.res.status).toBe(500);
    expect(r.rateLimitHits).toBe(0);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('caps backoff at maxBackoffMs', async () => {
    const sleeps: number[] = [];
    const fetchImpl = vi.fn(async () => ({
      status: 429,
      ok: false,
      headers: { get: () => null },
    })) as any;
    await fetchWithRateLimit('http://x', undefined, {
      fetchImpl,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      maxRetries: 5,
      initialBackoffMs: 1000,
      maxBackoffMs: 2000,
    });
    // 1000, 2000, 2000, 2000, 2000 (cap)
    expect(sleeps[0]).toBe(1000);
    for (let i = 1; i < sleeps.length; i++) expect(sleeps[i]).toBe(2000);
  });
});

describe('getFinnhubBucket', () => {
  beforeEach(() => {
    _resetFinnhubBucketForTests();
  });

  it('returns a singleton bucket whose capacity matches env or default', () => {
    const b = getFinnhubBucket();
    // Default is 55/min — capacity at least 1 and reasonable.
    expect(b.capacity()).toBeGreaterThanOrEqual(1);
    expect(getFinnhubBucket()).toBe(b);
  });
});

// Wave 4B (code-review-2026-06 infra minor 8): a malformed FINNHUB_RPM
// used to produce `Number('garbage') = NaN`, which silently disabled
// pacing (every NaN comparison is false, so acquire() never throttled).
describe('resolveFinnhubRpm — env validation (Wave 4B)', () => {
  const ORIGINAL = process.env.FINNHUB_RPM;

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FINNHUB_RPM;
    else process.env.FINNHUB_RPM = ORIGINAL;
    _resetFinnhubBucketForTests();
  });

  it('falls back to the default (55) when FINNHUB_RPM is not a number', () => {
    process.env.FINNHUB_RPM = 'not-a-number';
    expect(resolveFinnhubRpm()).toBe(55);
    _resetFinnhubBucketForTests();
    // The bucket must have a real, finite capacity — NaN here meant
    // pacing was a no-op.
    expect(getFinnhubBucket().capacity()).toBe(55);
  });

  it('falls back to the default when FINNHUB_RPM is zero or negative', () => {
    process.env.FINNHUB_RPM = '0';
    expect(resolveFinnhubRpm()).toBe(55);
    process.env.FINNHUB_RPM = '-10';
    expect(resolveFinnhubRpm()).toBe(55);
  });

  it('uses a valid FINNHUB_RPM override', () => {
    process.env.FINNHUB_RPM = '120';
    expect(resolveFinnhubRpm()).toBe(120);
    _resetFinnhubBucketForTests();
    expect(getFinnhubBucket().capacity()).toBe(120);
  });

  it('uses the default when FINNHUB_RPM is unset', () => {
    delete process.env.FINNHUB_RPM;
    expect(resolveFinnhubRpm()).toBe(55);
  });

  it('warns once (not per call) on a malformed value', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    process.env.FINNHUB_RPM = 'garbage';
    resolveFinnhubRpm();
    resolveFinnhubRpm();
    const rpmWarnings = warnSpy.mock.calls.filter((c) =>
      String(c[0]).includes('FINNHUB_RPM'),
    );
    expect(rpmWarnings.length).toBeLessThanOrEqual(1);
    warnSpy.mockRestore();
  });
});
