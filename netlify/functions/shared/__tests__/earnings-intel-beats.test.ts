// Unit tests for the 4c-1 W5 fix: beatsLast4 must distinguish
// "Finnhub returned no usable surprise data" from "company missed all 4
// quarters". Previously the code emitted 0 in both cases, which the UI
// rendered as "0/4 beats" — a misleading false statement of fact.
//
// Fix contract:
//   surprises.length === 0  → beatsLast4 = null, beatsLast4Quarters = 0
//   surprises.length > 0    → beatsLast4 = count(s > 0), beatsLast4Quarters = surprises.length
//
// We mock the data-provider so the unit test runs hermetically.

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the provider before importing the SUT — otherwise the real fetcher
// runs at import time on some paths.
vi.mock('../data-provider', () => ({
  getFundamentals: vi.fn(),
  getEarningsHistory: vi.fn(),
  getUpcomingEarnings: vi.fn(),
}));

import { getEarningsIntel } from '../earnings-intel';
import { getFundamentals, getEarningsHistory, getUpcomingEarnings } from '../data-provider';

beforeEach(() => {
  vi.resetAllMocks();
  (getFundamentals as any).mockResolvedValue({
    epsGrowthYoY: 0.20,
    revenueGrowthYoY: 0.15,
    ttmEps: 5.5,
    operatingMargin: 0.25,
    grossMargin: 0.60,
  });
  (getUpcomingEarnings as any).mockResolvedValue(null);
});

describe('beatsLast4 — full 4-quarter window with all beats', () => {
  it('returns 4/4 when every quarter beat', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-28', epsActual: 1.10, epsEstimate: 1.00, surprisePct: 10 },
      { period: '2025-12-31', announceDate: '2026-01-28', epsActual: 0.95, epsEstimate: 0.90, surprisePct: 5.6 },
      { period: '2025-09-30', announceDate: '2025-10-28', epsActual: 1.00, epsEstimate: 0.95, surprisePct: 5.3 },
      { period: '2025-06-30', announceDate: '2025-07-29', epsActual: 0.85, epsEstimate: 0.80, surprisePct: 6.3 },
    ]);

    const intel = await getEarningsIntel('TEST');
    expect(intel.beatsLast4).toBe(4);
    expect(intel.beatsLast4Quarters).toBe(4);
    expect(intel.streak).toBe('beats');
  });
});

describe('beatsLast4 — full 4-quarter window with mixed results', () => {
  it('returns the correct beat count when some are misses', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-28', epsActual: 1.00, epsEstimate: 1.10, surprisePct: -9.1 },
      { period: '2025-12-31', announceDate: '2026-01-28', epsActual: 0.95, epsEstimate: 0.90, surprisePct: 5.6 },
      { period: '2025-09-30', announceDate: '2025-10-28', epsActual: 1.00, epsEstimate: 1.05, surprisePct: -4.8 },
      { period: '2025-06-30', announceDate: '2025-07-29', epsActual: 0.85, epsEstimate: 0.80, surprisePct: 6.3 },
    ]);

    const intel = await getEarningsIntel('TEST');
    expect(intel.beatsLast4).toBe(2);
    expect(intel.beatsLast4Quarters).toBe(4);
  });
});

describe('beatsLast4 — no data path (the bug)', () => {
  it('returns null when Finnhub returns 0 quarters of surprise history', async () => {
    (getEarningsHistory as any).mockResolvedValue([]);

    const intel = await getEarningsIntel('SMALLCAP');
    // The key assertion: beatsLast4 is NULL, not 0. Pre-fix, this was 0
    // and rendered as "0/4 beats" — a false claim of 4 misses.
    expect(intel.beatsLast4).toBeNull();
    expect(intel.beatsLast4Quarters).toBe(0);
  });

  it('returns null when surprises are present but all unparsable', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-28', epsActual: undefined, epsEstimate: undefined },
      { period: '2025-12-31', announceDate: '2026-01-28', epsActual: NaN, epsEstimate: 1.00 },
    ]);

    const intel = await getEarningsIntel('TEST');
    expect(intel.beatsLast4).toBeNull();
    expect(intel.beatsLast4Quarters).toBe(0);
  });
});

describe('beatsLast4 — partial window (newly public ticker)', () => {
  it('returns a fractional count with quarters denominator when fewer than 4 quarters exist', async () => {
    // Company IPO'd 6 months ago — only 2 quarters of earnings history.
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-28', epsActual: 0.50, epsEstimate: 0.45, surprisePct: 11.1 },
      { period: '2025-12-31', announceDate: '2026-01-28', epsActual: 0.30, epsEstimate: 0.40, surprisePct: -25 },
    ]);

    const intel = await getEarningsIntel('NEWCO');
    expect(intel.beatsLast4).toBe(1);          // 1 beat of 2
    expect(intel.beatsLast4Quarters).toBe(2);  // honest denominator
  });
});

describe('beatsLast4 — falls back to safeSurprise when surprisePct is missing', () => {
  it('computes beats from actual vs estimate when surprisePct is absent', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      // surprisePct missing — should fall through to (actual - estimate) / estimate
      { period: '2026-03-31', announceDate: '2026-04-28', epsActual: 1.10, epsEstimate: 1.00 },
      { period: '2025-12-31', announceDate: '2026-01-28', epsActual: 0.95, epsEstimate: 0.90 },
      { period: '2025-09-30', announceDate: '2025-10-28', epsActual: 1.00, epsEstimate: 1.05 },
      { period: '2025-06-30', announceDate: '2025-07-29', epsActual: 0.85, epsEstimate: 0.80 },
    ]);

    const intel = await getEarningsIntel('TEST');
    expect(intel.beatsLast4).toBe(3);
    expect(intel.beatsLast4Quarters).toBe(4);
  });
});
