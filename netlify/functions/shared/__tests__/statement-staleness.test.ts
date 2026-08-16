// The tripwire for a provider silently serving a historical window.
//
// THE INCIDENT: raising the live statement limit from 8 to 40 returned exactly
// 20 rows for EVERY ticker with a ceiling around mid-2021 — five-year-old
// financials rendered as a completely normal-looking chart:
//
//     limit=8   ->  8 rows, newest 2026-06-27   (current)
//     limit=40  -> 20 rows, newest 2021-07-03   (AAPL/MSFT/NUE/XOM alike)
//
// The provider does not clamp an over-large limit; it falls back to a fixed
// window. Nothing in the stack compared the newest period end to today, so a
// chart of FY2017-FY2020 revenue drew without a word of warning. That is worse
// than an empty chart: an empty one tells you something is wrong.

import { describe, it, expect } from 'vitest';
import { statementStaleness, STATEMENT_STALE_AFTER_DAYS, LIVE_STATEMENT_QUARTERS } from '../data-provider';

const NOW = new Date('2026-08-15T00:00:00Z');

describe('statementStaleness', () => {
  it('passes a normally-lagged filing', () => {
    // Quarterly statements land weeks after period end; that is not stale.
    const s = statementStaleness('2026-06-27', NOW);
    expect(s.stale).toBe(false);
    expect(s.reason).toBeNull();
  });

  it('catches the exact date the incident produced', () => {
    const s = statementStaleness('2021-07-03', NOW);
    expect(s.stale).toBe(true);
    expect(s.ageDays).toBeGreaterThan(1800);
    expect(s.reason).toMatch(/historical window/);
    expect(s.reason).toMatch(/2021-07-03/);
  });

  it('states the age in months, so the banner is readable at a glance', () => {
    expect(statementStaleness('2021-07-03', NOW).reason).toMatch(/\d+ months old/);
  });

  it('is quiet at the boundary and loud one day past it', () => {
    const day = 86_400_000;
    const at = new Date(NOW.getTime() - STATEMENT_STALE_AFTER_DAYS * day)
      .toISOString().slice(0, 10);
    const past = new Date(NOW.getTime() - (STATEMENT_STALE_AFTER_DAYS + 1) * day)
      .toISOString().slice(0, 10);
    expect(statementStaleness(at, NOW).stale).toBe(false);
    expect(statementStaleness(past, NOW).stale).toBe(true);
  });

  it('says nothing when there is no data to judge', () => {
    // Absent history is `_reason`'s job, not this one's.
    for (const v of [null, undefined, '', 'not-a-date']) {
      expect(statementStaleness(v as any, NOW).stale).toBe(false);
    }
  });

  it('does not flag a future period end as stale', () => {
    expect(statementStaleness('2027-01-01', NOW).stale).toBe(false);
  });
});

describe('the limit that caused it', () => {
  it('stays at or below the value confirmed to return current data', () => {
    // 40 silently degraded to a 2021 window. Raising this again requires
    // re-checking currency against a real ticker — hence the ceiling here.
    expect(LIVE_STATEMENT_QUARTERS).toBeLessThanOrEqual(20);
  });

  it('still fills the 5Y window the chart offers', () => {
    // The original complaint was that 5Y and ALL rendered identically because
    // only 8 quarters were ever fetched.
    expect(LIVE_STATEMENT_QUARTERS).toBeGreaterThanOrEqual(20);
  });
});
