import { describe, expect, it, vi } from 'vitest';
import {
  MIN_REVIEWS,
  REVIEWS_CAVEAT,
  WINDOW_DAYS,
  computeVelocity,
  fetchReviewVelocity,
  parseReviewEntries,
  type ReviewPoint,
} from '../app-reviews';

const ASOF = '2026-08-04';
const back = (d: number) => new Date(Date.parse(ASOF) - d * 86_400_000).toISOString().slice(0, 10);

/** n reviews evenly spread from `fromDay` to `toDay` days before ASOF. */
function spread(n: number, fromDay: number, toDay: number, rating = 4, version = '1.0'): ReviewPoint[] {
  const out: ReviewPoint[] = [];
  for (let i = 0; i < n; i++) {
    const d = fromDay + ((toDay - fromDay) * i) / Math.max(1, n - 1);
    out.push({ date: back(Math.round(d)), rating, version });
  }
  return out;
}

describe('parseReviewEntries', () => {
  it('parses the live Apple entry shape', () => {
    const r = parseReviewEntries({
      feed: {
        entry: [
          { 'im:rating': { label: '1' }, updated: { label: '2026-07-31T19:44:37-07:00' }, 'im:version': { label: '2026.7.0' } },
        ],
      },
    });
    expect(r).toEqual([{ date: '2026-07-31', rating: 1, version: '2026.7.0' }]);
  });

  // Entry 0 of Apple's feed is the APP, not a review. It has no im:rating.
  it('DROPS the app entry so it is not counted as a phantom review', () => {
    const r = parseReviewEntries({
      feed: {
        entry: [
          { 'im:name': { label: 'Wingstop' }, updated: { label: '2026-07-01T00:00:00Z' } },
          { 'im:rating': { label: '5' }, updated: { label: '2026-07-02T00:00:00Z' } },
        ],
      },
    });
    expect(r).toHaveLength(1);
    expect(r[0].rating).toBe(5);
  });

  it('handles a single-entry feed served as an object, not an array', () => {
    const r = parseReviewEntries({ feed: { entry: { 'im:rating': { label: '3' }, updated: { label: '2026-07-02T00:00:00Z' } } } });
    expect(r).toHaveLength(1);
  });

  it('returns [] for an empty or malformed feed', () => {
    expect(parseReviewEntries({ feed: {} })).toEqual([]);
    expect(parseReviewEntries(null)).toEqual([]);
  });
});

describe('computeVelocity', () => {
  it('refuses to report a rate on too few reviews', () => {
    const v = computeVelocity(1, spread(MIN_REVIEWS - 1, 1, 40), ASOF);
    expect(v.available).toBe(false);
    expect(v.recentPerDay).toBeNull();
  });

  it('computes recent vs prior when the feed covers both windows', () => {
    // 56 recent + 28 prior over a span reaching past 2*WINDOW_DAYS.
    const reviews = [...spread(56, 1, 27), ...spread(28, 29, 55), ...spread(2, 58, 60)];
    const v = computeVelocity(1, reviews, ASOF);
    expect(v.available).toBe(true);
    expect(v.truncated).toBe(false);
    expect(v.recentPerDay).toBeCloseTo(2, 1);
    expect(v.priorPerDay).toBeCloseTo(1, 1);
    expect(v.velocityPct).toBeCloseTo(100, 0);
  });

  // The censoring hazard. Dutch Bros produced exactly this live: 200 reviews
  // in 34 days, so the prior window was never observed.
  it('reports NO comparison when the feed never reached the prior window', () => {
    const v = computeVelocity(1, spread(200, 0, 34), ASOF);
    expect(v.available).toBe(true);
    expect(v.truncated).toBe(true);
    expect(v.priorPerDay).toBeNull();
    expect(v.velocityPct).toBeNull();          // NOT a fabricated collapse
    expect(v.recentPerDay).toBeGreaterThan(0); // the rate itself is still valid
    expect(v.reason).toMatch(/not enough to compare/);
  });

  it('a truncated feed never reports a fall in demand that is really truncation', () => {
    // A hot app: all 200 reviews inside the recent window, none before.
    const v = computeVelocity(1, spread(200, 0, 20), ASOF);
    expect(v.velocityPct).toBeNull();
  });

  it('nulls velocity when the prior window is genuinely empty (divide by zero)', () => {
    const reviews = [...spread(30, 1, 27), ...spread(5, 57, 70)];
    const v = computeVelocity(1, reviews, ASOF);
    expect(v.truncated).toBe(false);   // span DOES reach past the prior window
    expect(v.priorPerDay).toBe(0);     // but nothing landed in it
    expect(v.velocityPct).toBeNull();  // so no ratio
  });

  it('counts distinct versions in the recent window — a release inflates the rate', () => {
    const reviews = [
      ...spread(20, 1, 13, 4, '2.0'),
      ...spread(20, 14, 27, 4, '1.9'),
      ...spread(20, 29, 55, 4, '1.8'),
    ];
    expect(computeVelocity(1, reviews, ASOF).versionsInWindow).toBe(2);
  });

  it('reports recent and prior star means separately', () => {
    const reviews = [...spread(30, 1, 27, 2), ...spread(30, 29, 55, 5)];
    const v = computeVelocity(1, reviews, ASOF);
    expect(v.recentRating).toBeCloseTo(2, 1);
    expect(v.priorRating).toBeCloseTo(5, 1);
  });

  it('measures spanDays from the data, never assumes it', () => {
    const v = computeVelocity(1, spread(60, 2, 90), ASOF);
    expect(v.spanDays).toBeGreaterThan(80);
    expect(v.newestReview).toBe(back(2));
    expect(v.oldestReview).toBe(back(90));
  });

  it('always carries the caveat, including the not-comparable-to-lifetime warning', () => {
    expect(REVIEWS_CAVEAT).toMatch(/NOT comparable to the lifetime average/i);
    expect(REVIEWS_CAVEAT).toMatch(/skews negative/i);
    expect(computeVelocity(1, [], ASOF).caveat).toBe(REVIEWS_CAVEAT);
  });

  it('uses a 28-day window', () => {
    expect(WINDOW_DAYS).toBe(28);
  });
});

describe('fetchReviewVelocity', () => {
  const pageBody = (points: ReviewPoint[]) => ({
    feed: {
      entry: points.map((p) => ({
        'im:rating': { label: String(p.rating) },
        updated: { label: `${p.date}T12:00:00Z` },
        'im:version': { label: p.version },
      })),
    },
  });
  const res = (b: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(b) }) as any;

  it('stops paging as soon as the span covers both windows', async () => {
    const f = vi.fn(async () => res(pageBody(spread(50, 1, 70))));
    await fetchReviewVelocity(1, { fetchImpl: f as any, asOf: ASOF });
    // One page already reaches back 70 days > 2*28, so no second request.
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('keeps paging while the span is still short', async () => {
    const f = vi.fn(async () => res(pageBody(spread(50, 1, 10))));
    await fetchReviewVelocity(1, { fetchImpl: f as any, asOf: ASOF, maxPages: 3 });
    expect(f).toHaveBeenCalledTimes(3);
  });

  it('returns a reason, not a throw, on a first-page failure', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 404, text: async () => '' }) as any);
    const v = await fetchReviewVelocity(1, { fetchImpl: f as any, asOf: ASOF });
    expect(v.available).toBe(false);
    expect(v.reason).toMatch(/404/);
  });

  it('keeps a partial walk when a LATER page fails', async () => {
    let n = 0;
    const f = vi.fn(async () => {
      n++;
      if (n === 1) return res(pageBody(spread(50, 1, 20)));
      return { ok: false, status: 500, text: async () => '' } as any;
    });
    const v = await fetchReviewVelocity(1, { fetchImpl: f as any, asOf: ASOF, maxPages: 4 });
    expect(v.available).toBe(true);
    expect(v.count).toBe(50);
  });

  it('is unavailable — never a silent zero — when the app has no reviews', async () => {
    const f = vi.fn(async () => res({ feed: {} }));
    const v = await fetchReviewVelocity(1, { fetchImpl: f as any, asOf: ASOF });
    expect(v.available).toBe(false);
    expect(v.recentPerDay).toBeNull();
    expect(v.reason).toMatch(/no reviews/);
  });
});
