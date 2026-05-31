// Phase 6 PR-G0 — withTimeout / withTimeoutStatus unit tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { withTimeout, withTimeoutStatus } from '../with-timeout';

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('withTimeout', () => {
  it('resolves with the promise value when it settles before the timer', async () => {
    const p = Promise.resolve('ok');
    await expect(withTimeout(p, 1000, 'fallback')).resolves.toBe('ok');
  });

  it('resolves with the fallback when the timer fires first', async () => {
    let resolveIt: (v: string) => void = () => {};
    const hung = new Promise<string>((res) => { resolveIt = res; });
    const out = withTimeout(hung, 100, 'fallback');
    vi.advanceTimersByTime(150);
    await expect(out).resolves.toBe('fallback');
    // Settling the orphan after the timer must NOT throw or affect anything.
    resolveIt('late');
  });

  it('resolves with the fallback when the promise rejects', async () => {
    const rejected = Promise.reject(new Error('boom'));
    await expect(withTimeout(rejected, 1000, 'fallback')).resolves.toBe('fallback');
  });

  it('never resolves twice (timer + late resolution)', async () => {
    let resolveIt: (v: string) => void = () => {};
    const hung = new Promise<string>((res) => { resolveIt = res; });
    const out = withTimeout(hung, 50, 'fallback');
    vi.advanceTimersByTime(100);
    const first = await out;
    expect(first).toBe('fallback');
    resolveIt('late');
    // No way to observe a double-resolve directly — the assertion that the
    // first value is preserved + the resolveIt call doesn't throw is the
    // contract.
  });
});

describe('withTimeoutStatus', () => {
  it('reports timedOut=true when the timer fires', async () => {
    const hung = new Promise<number>(() => { /* never settles */ });
    const out = withTimeoutStatus(hung, 100, -1);
    vi.advanceTimersByTime(150);
    const r = await out;
    expect(r.timedOut).toBe(true);
    expect(r.errored).toBe(false);
    expect(r.value).toBe(-1);
  });

  it('reports errored=true when the promise rejects', async () => {
    const r = await withTimeoutStatus(Promise.reject(new Error('x')), 1000, -1);
    expect(r.timedOut).toBe(false);
    expect(r.errored).toBe(true);
    expect(r.value).toBe(-1);
  });

  it('reports both flags false on success', async () => {
    const r = await withTimeoutStatus(Promise.resolve(7), 1000, -1);
    expect(r.timedOut).toBe(false);
    expect(r.errored).toBe(false);
    expect(r.value).toBe(7);
  });
});
