import { describe, it, expect } from 'vitest';
import { queryKeys } from '../queryKeys';

// Lightweight test for the query-key factory. The real bug we're guarding
// against is two views accidentally sharing a cache entry — different
// universes / different filters / different boards must yield distinct
// keys. This is critical for the dedup behavior TanStack Query depends on.

describe('queryKeys', () => {
  it('every board gets its own namespace', () => {
    const keys = [
      queryKeys.targetBoard('sp500'),
      queryKeys.prophet('sp500'),
      queryKeys.catalyst('sp500'),
      queryKeys.insider('sp500'),
      queryKeys.williams('sp500'),
      queryKeys.lynch('sp500'),
      queryKeys.earnings(7),
    ];
    const stringified = keys.map((k) => JSON.stringify(k));
    const set = new Set(stringified);
    expect(set.size).toBe(keys.length);
  });

  it('different universes produce different keys', () => {
    const a = JSON.stringify(queryKeys.targetBoard('sp500'));
    const b = JSON.stringify(queryKeys.targetBoard('ndx'));
    expect(a).not.toBe(b);
  });

  it('prophet conviction filter is part of the key', () => {
    const noFilter = JSON.stringify(queryKeys.prophet('sp500'));
    const high = JSON.stringify(queryKeys.prophet('sp500', 'high'));
    const med = JSON.stringify(queryKeys.prophet('sp500', 'medium'));
    expect(noFilter).not.toBe(high);
    expect(high).not.toBe(med);
  });

  it('all keys begin with the tradeiq namespace', () => {
    const samples = [
      queryKeys.targetBoard('sp500'),
      queryKeys.health(),
      queryKeys.regime(),
      queryKeys.research('AAPL'),
      queryKeys.snapshotHistory('target'),
    ];
    for (const k of samples) {
      expect(k[0]).toBe('tradeiq');
    }
  });

  it('queryKeys.all enables full cache wipe', () => {
    expect(queryKeys.all).toEqual(['tradeiq']);
    // Every other key should start with the same prefix so
    // invalidateQueries({ queryKey: queryKeys.all }) hits everything.
    const samples = [
      queryKeys.targetBoard('any'),
      queryKeys.earnings(7, 'any'),
      queryKeys.research('TICKER'),
    ];
    for (const k of samples) {
      expect(k[0]).toBe(queryKeys.all[0]);
    }
  });

  it('research and chartAnalysis are different namespaces (cheap vs expensive)', () => {
    // useResearch (skipAi=1) and useChartAnalysis (full) hit the same
    // endpoint with different params — they MUST have different cache
    // keys or the cheap variant will pollute the AI-narrative variant.
    expect(JSON.stringify(queryKeys.research('AAPL'))).not.toBe(
      JSON.stringify(queryKeys.chartAnalysis('AAPL')),
    );
  });
});
