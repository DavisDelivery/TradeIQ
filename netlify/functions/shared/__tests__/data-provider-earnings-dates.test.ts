// Wave 2C (CR-3 / track-5 #4) — announcement-date semantics for
// getEarningsHistory.
//
// Finnhub's /stock/earnings rows carry `period` = the fiscal quarter END
// (e.g. 2024-03-31), which lags the actual announcement by 2-8 weeks. The
// pre-fix provider exposed `date: r.period` and PIT-filtered on it, so:
//   (a) every reaction-window consumer measured price moves ~a month from
//       the actual print, and
//   (b) a backtest at 2024-04-01 could see a report announced 2024-04-25
//       (period 2024-03-31 <= asOfDate) — look-ahead.
//
// Fix contract under test:
//   - rows carry BOTH `period` and `announceDate` (joined from the
//     earnings calendar, whose `date` IS the announcement date);
//   - the join runs when `withAnnounceDates` is set or asOfDate is given,
//     costing exactly one extra /calendar/earnings call;
//   - PIT visibility filters on announceDate; rows with an unresolved
//     announcement are EXCLUDED (period-end is never a visibility proxy).
//
// Fixtures mirror the realistic ~4-week period→announcement lag.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { getEarningsHistory } from '../data-provider';
import { _resetFinnhubBucketForTests } from '../rate-limiter';

const ORIGINAL_FETCH = globalThis.fetch;

beforeEach(() => {
  process.env.FINNHUB_API_KEY = 'test-finn';
  _resetFinnhubBucketForTests();
});

afterEach(() => {
  globalThis.fetch = ORIGINAL_FETCH;
});

/** Route /stock/earnings and /calendar/earnings to separate payloads. */
function mockFinnhub(handlers: {
  surprises?: unknown;
  calendar?: unknown;
}, observed?: { urls: string[] }) {
  globalThis.fetch = vi.fn(async (input: any) => {
    const url = typeof input === 'string' ? input : input.url;
    observed?.urls.push(url);
    const body = url.includes('/stock/earnings')
      ? handlers.surprises ?? []
      : handlers.calendar ?? { earningsCalendar: [] };
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'application/json' },
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as any;
  });
}

// Q1 2024 ends 2024-03-31, announced 2024-04-25 (~4-week lag) — the exact
// shape of the CR-3 look-ahead window.
const SURPRISES = [
  { symbol: 'NVDA', period: '2024-03-31', actual: 1.1, estimate: 1.05, surprisePercent: 4.7, year: 2024, quarter: 1 },
  { symbol: 'NVDA', period: '2023-12-31', actual: 1.0, estimate: 0.95, surprisePercent: 5.2, year: 2023, quarter: 4 },
  { symbol: 'NVDA', period: '2023-09-30', actual: 0.9, estimate: 0.92, surprisePercent: -2.2, year: 2023, quarter: 3 },
];

const CALENDAR = {
  earningsCalendar: [
    { symbol: 'NVDA', date: '2024-04-25', year: 2024, quarter: 1, epsActual: 1.1, epsEstimate: 1.05 },
    { symbol: 'NVDA', date: '2024-01-29', year: 2023, quarter: 4, epsActual: 1.0, epsEstimate: 0.95 },
    { symbol: 'NVDA', date: '2023-10-27', year: 2023, quarter: 3, epsActual: 0.9, epsEstimate: 0.92 },
  ],
};

describe('getEarningsHistory — announcement-date join', () => {
  it('joins announceDate from the calendar by fiscal (year, quarter)', async () => {
    mockFinnhub({ surprises: SURPRISES, calendar: CALENDAR });
    const rows = await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ period: '2024-03-31', announceDate: '2024-04-25' });
    expect(rows[1]).toMatchObject({ period: '2023-12-31', announceDate: '2024-01-29' });
    expect(rows[2]).toMatchObject({ period: '2023-09-30', announceDate: '2023-10-27' });
  });

  it('falls back to the earliest calendar date within (period, period+120d] when fiscal labels are missing', async () => {
    const noLabels = {
      earningsCalendar: CALENDAR.earningsCalendar.map(({ year: _y, quarter: _q, ...c }) => c),
    };
    const surprisesNoLabels = SURPRISES.map(({ year: _y, quarter: _q, ...s }) => s);
    mockFinnhub({ surprises: surprisesNoLabels, calendar: noLabels });
    const rows = await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(rows.map((r) => r.announceDate)).toEqual(['2024-04-25', '2024-01-29', '2023-10-27']);
  });

  it('leaves announceDate null when the calendar has no plausible row — never falls back to period-end', async () => {
    mockFinnhub({ surprises: SURPRISES, calendar: { earningsCalendar: [] } });
    const rows = await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(rows).toHaveLength(3); // live mode keeps the rows (beats math needs no dates)
    expect(rows.every((r) => r.announceDate === null)).toBe(true);
  });

  it('does not let an older period steal the next quarter print when its own calendar row is missing', async () => {
    // Q1's calendar row is missing. Q2's print (2024-07-25) is within 120d
    // of Q1's period end (2024-03-31) — without dedupe, Q1 would claim it.
    const surprises = [
      { symbol: 'NVDA', period: '2024-06-30', actual: 1.2, estimate: 1.1 },
      { symbol: 'NVDA', period: '2024-03-31', actual: 1.1, estimate: 1.05 },
    ];
    const calendar = { earningsCalendar: [{ symbol: 'NVDA', date: '2024-07-25' }] };
    mockFinnhub({ surprises, calendar });
    const rows = await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(rows[0]).toMatchObject({ period: '2024-06-30', announceDate: '2024-07-25' });
    expect(rows[1]).toMatchObject({ period: '2024-03-31', announceDate: null });
  });

  it('skips the calendar call entirely when neither withAnnounceDates nor asOfDate is set', async () => {
    const observed = { urls: [] as string[] };
    mockFinnhub({ surprises: SURPRISES, calendar: CALENDAR }, observed);
    const rows = await getEarningsHistory('NVDA', 8);
    expect(rows.every((r) => r.announceDate === null)).toBe(true);
    expect(observed.urls.filter((u) => u.includes('/calendar/earnings'))).toHaveLength(0);
  });

  it('adds exactly one calendar call when the join is requested', async () => {
    const observed = { urls: [] as string[] };
    mockFinnhub({ surprises: SURPRISES, calendar: CALENDAR }, observed);
    await getEarningsHistory('NVDA', 8, { withAnnounceDates: true });
    expect(observed.urls.filter((u) => u.includes('/stock/earnings'))).toHaveLength(1);
    expect(observed.urls.filter((u) => u.includes('/calendar/earnings'))).toHaveLength(1);
  });
});

describe('getEarningsHistory — PIT visibility on announceDate (the CR-3 leak)', () => {
  it('EXCLUDES a row whose period precedes asOfDate but whose announcement comes after it', async () => {
    mockFinnhub({ surprises: SURPRISES, calendar: CALENDAR });
    // Backtest at 2024-04-01: Q1 period (2024-03-31) is already past, but
    // the report doesn't hit the tape until 2024-04-25. Pre-fix the
    // `period <= asOfDate` filter leaked it — three weeks of look-ahead.
    const rows = await getEarningsHistory('NVDA', 8, { asOfDate: '2024-04-01' });
    expect(rows.map((r) => r.period)).toEqual(['2023-12-31', '2023-09-30']);
    expect(rows.some((r) => r.period === '2024-03-31')).toBe(false);
  });

  it('includes the row once asOfDate reaches the announcement date', async () => {
    mockFinnhub({ surprises: SURPRISES, calendar: CALENDAR });
    const rows = await getEarningsHistory('NVDA', 8, { asOfDate: '2024-04-25' });
    expect(rows[0]).toMatchObject({ period: '2024-03-31', announceDate: '2024-04-25' });
  });

  it('conservatively excludes rows whose announcement date is unknown', async () => {
    // Calendar covers Q4-2023 only; Q3-2023's announcement is unresolved.
    // Even though its period (2023-09-30) is long before asOfDate, the PIT
    // read must drop it — period-end is not a visibility proxy.
    const calendar = { earningsCalendar: [CALENDAR.earningsCalendar[1]] };
    mockFinnhub({ surprises: SURPRISES, calendar });
    const rows = await getEarningsHistory('NVDA', 8, { asOfDate: '2024-04-01' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ period: '2023-12-31', announceDate: '2024-01-29' });
  });

  it('returns [] under asOfDate when the calendar join fails outright', async () => {
    globalThis.fetch = vi.fn(async (input: any) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/calendar/earnings')) {
        return { ok: false, status: 500, headers: { get: () => '' }, json: async () => ({}), text: async () => 'err' } as any;
      }
      return { ok: true, status: 200, headers: { get: () => '' }, json: async () => SURPRISES, text: async () => '[]' } as any;
    });
    const rows = await getEarningsHistory('NVDA', 8, { asOfDate: '2024-06-01' });
    expect(rows).toEqual([]);
  });
});
