// Pins the earnings calendar-resolution contract.
//
// History (2026-07-24): a near-term-gap trigger was briefly added here on the
// theory that a non-empty range response with nothing inside ~10 days meant a
// plan gate. Measurement disproved it — the calendar was complete and the
// market was in an earnings LULL (nothing for 17 days, 104 setups at 30).
// Probing on that condition fired 33 unthrottled Finnhub calls every run and
// caused a 429 that tripped the publish guard. These tests pin the reverted
// contract so the mistake can't be re-introduced silently.

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

describe('resolveEarningsScanUniverse', () => {
  it('does NOT probe during an earnings lull — a far-dated calendar is still a VALID calendar', async () => {
    // The exact live shape that caused the misdiagnosis: a healthy response
    // whose earliest report is ~17 days out. Probing here is wasted quota.
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(17) }, { ticker: U[1], date: daysOut(20) }],
    });
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.entries).toHaveLength(2);
    expect(r.calendarFailed).toBe(false);
  });

  it('does not probe when near-term entries exist', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(2) }],
    });
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.entries).toHaveLength(1);
  });

  it('probes ONLY on a genuinely empty range response', async () => {
    h.range.mockResolvedValue({ ok: true, httpStatus: 200, rateLimitExhausted: false, entries: [] });
    h.probe.mockImplementation(async (t: string) =>
      t === CORE_WATCHLIST[1] ? { ticker: t, date: daysOut(5) } : null,
    );
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).toHaveBeenCalled();
    expect(r.entries.map((e) => e.ticker)).toEqual([CORE_WATCHLIST[1]]);
  });

  it('reports calendarFailed when the range call errors and the probe finds nothing (publish guard input)', async () => {
    h.range.mockResolvedValue({
      ok: false, httpStatus: 429, rateLimitExhausted: true, entries: [],
    });
    h.probe.mockResolvedValue(null);
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(r.calendarFailed).toBe(true);
    expect(r.entries).toHaveLength(0);
    expect(r.warnings.some((w) => /calendar_range_failed/.test(w))).toBe(true);
  });
});
