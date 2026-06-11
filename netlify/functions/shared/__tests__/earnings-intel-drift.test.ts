// Wave 2C (CR-3) — postEarningsDrift must anchor on the ANNOUNCEMENT
// date, not the fiscal period end.
//
// Pre-fix, daysSince was computed from `history[0].date` = Finnhub's
// `period` (quarter end). The report usually isn't even out 3-14 days
// after quarter end, so the PEAD flag fired at the wrong time or never.
// Fix contract:
//   - daysSince anchors on history[0].announceDate;
//   - unknown announceDate ⇒ drift is conservatively false (skip), never
//     inferred from period-end.
//
// asOfDate pins "now" (the provider mock ignores it), keeping the window
// math deterministic without fake timers.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../data-provider', () => ({
  getFundamentals: vi.fn(),
  getEarningsHistory: vi.fn(),
  getUpcomingEarnings: vi.fn(),
}));

import { getEarningsIntel } from '../earnings-intel';
import { getFundamentals, getEarningsHistory, getUpcomingEarnings } from '../data-provider';

beforeEach(() => {
  vi.resetAllMocks();
  (getFundamentals as any).mockResolvedValue(null);
  (getUpcomingEarnings as any).mockResolvedValue(null);
});

describe('postEarningsDrift — announcement-date anchoring', () => {
  it('fires when the latest beat was ANNOUNCED 3-14 days ago', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      // Period ended ~5 weeks before "now"; announced 6 days ago.
      { period: '2026-03-31', announceDate: '2026-04-29', epsActual: 1.1, epsEstimate: 1.0, surprisePct: 10 },
    ]);
    const intel = await getEarningsIntel('TEST', { asOfDate: '2026-05-05' });
    expect(intel.postEarningsDrift).toBe(true);
    expect(intel.flags).toContain('post_earnings_drift');
  });

  it('stays false when the announcement date is unknown, even if the PERIOD end falls in the window', async () => {
    // Pre-fix this fired: period 2026-05-01 is 4 "days since" 2026-05-05.
    // With the announcement unresolved the window is unknowable — skip.
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-05-01', announceDate: null, epsActual: 1.1, epsEstimate: 1.0, surprisePct: 10 },
    ]);
    const intel = await getEarningsIntel('TEST', { asOfDate: '2026-05-05' });
    expect(intel.postEarningsDrift).toBe(false);
    expect(intel.flags).not.toContain('post_earnings_drift');
  });

  it('stays false once the drift window has passed the announcement', async () => {
    (getEarningsHistory as any).mockResolvedValue([
      { period: '2026-03-31', announceDate: '2026-04-29', epsActual: 1.1, epsEstimate: 1.0, surprisePct: 10 },
    ]);
    const intel = await getEarningsIntel('TEST', { asOfDate: '2026-06-10' });
    expect(intel.postEarningsDrift).toBe(false);
  });

  it('threads withAnnounceDates through to the provider', async () => {
    (getEarningsHistory as any).mockResolvedValue([]);
    await getEarningsIntel('TEST', { withAnnounceDates: true });
    expect((getEarningsHistory as any).mock.calls[0][2]).toMatchObject({ withAnnounceDates: true });
  });
});
