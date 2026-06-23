import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { rescanWorkerFor, canDispatchRescan, dispatchRescan } from '../shared/rescan-dispatch';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
  delete process.env.URL;
});

describe('rescan-dispatch registry', () => {
  it('maps known (board, universe) pairs to their bg worker', () => {
    expect(rescanWorkerFor('target-board', 'sp500')).toBe('scan-target-board-sp500-background');
    expect(rescanWorkerFor('catalyst', 'russell2k')).toBe('scan-catalyst-russell2k-background');
    expect(rescanWorkerFor('insider', 'sp500')).toBe('scan-insider-sp500-background');
    expect(rescanWorkerFor('lynch', 'russell2k')).toBe('scan-lynch-russell2k-background');
  });

  it('returns null for pairs without a worker', () => {
    expect(rescanWorkerFor('lynch', 'sp500')).toBeNull(); // no lynch-sp500 worker
    expect(rescanWorkerFor('williams', 'sp500')).toBeNull();
    expect(rescanWorkerFor('target-board', 'ndx')).toBeNull();
    expect(canDispatchRescan('lynch', 'sp500')).toBe(false);
    expect(canDispatchRescan('catalyst', 'sp500')).toBe(true);
  });
});

describe('dispatchRescan', () => {
  beforeEach(() => {
    process.env.URL = 'https://example.netlify.app';
  });

  it('POSTs the worker endpoint and returns true', async () => {
    const fetchMock = vi.fn(async () => ({ status: 202 }) as any);
    globalThis.fetch = fetchMock as any;
    const ok = await dispatchRescan('catalyst', 'sp500');
    expect(ok).toBe(true);
    const [url, opts] = fetchMock.mock.calls[0] as any;
    expect(url).toBe('https://example.netlify.app/.netlify/functions/scan-catalyst-sp500-background');
    expect(opts.method).toBe('POST');
  });

  it('returns false (no fetch) when no worker exists for the pair', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as any;
    const ok = await dispatchRescan('lynch', 'sp500');
    expect(ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns false when the dispatch fetch throws', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('network down');
    }) as any;
    const ok = await dispatchRescan('insider', 'russell2k');
    expect(ok).toBe(false);
  });
});
