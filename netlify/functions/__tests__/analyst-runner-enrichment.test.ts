// Phase 4h W3 — verify companyName + sector land on every Target.
//
// The full analyst-runner pipeline pulls 8+ providers; we mock them
// all to nulls/empty so the scoring path returns no-data sub-scores
// without crashing, and assert the two enrichment fields are present
// on the emitted Target. This pins the contract the snapshot reads
// downstream depend on (UI W4 + snapshot persistence).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../shared/data-provider', () => ({
  getDailyBars: vi.fn(async () => []),
  getFundamentals: vi.fn(async () => null),
  getNews: vi.fn(async () => []),
  getUpcomingEarnings: vi.fn(async () => null),
  getEarningsHistory: vi.fn(async () => []),
}));

vi.mock('../shared/insider-provider', () => ({
  getInsiderActivity: vi.fn(async () => null),
}));

vi.mock('../shared/patent-provider', () => ({
  getPatentActivity: vi.fn(async () => null),
}));

vi.mock('../shared/political-provider', () => ({
  getPoliticalActivity: vi.fn(async () => null),
}));

vi.mock('../shared/govcontracts-provider', () => ({
  getGovContractActivity: vi.fn(async () => null),
}));

import { runAnalystsForTicker } from '../shared/analyst-runner';
import type { Bar } from '../shared/data-provider';

function syntheticBars(n: number): Bar[] {
  const bars: Bar[] = [];
  const start = Date.UTC(2024, 0, 2);
  for (let i = 0; i < n; i++) {
    const c = 100 + Math.sin(i / 5) * 5 + i * 0.1;
    bars.push({
      t: start + i * 86_400_000,
      o: c - 0.5,
      h: c + 0.7,
      l: c - 0.7,
      c,
      v: 1_000_000 + i * 1000,
    });
  }
  return bars;
}

const barCache = {
  AAPL: syntheticBars(220),
  SPY: syntheticBars(220),
  XLK: syntheticBars(220),
};

beforeEach(() => {
  // each test starts with fresh in-process state for the provider mocks
});

describe('runAnalystsForTicker — Phase 4h enrichment', () => {
  it('attaches companyName from opts.companyName (Polygon-cached path)', async () => {
    const { target } = await runAnalystsForTicker({
      ticker: 'AAPL',
      barCache,
      companyName: 'Apple Inc.',
    });
    expect(target).not.toBeNull();
    expect(target!.companyName).toBe('Apple Inc.');
    expect(target!.sector).toBe('Technology');
  });

  it('falls back to the in-repo universe name when opts.companyName is omitted', async () => {
    const { target } = await runAnalystsForTicker({
      ticker: 'AAPL',
      barCache,
      // companyName intentionally omitted
    });
    expect(target).not.toBeNull();
    expect(target!.companyName).toBe('Apple');
  });

  it('sector is null for tickers absent from the in-repo universe', async () => {
    const { target } = await runAnalystsForTicker({
      ticker: 'UNKNOWN-SYM',
      barCache: { 'UNKNOWN-SYM': syntheticBars(220), SPY: syntheticBars(220) },
    });
    expect(target).not.toBeNull();
    expect(target!.sector).toBeNull();
    expect(target!.companyName).toBe('UNKNOWN-SYM');
  });

  it('returns target: null when there are insufficient bars (no enrichment leaks)', async () => {
    const { target } = await runAnalystsForTicker({
      ticker: 'AAPL',
      barCache: { AAPL: syntheticBars(10), SPY: syntheticBars(220) },
      companyName: 'Apple Inc.',
    });
    expect(target).toBeNull();
  });
});
