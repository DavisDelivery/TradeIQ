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

  // code-review-2026-06 M1 — catalyst is server-filtered by `filter` +
  // `minConviction`; every combination must be a distinct cache entry or
  // the filter buttons are no-ops within staleTime and AlertsView's
  // filter=all/minConviction=low payload pollutes CatalystView's default
  // medium-conviction view.
  it('catalyst filter and minConviction are part of the key', () => {
    const def = JSON.stringify(queryKeys.catalyst('sp500', 'all', 'medium'));
    const cluster = JSON.stringify(queryKeys.catalyst('sp500', 'cluster', 'medium'));
    const low = JSON.stringify(queryKeys.catalyst('sp500', 'all', 'low'));
    const high = JSON.stringify(queryKeys.catalyst('sp500', 'all', 'high'));
    expect(def).not.toBe(cluster); // filter changes the key
    expect(def).not.toBe(low); // minConviction changes the key
    expect(low).not.toBe(high);
    // AlertsView's key (all/low) never collides with CatalystView's
    // default (all/medium).
    expect(JSON.stringify(queryKeys.catalyst('sp500', 'all', 'low'))).not.toBe(
      JSON.stringify(queryKeys.catalyst('sp500', 'all', 'medium')),
    );
  });

  // code-review-2026-06 M2 — insider is server-windowed by `days=`; the
  // 30/60/90/180d selector must produce distinct cache entries.
  it('insider windowDays is part of the key', () => {
    const keys = [30, 60, 90, 180].map((d) => JSON.stringify(queryKeys.insider('sp500', d)));
    expect(new Set(keys).size).toBe(4);
    // The bare-universe form (default window) matches the hook's default
    // windowDays=90 so legacy callers keep hitting the same entry.
    expect(JSON.stringify(queryKeys.insider('sp500'))).toBe(
      JSON.stringify(queryKeys.insider('sp500', 90)),
    );
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
