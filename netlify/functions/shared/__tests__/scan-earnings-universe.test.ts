// Pins the earnings calendar-resolution contract.
//
// Settled 2026-07-24 after a wrong turn in BOTH directions, so these tests
// encode the measurement rather than a theory. Ground truth from prod that
// day: the bulk range's earliest entry was 2026-08-10 while the per-symbol
// calendar had MSFT/META on 07-29 and AMZN/AAPL on 07-30 — all four absent
// from the published snapshot. The bulk range under-reports the FRONT of the
// calendar without announcing it, and the per-symbol path sees through it.
//
// The two guards below are the expensive lessons:
//   - never probe when the range call itself failed (a probe fired into an
//     active 429 storm killed a run in 4 seconds), and
//   - a far-dated calendar must still be REPAIRED, not accepted as a lull.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  range: vi.fn(),
  probe: vi.fn(),
}));

vi.mock('../data-provider', async (importOriginal) => {
  const orig = await importOriginal<any>();
  return {
    ...orig,
    getEarningsCalendarRangeWithStatus: h.range,
    getUpcomingEarnings: h.probe,
  };
});

import { resolveEarningsScanUniverse } from '../scan-earnings';
import { UNIVERSE, CORE_WATCHLIST } from '../universe';

const daysOut = (n: number) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const U = UNIVERSE.slice(0, 3).map((u) => u.ticker);

beforeEach(() => vi.clearAllMocks());

describe('resolveEarningsScanUniverse — near-term gap repair', () => {
  it('recovers near-term reports the bulk range omits (the live hyperscaler case)', async () => {
    // Bulk range looks healthy but its earliest entry is ~17d out.
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(17) }, { ticker: U[1], date: daysOut(20) }],
    });
    // Per-symbol sees MSFT-style reports 5 days out.
    h.probe.mockImplementation(async (t: string) =>
      t === 'MSFT' ? { ticker: t, date: daysOut(5) } : null,
    );
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).toHaveBeenCalled();
    // Recovered entry present AND the far-dated range entries preserved.
    expect(r.entries.map((e) => e.ticker)).toContain('MSFT');
    expect(r.entries).toHaveLength(3);
    expect(r.warnings.some((w) => /recovered 1 report\(s\) within 10d/.test(w))).toBe(true);
  });

  it('does NOT probe when near-term entries are already present', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(2) }],
    });
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.entries).toHaveLength(1);
  });

  it('NEVER probes when the range call failed — no piling onto a 429 storm', async () => {
    h.range.mockResolvedValue({
      ok: false, httpStatus: 429, rateLimitExhausted: true, entries: [],
    });
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.calendarFailed).toBe(true); // publish guard must still see the failure
    expect(r.warnings.some((w) => /calendar_range_failed/.test(w))).toBe(true);
  });

  it('records an honest warning when neither source has near-term reports', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(20) }],
    });
    h.probe.mockResolvedValue(null);
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(r.entries).toHaveLength(1); // far-dated entries kept
    expect(r.warnings.some((w) => /genuine lull, or gap beyond watchlist coverage/.test(w))).toBe(true);
  });

  it('still probes on a fully empty range response', async () => {
    h.range.mockResolvedValue({ ok: true, httpStatus: 200, rateLimitExhausted: false, entries: [] });
    h.probe.mockImplementation(async (t: string) =>
      t === CORE_WATCHLIST[1] ? { ticker: t, date: daysOut(5) } : null,
    );
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(r.entries.map((e) => e.ticker)).toEqual([CORE_WATCHLIST[1]]);
  });
});
