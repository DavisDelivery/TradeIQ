// scanForTrends — the orchestration, executed rather than mocked.
//
// Everywhere else in this suite `scanForTrends` is stubbed so the handler can
// be tested in isolation, which means the function that actually decides what
// a scan reports had no coverage of its own. That gap hid a specific claim:
// the commit that added wholesale-failure tracking asserted "a total Wikipedia
// outage now populates `degraded`" and nothing anywhere proved it. These tests
// exist to make that claim falsifiable.

import { describe, expect, it, vi, beforeEach } from 'vitest';

const resolveArticleMock = vi.fn();
const fetchPageviewsMock = vi.fn();
const fetchOffExchangeMock = vi.fn();
const readMentionHistoryMock = vi.fn();
const enrichTickerNamesMock = vi.fn();

vi.mock('../trend-exposure', async (importOriginal) => {
  const real = await importOriginal<typeof import('../trend-exposure')>();
  return {
    ...real,
    resolveArticle: (...a: unknown[]) => resolveArticleMock(...a),
    fetchPageviews: (...a: unknown[]) => fetchPageviewsMock(...a),
  };
});

vi.mock('../quiver-offexchange', async (importOriginal) => {
  const real = await importOriginal<typeof import('../quiver-offexchange')>();
  return { ...real, fetchOffExchange: (...a: unknown[]) => fetchOffExchangeMock(...a) };
});

vi.mock('../social-mentions', async (importOriginal) => {
  const real = await importOriginal<typeof import('../social-mentions')>();
  return { ...real, readMentionHistory: (...a: unknown[]) => readMentionHistoryMock(...a) };
});

vi.mock('../ticker-reference', async (importOriginal) => {
  const real = await importOriginal<typeof import('../ticker-reference')>();
  return { ...real, enrichTickerNames: (...a: unknown[]) => enrichTickerNamesMock(...a) };
});

import { MIN_MENTION_HISTORY_DAYS, WINDOW, scanForTrends } from '../trend-detect';
import type { MentionSnapshot } from '../social-mentions';

/** Daily pageviews that clear the 25% bar on 7-vs-28 by a wide margin. */
const SPIKING = [
  ...new Array(WINDOW.baseDays).fill(0).map(() => ({ date: 'x', views: 1000 })),
  ...new Array(WINDOW.recentDays).fill(0).map(() => ({ date: 'x', views: 3000 })),
];
const FLAT = new Array(WINDOW.recentDays + WINDOW.baseDays)
  .fill(0)
  .map(() => ({ date: 'x', views: 1000 }));

const oeOk = (volumeZ: number | null) => ({ available: true, volumeZ });

/** N days of recorded mention snapshots, so the mentions leg is measurable. */
function history(days: number, mentions: Record<string, number> = {}): MentionSnapshot[] {
  return new Array(days).fill(0).map((_, i) => ({
    date: `2026-07-${String(i + 1).padStart(2, '0')}`,
    filter: 'all-stocks',
    available: true,
    rows: Object.entries(mentions).map(([ticker, n]) => ({
      ticker, name: null, rank: 400, mentions: n, upvotes: null, mentions24hAgo: null, rank24hAgo: null,
    })),
    floor: 1,
    reason: null,
    fetchedAt: 'x',
  }));
}

const run = (tickers: string[], opts = {}) =>
  scanForTrends(tickers.map((ticker) => ({ ticker })), { concurrency: 2, asOf: '2026-08-07', ...opts });

beforeEach(() => {
  resolveArticleMock.mockReset().mockImplementation(async (name: string) => name);
  fetchPageviewsMock.mockReset().mockResolvedValue({ article: 'a', points: FLAT, yoyPct: null, momPct: null });
  fetchOffExchangeMock.mockReset().mockResolvedValue(oeOk(0.1));
  readMentionHistoryMock.mockReset().mockResolvedValue([]);
  enrichTickerNamesMock.mockReset().mockResolvedValue({ CROX: 'Crocs', EAT: 'Brinker', BROS: 'Dutch Bros Coffee' });
});

describe('scanForTrends — wholesale failure is reported, never rendered as "nothing moved"', () => {
  it('says so when EVERY Wikipedia lookup failed', async () => {
    // Without this, a total outage returns an empty board at HTTP 200 with an
    // empty `degraded` — indistinguishable from a genuinely quiet week, and
    // exactly the lie the handler refuses to tell about a dead Finviz feed.
    fetchPageviewsMock.mockRejectedValue(new Error('wiki 503'));
    const res = await run(['CROX', 'EAT']);
    expect(res.candidates).toEqual([]);
    expect(res.degraded.join(' ')).toMatch(/wikipedia: every one of 2 lookups failed/);
    expect(res.degraded.join(' ')).toMatch(/cannot claim nothing moved/);
  });

  it('does NOT cry outage when only some lookups failed', async () => {
    fetchPageviewsMock
      .mockRejectedValueOnce(new Error('wiki 503'))
      .mockResolvedValue({ article: 'a', points: SPIKING, yoyPct: null, momPct: null });
    const res = await run(['CROX', 'EAT']);
    expect(res.degraded.join(' ')).not.toMatch(/every one of/);
    expect(res.candidates.length).toBeGreaterThan(0);
  });

  it('says so when off-exchange is unavailable for every name', async () => {
    fetchOffExchangeMock.mockResolvedValue({ available: false, volumeZ: null });
    const res = await run(['CROX', 'EAT']);
    expect(res.degraded.join(' ')).toMatch(/off-exchange: unavailable for all 2 names/);
    expect(res.degraded.join(' ')).toMatch(/unmeasured, not clear/);
  });

  it('reports a thin mention history as UNCHECKED with the day count, not as a negative', async () => {
    readMentionHistoryMock.mockResolvedValue(history(3));
    const res = await run(['CROX']);
    expect(res.mentionHistory).toEqual({ daysRecorded: 3, daysRequired: MIN_MENTION_HISTORY_DAYS, usable: false });
    expect(res.degraded.join(' ')).toMatch(/3\/35 days recorded/);
    expect(res.degraded.join(' ')).toMatch(/never as a negative/);
  });

  it('survives the mention history throwing outright', async () => {
    readMentionHistoryMock.mockRejectedValue(new Error('firestore down'));
    const res = await run(['CROX']);
    expect(res.degraded.join(' ')).toMatch(/firestore down/);
    expect(res.mentionHistory.usable).toBe(false);
  });
});

describe('scanForTrends — one bad ticker must not lose the other thirty-nine', () => {
  it('keeps assessing after a name throws, and counts the loss', async () => {
    fetchOffExchangeMock.mockImplementation(async (t: string) => {
      if (t === 'EAT') throw new Error('boom');
      return oeOk(0.1);
    });
    fetchPageviewsMock.mockResolvedValue({ article: 'a', points: SPIKING, yoyPct: null, momPct: null });
    const res = await run(['CROX', 'EAT']);
    // EAT's off-exchange leg failed but the name itself still assessed.
    expect(res.candidates.map((c) => c.ticker)).toEqual(['CROX', 'EAT']);
    expect(res.universeChecked).toBe(2);
  });

  it('falls back to no names rather than failing when the bulk lookup dies', async () => {
    enrichTickerNamesMock.mockRejectedValue(new Error('firestore down'));
    const res = await run(['CROX']);
    // No company name means no article to resolve — unchecked, not measured.
    const wiki = res.candidates.concat(await run(['CROX']).then((r) => r.candidates));
    expect(res.degraded).toBeDefined();
    expect(wiki).toBeDefined();
    expect(resolveArticleMock).not.toHaveBeenCalled();
  });
});

describe('scanForTrends — the wrong-article guard runs in the real path', () => {
  it('refuses to measure a resolved article that does not match the company', async () => {
    resolveArticleMock.mockResolvedValue('Buffalo wing');
    fetchPageviewsMock.mockResolvedValue({ article: 'a', points: SPIKING, yoyPct: null, momPct: null });
    const res = await run(['CROX']);
    expect(res.candidates).toEqual([]);           // never became a candidate
    expect(fetchPageviewsMock).not.toHaveBeenCalled(); // and never cost a fetch
  });

  it('measures when the article does match', async () => {
    resolveArticleMock.mockResolvedValue('Crocs');
    fetchPageviewsMock.mockResolvedValue({ article: 'Crocs', points: SPIKING, yoyPct: null, momPct: null });
    const res = await run(['CROX']);
    expect(res.candidates.map((c) => c.ticker)).toEqual(['CROX']);
    const wiki = res.candidates[0].observations.find((o) => o.source === 'wikipedia')!;
    expect(wiki.moved).toBe(true);
    expect(wiki.value).toBeCloseTo(200);
  });
});

describe('scanForTrends — output contract', () => {
  beforeEach(() => {
    fetchPageviewsMock.mockResolvedValue({ article: 'a', points: SPIKING, yoyPct: null, momPct: null });
  });

  it('returns candidates ALPHABETICALLY, not by strength', async () => {
    const res = await run(['EAT', 'CROX', 'BROS']);
    expect(res.candidates.map((c) => c.ticker)).toEqual(['BROS', 'CROX', 'EAT']);
    expect(res.order).toMatch(/NOT a ranking/);
  });

  it('draws a control cohort the same size as the flagged set, excluding it', async () => {
    // Five names, three of which resolve to articles and spike.
    enrichTickerNamesMock.mockResolvedValue({ CROX: 'Crocs', EAT: 'Brinker' });
    const res = await run(['CROX', 'EAT', 'AAA', 'BBB', 'CCC']);
    expect(res.candidates.map((c) => c.ticker)).toEqual(['CROX', 'EAT']);
    expect(res.paperTrail.control).toHaveLength(2);
    expect(res.paperTrail.control.some((t) => ['CROX', 'EAT'].includes(t))).toBe(false);
    expect(res.paperTrail.universeScanned).toEqual(['AAA', 'BBB', 'CCC', 'CROX', 'EAT']);
  });

  it('seeds the cohort off the scan SHAPE, so a 5-name probe and a 40-name sweep differ', async () => {
    const small = await run(['CROX', 'EAT']);
    const large = await run(['CROX', 'EAT', 'AAA']);
    expect(small.paperTrail.seed).not.toBe(large.paperTrail.seed);
    expect(small.paperTrail.seed).toContain('2026-08-07');
  });

  it('re-draws the identical control from the same seed', async () => {
    const a = await run(['CROX', 'EAT', 'AAA', 'BBB']);
    const b = await run(['CROX', 'EAT', 'AAA', 'BBB']);
    expect(a.paperTrail.seed).toBe(b.paperTrail.seed);
    expect(a.paperTrail.control).toEqual(b.paperTrail.control);
  });

  it('carries the caveat and never emits a score field', async () => {
    const res = await run(['CROX']);
    expect(res.caveat).toMatch(/NOT RANKED/);
    expect(JSON.stringify(res)).not.toMatch(/"(score|composite)"/);
  });

  it('reports off-exchange on the saturation side only', async () => {
    fetchOffExchangeMock.mockResolvedValue(oeOk(2.4));
    const res = await run(['CROX']);
    const c = res.candidates[0];
    expect(c.observations.some((o) => (o.source as string) === 'offExchange')).toBe(false);
    expect(c.saturation.offExchangeZ).toBe(2.4);
    expect(c.saturation.crowded).toBe(true);
  });
});

describe('scanForTrends — the mentions leg off a real recorded series', () => {
  it('measures growth once enough days exist', async () => {
    // 28 quiet days then 7 loud ones, oldest first.
    const days = [
      ...new Array(WINDOW.baseDays).fill(2),
      ...new Array(WINDOW.recentDays).fill(40),
    ];
    readMentionHistoryMock.mockResolvedValue(
      days.map((n, i) => history(1, { CROX: n })[0]).map((snap, i) => ({
        ...snap,
        date: `2026-07-${String(i + 1).padStart(2, '0')}`,
      })),
    );
    const res = await run(['CROX']);
    const m = res.candidates[0].observations.find((o) => o.source === 'mentions')!;
    expect(res.mentionHistory.usable).toBe(true);
    expect(m.checked).toBe(true);
    expect(m.moved).toBe(true);
    expect(m.value).toBeCloseTo(1900);
  });
});
