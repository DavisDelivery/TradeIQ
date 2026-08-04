import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AMBIGUOUS, fetchRedditMentions, tickersInText } from '../reddit-mentions';
import { __resetTokenCache, getAccessToken, redditConfigured, redditGet } from '../reddit-client';

const KNOWN = new Set(['GME', 'CROX', 'TSLA', 'BROS', 'IT', 'ON', 'DD', 'AI', 'F', 'CELH']);

const OLD_ENV = { ...process.env };
beforeEach(() => {
  __resetTokenCache();
  process.env.REDDIT_CLIENT_ID = 'id';
  process.env.REDDIT_CLIENT_SECRET = 'secret';
});
afterEach(() => { process.env = { ...OLD_ENV }; __resetTokenCache(); });

// Counting tickers in free text is where this goes wrong, not the HTTP.
describe('tickersInText', () => {
  it('counts a plain all-caps ticker', () => {
    expect([...tickersInText('bought GME today', KNOWN)]).toEqual(['GME']);
  });

  it('counts a cashtag', () => {
    expect([...tickersInText('loading up on $CROX', KNOWN)]).toEqual(['CROX']);
  });

  it('REFUSES bare English words that are also tickers', () => {
    // "IT" and "ON" are real symbols. Counting them bare turns the board
    // into a word-frequency table.
    const t = tickersInText('I put IT ON the line and DD says so', KNOWN);
    expect(t.has('IT')).toBe(false);
    expect(t.has('ON')).toBe(false);
    expect(t.has('DD')).toBe(false);
  });

  it('DOES count an ambiguous symbol when cashtagged — the $ disambiguates', () => {
    expect(tickersInText('$IT is my play', KNOWN).has('IT')).toBe(true);
  });

  it('skips subreddit jargon', () => {
    for (const w of ['YOLO', 'ATH', 'CEO', 'IPO', 'WSB', 'TLDR']) {
      expect(AMBIGUOUS.has(w), w).toBe(true);
      expect(tickersInText(`big ${w} energy`, KNOWN).size).toBe(0);
    }
  });

  it('does not match a ticker embedded in a longer word', () => {
    expect(tickersInText('GMEDIA and XGMEX', KNOWN).size).toBe(0);
  });

  it('restricts to the known universe when one is supplied', () => {
    expect(tickersInText('ZZZZ QQQQ are ripping', KNOWN).size).toBe(0);
  });

  it('returns DISTINCT tickers — one ranting post is one mention', () => {
    const t = tickersInText('GME GME GME to the moon GME', KNOWN);
    expect(t.size).toBe(1);
  });

  it('refuses a bare single letter, even a real one-letter ticker', () => {
    // F is Ford. Bare "F" in prose is almost never Ford.
    expect(tickersInText('F that noise', KNOWN).has('F')).toBe(false);
    expect(tickersInText('$F calls', KNOWN).has('F')).toBe(true);
  });

  it('handles empty and junk input without throwing', () => {
    expect(tickersInText('', KNOWN).size).toBe(0);
    expect(tickersInText('....!!! $$$ ', KNOWN).size).toBe(0);
  });
});

describe('reddit-client configuration', () => {
  it('is not configured when env vars are absent', () => {
    delete process.env.REDDIT_CLIENT_ID;
    expect(redditConfigured()).toBe(false);
  });

  it('throws a NAMED error, not a generic one, when unconfigured', async () => {
    delete process.env.REDDIT_CLIENT_SECRET;
    await expect(getAccessToken()).rejects.toThrow(/REDDIT_CLIENT_ID/);
  });

  it('authenticates with HTTP Basic and client_credentials', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }) as any);
    const tok = await getAccessToken({ fetchImpl: f as any });
    expect(tok).toBe('t');
    const [, init] = f.mock.calls[0] as any[];
    expect(init.headers.Authorization).toMatch(/^Basic /);
    expect(init.body).toBe('grant_type=client_credentials');
    expect(init.headers['User-Agent']).toMatch(/tradeiq/);
  });

  it('caches the token instead of re-authenticating every call', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) }) as any);
    await getAccessToken({ fetchImpl: f as any });
    await getAccessToken({ fetchImpl: f as any });
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('renews the token BEFORE it expires, not after', async () => {
    const f = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 100 }) }) as any);
    await getAccessToken({ fetchImpl: f as any, now: 0 });
    // 50s in: still inside the 60s safety margin, so it must refresh.
    await getAccessToken({ fetchImpl: f as any, now: 50_000 });
    expect(f).toHaveBeenCalledTimes(2);
  });

  it('explains the approval step on a 401 — the failure surfaces a step late', async () => {
    const f = vi.fn(async () => ({ ok: false, status: 401 }) as any);
    await expect(getAccessToken({ fetchImpl: f as any })).rejects.toThrow(/register to use the API/);
  });

  it('redditGet reports failure as a result, never a throw', async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as any;
      return { ok: false, status: 403, headers: { get: () => null } } as any;
    });
    const r = await redditGet('/r/x/new', { fetchImpl: f as any });
    expect(r.ok).toBe(false);
    expect(r.status).toBe(403);
    expect(r.data).toBeNull();
  });
});

describe('fetchRedditMentions', () => {
  const listing = (posts: Array<{ title: string; body?: string; ts?: number }>) => ({
    data: { children: posts.map((p) => ({ data: { title: p.title, selftext: p.body ?? '', created_utc: p.ts ?? 1_770_000_000 } })) },
  });

  const mk = (byPath: (path: string) => any) =>
    vi.fn(async (url: string) => {
      if (String(url).includes('access_token')) {
        return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as any;
      }
      return { ok: true, status: 200, headers: { get: () => '99' }, json: async () => byPath(String(url)) } as any;
    });

  it('is dormant and says so when unconfigured — nothing degrades', async () => {
    delete process.env.REDDIT_CLIENT_ID;
    const r = await fetchRedditMentions();
    expect(r.available).toBe(false);
    expect(r.reason).toMatch(/ApeWisdom covers this leg meanwhile/);
  });

  it('counts one mention per POST, across subreddits', async () => {
    const f = mk(() => listing([
      { title: 'GME squeeze', body: 'GME GME GME' },
      { title: 'thoughts on $CROX' },
    ]));
    const r = await fetchRedditMentions({ known: KNOWN, fetchImpl: f as any, subreddits: ['wallstreetbets', 'stocks'] });
    expect(r.available).toBe(true);
    expect(r.postsScanned).toBe(4);         // 2 posts x 2 subs
    expect(r.counts.GME).toBe(2);           // once per post, not 6
    expect(r.counts.CROX).toBe(2);
  });

  it('bounds the window with the oldest post seen', async () => {
    const f = mk(() => listing([{ title: 'GME', ts: 1_760_000_000 }, { title: 'GME', ts: 1_770_000_000 }]));
    const r = await fetchRedditMentions({ known: KNOWN, fetchImpl: f as any, subreddits: ['wallstreetbets'] });
    expect(r.oldestPost).toBe(new Date(1_760_000_000 * 1000).toISOString());
  });

  it('keeps partial results when ONE subreddit fails, and says which', async () => {
    const f = vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as any;
      if (u.includes('/r/stocks/')) return { ok: false, status: 500, headers: { get: () => null } } as any;
      return { ok: true, status: 200, headers: { get: () => '99' }, json: async () => listing([{ title: 'GME' }]) } as any;
    });
    const r = await fetchRedditMentions({ known: KNOWN, fetchImpl: f as any, subreddits: ['wallstreetbets', 'stocks'] });
    expect(r.available).toBe(true);
    expect(r.counts.GME).toBe(1);
    expect(r.reason).toMatch(/partial:.*stocks/);
  });

  // The failure that would matter most: a total outage reported as silence.
  it('reports a TOTAL failure as unavailable, never as a quiet market', async () => {
    const f = vi.fn(async (url: string) => {
      if (String(url).includes('access_token')) return { ok: true, status: 200, json: async () => ({ access_token: 't', expires_in: 3600 }) } as any;
      return { ok: false, status: 503, headers: { get: () => null } } as any;
    });
    const r = await fetchRedditMentions({ known: KNOWN, fetchImpl: f as any, subreddits: ['wallstreetbets'] });
    expect(r.available).toBe(false);
    expect(r.counts).toEqual({});
    expect(r.reason).toMatch(/all subreddits failed/);
  });

  it('omits tickers with no mentions rather than writing zeros', async () => {
    const f = mk(() => listing([{ title: 'GME only' }]));
    const r = await fetchRedditMentions({ known: KNOWN, fetchImpl: f as any, subreddits: ['wallstreetbets'] });
    expect(r.counts.CROX).toBeUndefined();
    expect(Object.values(r.counts)).not.toContain(0);
  });
});
