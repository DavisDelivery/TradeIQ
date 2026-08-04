import { describe, expect, it, vi } from 'vitest';
import { APP_RATINGS_CAVEAT, fetchAppRating, parseItunes, scoreMatch, searchTerm } from '../app-ratings';

// Field shapes verified live against itunes.apple.com 2026-08-04.
const CROCS = {
  trackId: 1097106160, trackName: 'Crocs', sellerName: 'Crocs Inc',
  averageUserRating: 4.73024, userRatingCount: 46441,
  averageUserRatingForCurrentVersion: 4.73024, userRatingCountForCurrentVersion: 46441,
  currentVersionReleaseDate: '2026-06-22T18:04:12Z',
};
const CHEWY = {
  trackId: 100, trackName: 'Chewy - Pet Care & Pharmacy', sellerName: 'Chewy, Inc.',
  averageUserRating: 4.91258, userRatingCount: 1054643,
  averageUserRatingForCurrentVersion: 4.9, userRatingCountForCurrentVersion: 12000,
  currentVersionReleaseDate: '2026-07-30T10:00:00Z',
};

const res = (body: any) => ({ ok: true, status: 200, text: async () => JSON.stringify(body) }) as any;

describe('scoreMatch', () => {
  it('HIGH when the app name is the company name', () => {
    expect(scoreMatch('Crocs Inc', 'Crocs', 'Crocs Inc')).toBe('HIGH');
  });

  it('HIGH for a real app with a descriptive suffix', () => {
    expect(scoreMatch('Chewy Inc', 'Chewy - Pet Care & Pharmacy', 'Chewy, Inc.')).toBe('HIGH');
  });

  it('strips corporate suffixes before comparing', () => {
    expect(scoreMatch('Deckers Outdoor Corporation', 'Deckers', 'Deckers')).toBe('HIGH');
  });

  it('NONE for an unrelated app — a wrong match is worse than no match', () => {
    expect(scoreMatch('Crocs Inc', 'Farm Simulator 22', 'Some Studio')).toBe('NONE');
  });

  it('LOW, not HIGH, for a merely-contains match', () => {
    expect(scoreMatch('Yeti Holdings', 'Yetimania Adventure Quest', 'Indie Games')).toBe('LOW');
  });
});

// Measured, not assumed: searching "Dutch Bros Inc" put "Dutch Bros U"
// (67 ratings) in the top five and pushed the real app (862,554 ratings)
// out of it entirely.
describe('searchTerm', () => {
  it('strips the legal suffix that demotes the real app', () => {
    expect(searchTerm('Dutch Bros Inc')).toBe('Dutch Bros');
    expect(searchTerm('Celsius Holdings')).toBe('Celsius');
    expect(searchTerm('CAVA Group')).toBe('CAVA');
    expect(searchTerm('Deckers Outdoor Corporation')).toBe('Deckers Outdoor');
  });

  it('leaves a name with no suffix alone', () => {
    expect(searchTerm('Texas Roadhouse')).toBe('Texas Roadhouse');
    expect(searchTerm('e.l.f. Beauty')).toBe('e.l.f. Beauty');
  });

  it('never returns empty — a name that is ONLY a suffix falls back', () => {
    expect(searchTerm('Holdings')).toBe('Holdings');
  });
});

describe('parseItunes', () => {
  it('extracts the ratings fields and the version-reset date', () => {
    const a = parseItunes({ resultCount: 1, results: [CROCS] }, 'Crocs Inc');
    expect(a.available).toBe(true);
    expect(a.appId).toBe(1097106160);
    expect(a.rating).toBeCloseTo(4.73, 2);
    expect(a.ratingCount).toBe(46441);
    // Required to interpret the current-version numbers at all.
    expect(a.currentVersionReleaseDate).toBe('2026-06-22');
    expect(a.matchConfidence).toBe('HIGH');
  });

  it('REFUSES to attribute a stranger app to the ticker', () => {
    const a = parseItunes({ resultCount: 1, results: [{ trackName: 'Farm Simulator 22', sellerName: 'Studio', userRatingCount: 9e6 }] }, 'Crocs Inc');
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/none matched/);
    expect(a.appId).toBeNull();
  });

  it('prefers a HIGH match over a far more popular LOW one', () => {
    const popular = { trackName: 'Crocs Wallpapers HD', sellerName: 'Wallpaper Co', trackId: 9, userRatingCount: 5_000_000 };
    const a = parseItunes({ results: [popular, CROCS] }, 'Crocs Inc');
    expect(a.appId).toBe(CROCS.trackId);
    expect(a.matchConfidence).toBe('HIGH');
  });

  it('flags a LOW match rather than using it silently', () => {
    const a = parseItunes({ results: [{ trackName: 'Yetimania Quest', sellerName: 'Indie', trackId: 3, userRatingCount: 10 }] }, 'Yeti Holdings');
    expect(a.available).toBe(true);
    expect(a.matchConfidence).toBe('LOW');
    expect(a.reason).toMatch(/weak name match/i);
  });

  it('is unavailable, with a reason, when there is no app at all', () => {
    const a = parseItunes({ resultCount: 0, results: [] }, 'Some Holding Co');
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/no iOS app found/);
  });

  it('nulls missing numerics rather than zeroing them', () => {
    const a = parseItunes({ results: [{ ...CROCS, userRatingCount: 5, averageUserRating: null }] }, 'Crocs Inc');
    expect(a.rating).toBeNull();
    expect(a.ratingCount).toBe(5);
  });

  // The backstop for common-word brand names. "Celsius Holdings" really does
  // resolve to an app named exactly "Celsius" with zero ratings.
  it('refuses a zero-rating app even on an EXACT name match', () => {
    const a = parseItunes({ results: [{ trackId: 7, trackName: 'Celsius', sellerName: 'Someone Else', userRatingCount: 0, averageUserRating: 0 }] }, 'Celsius Holdings');
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/no ratings/);
    expect(a.reason).toMatch(/different product/);
  });

  it('refuses when the rating count is missing entirely', () => {
    const a = parseItunes({ results: [{ trackId: 7, trackName: 'Crocs', sellerName: 'Crocs Inc' }] }, 'Crocs Inc');
    expect(a.available).toBe(false);
  });

  it('keeps the current-version split distinct from the lifetime count', () => {
    const a = parseItunes({ results: [CHEWY] }, 'Chewy Inc');
    expect(a.ratingCount).toBe(1054643);
    expect(a.ratingCountCurrentVersion).toBe(12000);
  });

  it('always carries the caveat naming the cumulative-count trap', () => {
    expect(APP_RATINGS_CAVEAT).toMatch(/lifetime cumulative/i);
    expect(APP_RATINGS_CAVEAT).toMatch(/resets on every release/i);
    expect(parseItunes({ results: [] }, 'x').caveat).toBe(APP_RATINGS_CAVEAT);
  });
});

describe('fetchAppRating', () => {
  it('parses a text/javascript body — Apple does not send application/json', async () => {
    const f = vi.fn(async () => res({ resultCount: 1, results: [CROCS] }));
    const a = await fetchAppRating('Crocs Inc', { fetchImpl: f as any });
    expect(a.available).toBe(true);
    expect(a.appName).toBe('Crocs');
  });

  it('searches software in the US store', async () => {
    const f = vi.fn(async () => res({ results: [CROCS] }));
    await fetchAppRating('Crocs Inc', { fetchImpl: f as any });
    const url = String((f.mock.calls as any[])[0][0]);
    expect(url).toContain('entity=software');
    expect(url).toContain('country=US');
  });

  it('returns a reason, not a throw, on a transport failure', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 429, text: async () => '' }) as any);
    const a = await fetchAppRating('Crocs Inc', { fetchImpl: f as any });
    expect(a.available).toBe(false);
    expect(a.reason).toMatch(/429/);
  });

  it('refuses an empty company name instead of searching for nothing', async () => {
    const f = vi.fn();
    const a = await fetchAppRating('   ', { fetchImpl: f as any });
    expect(a.available).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
});
