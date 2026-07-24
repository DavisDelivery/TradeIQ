// Pins the near-term calendar-gate fallback (audit 2026-07-24): Finnhub's
// bulk range call can return a NON-EMPTY response whose entries all sit
// weeks out (near-term season gated by plan) — the probe must fire on
// "no near-term entries", not only on "empty response", and MERGE.

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
// Use real universe tickers so the range entries survive the UNIVERSE filter.
const U = UNIVERSE.slice(0, 3).map((u) => u.ticker);

beforeEach(() => vi.clearAllMocks());

describe('resolveEarningsScanUniverse — near-term gate fallback', () => {
  it('does NOT probe when the range already has near-term entries', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(3) }, { ticker: U[1], date: daysOut(20) }],
    });
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).not.toHaveBeenCalled();
    expect(r.entries).toHaveLength(2);
    expect(r.calendarFailed).toBe(false);
  });

  it('probes and MERGES when all range entries sit beyond the near-term window', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(20) }, { ticker: U[1], date: daysOut(25) }],
    });
    h.probe.mockImplementation(async (t: string) =>
      t === CORE_WATCHLIST[0] ? { ticker: t, date: daysOut(2) } : null,
    );
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(h.probe).toHaveBeenCalled();
    // Probe result merged IN FRONT of (not replacing) the far-out entries.
    expect(r.entries.map((e) => e.ticker)).toContain(CORE_WATCHLIST[0]);
    expect(r.entries.length).toBe(3);
    expect(r.warnings.some((w) => /supplemented 1 via watchlist probe/.test(w))).toBe(true);
  });

  it('flags the plan gate when the probe also finds nothing near-term', async () => {
    h.range.mockResolvedValue({
      ok: true, httpStatus: 200, rateLimitExhausted: false,
      entries: [{ ticker: U[0], date: daysOut(20) }],
    });
    h.probe.mockResolvedValue(null);
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(r.entries).toHaveLength(1); // far-out entries kept
    expect(r.warnings.some((w) => /near-term earnings calendar unavailable/.test(w))).toBe(true);
  });

  it('still probes on a fully empty range response (original behavior)', async () => {
    h.range.mockResolvedValue({ ok: true, httpStatus: 200, rateLimitExhausted: false, entries: [] });
    h.probe.mockImplementation(async (t: string) =>
      t === CORE_WATCHLIST[1] ? { ticker: t, date: daysOut(5) } : null,
    );
    const r = await resolveEarningsScanUniverse({ windowDays: 30 });
    expect(r.entries.map((e) => e.ticker)).toEqual([CORE_WATCHLIST[1]]);
  });
});
