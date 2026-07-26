// Pins the SEC 8-K Item 2.02 announcement-date resolver.
//
// Ground truth captured from prod 2026-07-24 (MSFT, CIK 0000789019): 8-K
// filings carrying item 2.02 on 2026-04-29, 2026-01-28, 2025-10-29,
// 2025-07-30 — the announcements for fiscal quarters ending 2026-03-31,
// 2025-12-31, 2025-09-30, 2025-06-30 respectively.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  edgarFetch: vi.fn(),
  getCikTickerMap: vi.fn(),
  cacheGet: vi.fn(),
  cacheSet: vi.fn(),
}));

vi.mock('../vector-data', () => ({
  edgarFetch: h.edgarFetch,
  getCikTickerMap: h.getCikTickerMap,
}));
vi.mock('../provider-live-cache', () => ({
  liveCacheGet: h.cacheGet,
  liveCacheSet: h.cacheSet,
}));

import {
  getAnnouncementDates,
  pickAnnouncementForPeriod,
  _resetCikCacheForTests,
} from '../earnings-announce-dates';

// A realistic SEC submissions payload: earnings 8-Ks mixed with other 8-Ks
// (item 5.02 = officer change, 8.01 = other) that must NOT be treated as
// announcements, plus 10-Q rows that must be ignored entirely.
const SUBMISSIONS = {
  filings: {
    recent: {
      form: ['8-K', '10-Q', '8-K', '8-K', '8-K', '10-K'],
      filingDate: ['2026-04-29', '2026-04-30', '2026-03-11', '2026-01-28', '2025-10-29', '2025-08-01'],
      items: ['2.02,9.01', '', '5.02', '2.02,9.01', '2.02,7.01,9.01', ''],
    },
  },
};

const bigCikMap = () => {
  const m = new Map<string, string>();
  for (let i = 0; i < 1100; i++) m.set(String(i).padStart(10, '0'), `T${i}`);
  m.set('0000789019', 'MSFT');
  return m;
};

beforeEach(() => {
  vi.clearAllMocks();
  _resetCikCacheForTests();
  h.cacheGet.mockResolvedValue(null); // cold cache
  h.cacheSet.mockResolvedValue(undefined);
  h.getCikTickerMap.mockResolvedValue(bigCikMap());
  h.edgarFetch.mockResolvedValue({ json: async () => SUBMISSIONS });
});

describe('getAnnouncementDates', () => {
  it('extracts only 8-K filings carrying item 2.02, newest first', async () => {
    const dates = await getAnnouncementDates('MSFT');
    expect(dates).toEqual(['2026-04-29', '2026-01-28', '2025-10-29']);
    // The 5.02 officer-change 8-K and both periodic reports are excluded.
    expect(dates).not.toContain('2026-03-11');
    expect(dates).not.toContain('2026-04-30');
  });

  it('queries the SEC submissions endpoint for the resolved CIK', async () => {
    await getAnnouncementDates('msft');
    expect(h.edgarFetch).toHaveBeenCalledWith(
      'https://data.sec.gov/submissions/CIK0000789019.json',
    );
  });

  it('returns [] for an unknown ticker without calling SEC', async () => {
    const dates = await getAnnouncementDates('NOTREAL');
    expect(dates).toEqual([]);
    expect(h.edgarFetch).not.toHaveBeenCalled();
  });

  it('returns [] when SEC is unreachable — never guesses a date', async () => {
    h.edgarFetch.mockRejectedValue(new Error('EDGAR 403'));
    expect(await getAnnouncementDates('MSFT')).toEqual([]);
  });

  it('serves a cache hit without re-fetching', async () => {
    h.cacheGet.mockResolvedValue(['2026-04-29']);
    expect(await getAnnouncementDates('MSFT')).toEqual(['2026-04-29']);
    expect(h.edgarFetch).not.toHaveBeenCalled();
  });
});

describe('pickAnnouncementForPeriod', () => {
  const ANN = ['2026-04-29', '2026-01-28', '2025-10-29', '2025-07-30'];

  it('maps each fiscal quarter end to its real announcement (the MSFT case)', () => {
    expect(pickAnnouncementForPeriod('2026-03-31', ANN, 120)).toBe('2026-04-29');
    expect(pickAnnouncementForPeriod('2025-12-31', ANN, 120)).toBe('2026-01-28');
    expect(pickAnnouncementForPeriod('2025-09-30', ANN, 120)).toBe('2025-10-29');
    expect(pickAnnouncementForPeriod('2025-06-30', ANN, 120)).toBe('2025-07-30');
  });

  it('takes the EARLIEST qualifying announcement, not a later quarter’s', () => {
    // Every date after 2025-09-30 "follows" it; only the next one is correct.
    expect(pickAnnouncementForPeriod('2025-09-30', ANN, 400)).toBe('2025-10-29');
  });

  it('never returns a date on or before the quarter it would report', () => {
    expect(pickAnnouncementForPeriod('2026-04-29', ANN, 120)).toBeNull();
  });

  it('rejects an implausibly late announcement rather than mis-attributing it', () => {
    expect(pickAnnouncementForPeriod('2024-01-31', ANN, 120)).toBeNull();
  });

  it('returns null when nothing is known — caller leaves the row unresolved', () => {
    expect(pickAnnouncementForPeriod('2026-03-31', [], 120)).toBeNull();
  });
});

// Ordering guarantee relied on by the SEC-authoritative join: when both the
// real announcement and a later date qualify, the real (earliest) one wins.
describe('earliest-qualifying selection', () => {
  it("prefers the true announcement over a later date that also fits the lag", () => {
    expect(pickAnnouncementForPeriod('2026-03-31', ['2026-04-29', '2026-07-29'], 120))
      .toBe('2026-04-29');
  });
});

// ---------------------------------------------------------------------------
// The 32%-coverage bug: a transient SEC failure was being PERSISTED as "this
// ticker has no announcements" for 24h. Measured 2026-07-25 — the first full
// scan resolved 122/376 names while a direct 20-ticker sample showed 19/20
// have 8-K/2.02 available. The data was there; cached failures hid it.
// ---------------------------------------------------------------------------
// loadCikTickerMap also persists (the CIK map), so these assertions must
// isolate writes to the ANNOUNCEMENT key rather than counting all writes.
const announceWrites = () =>
  h.cacheSet.mock.calls.filter((c: any[]) => c[0]?.endpoint === '8k-item-202').length;

describe('never caches a failure', () => {
  it('does NOT persist an empty result when the SEC call threw', async () => {
    h.edgarFetch.mockRejectedValue(new Error('EDGAR 403'));
    expect(await getAnnouncementDates('MSFT')).toEqual([]);
    expect(announceWrites()).toBe(0); // retried next run, not written off
  });

  it('DOES persist a genuine empty (SEC answered, no earnings 8-K)', async () => {
    h.edgarFetch.mockResolvedValue({
      json: async () => ({ filings: { recent: { form: ['10-Q'], filingDate: ['2026-04-30'], items: [''] } } }),
    });
    expect(await getAnnouncementDates('MSFT')).toEqual([]);
    expect(announceWrites()).toBe(1);
  });

  it('persists an unmappable ticker as a stable empty (no CIK is an answer)', async () => {
    await getAnnouncementDates('NOTREAL');
    expect(announceWrites()).toBe(1);
    expect(h.edgarFetch).not.toHaveBeenCalled();
  });

  it('persists a successful lookup', async () => {
    await getAnnouncementDates('MSFT');
    expect(announceWrites()).toBe(1);
  });
});

// Heavy filers overflow filings.recent into filings.files[] shards — JPM
// carries 25,457 recent entries plus 68 shards.
describe('shard paging for heavy filers', () => {
  it('pages into shards when recent yields too few announcements', async () => {
    h.edgarFetch.mockImplementation(async (url: string) => {
      if (url.includes('-submissions-001.json')) {
        return { json: async () => ({
          form: ['8-K', '8-K', '8-K', '8-K'],
          filingDate: ['2025-10-14', '2025-07-15', '2025-04-14', '2025-01-15'],
          items: ['2.02,9.01', '2.02,9.01', '2.02,9.01', '2.02,9.01'],
        }) } as any;
      }
      return { json: async () => ({ filings: {
        recent: { form: ['8-K'], filingDate: ['2026-04-14'], items: ['2.02,9.01'] },
        files: [{ name: 'CIK0000789019-submissions-001.json' }],
      } }) } as any;
    });
    const dates = await getAnnouncementDates('MSFT');
    expect(dates.length).toBeGreaterThanOrEqual(5);
    expect(dates[0]).toBe('2026-04-14'); // newest first across recent + shard
    expect(dates).toContain('2025-01-15');
  });

  it('does NOT page shards when recent already has enough', async () => {
    h.edgarFetch.mockImplementation(async () => ({ json: async () => ({ filings: {
      recent: {
        form: Array(6).fill('8-K'),
        filingDate: ['2026-04-29','2026-01-28','2025-10-29','2025-07-30','2025-04-30','2025-01-29'],
        items: Array(6).fill('2.02,9.01'),
      },
      files: [{ name: 'CIK0000789019-submissions-001.json' }],
    } }) }) as any);
    await getAnnouncementDates('MSFT');
    expect(h.edgarFetch).toHaveBeenCalledTimes(1); // one call — no shard fetch
  });

  it('a failed shard caps history but keeps the primary answer', async () => {
    h.edgarFetch.mockImplementation(async (url: string) => {
      if (url.includes('-submissions-')) throw new Error('shard 500');
      return { json: async () => ({ filings: {
        recent: { form: ['8-K'], filingDate: ['2026-04-29'], items: ['2.02,9.01'] },
        files: [{ name: 'CIK0000789019-submissions-001.json' }],
      } }) } as any;
    });
    expect(await getAnnouncementDates('MSFT')).toEqual(['2026-04-29']);
  });
});
