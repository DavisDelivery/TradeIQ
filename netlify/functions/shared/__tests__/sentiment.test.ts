// Locks the sentiment scorer + aggregation + scan contract.

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';

// Small deterministic universe so the scan test doesn't depend on the real
// 500-name list.
vi.mock('../universe', () => ({
  inIndex: () => [
    { ticker: 'AAA', name: 'Alpha Co', sector: 'Tech', indices: ['sp500'] },
    { ticker: 'BBB', name: 'Beta Co', sector: 'Health', indices: ['sp500'] },
    { ticker: 'CCC', name: 'Gamma Co', sector: 'Energy', indices: ['sp500'] },
  ],
}));

import {
  scoreArticleText,
  aggregateSentiment,
  runSentimentScan,
  type CompanyNewsItem,
} from '../sentiment';

const news = (headline: string, summary = '', datetime = 1_700_000_000): CompanyNewsItem => ({
  headline, summary, url: 'https://x/y', source: 'Reuters', datetime,
});

describe('scoreArticleText', () => {
  it('scores clearly bullish text positive, bearish negative, neutral zero', () => {
    expect(scoreArticleText('Company beats earnings, stock surges to record')).toBeGreaterThan(0);
    expect(scoreArticleText('Shares plunge after analyst downgrade and guidance cut')).toBeLessThan(0);
    expect(scoreArticleText('Company to hold annual shareholder meeting Tuesday')).toBe(0);
  });

  it('clamps a single sensational headline to ±3', () => {
    expect(scoreArticleText('surge surge surge beats upgrade rally record raised wins')).toBe(3);
    expect(scoreArticleText('plunge crash fraud bankruptcy lawsuit downgrade miss')).toBe(-3);
  });

  it('catches multiword phrases (price target cut, raises guidance)', () => {
    expect(scoreArticleText('Analyst price target cut on the name')).toBeLessThan(0);
    expect(scoreArticleText('Firm raises guidance for the year')).toBeGreaterThan(0);
  });
});

describe('aggregateSentiment', () => {
  it('returns neutral zero on no articles', () => {
    const a = aggregateSentiment([]);
    expect(a.score).toBe(0);
    expect(a.label).toBe('neutral');
    expect(a.topHeadline).toBeNull();
  });

  it('aggregates net sentiment, buzz, and picks the most impactful headline', () => {
    const a = aggregateSentiment([
      news('Stock surges as company beats and raises guidance'),
      news('Board to meet Tuesday to review agenda'),
      news('Shares slip modestly'),
    ]);
    expect(a.articleCount).toBe(3);
    expect(a.score).toBeGreaterThan(0);
    expect(a.positiveCount).toBe(1);
    expect(a.topHeadline?.sentiment).toBe('positive');
    expect(a.topHeadline?.headline).toMatch(/surges/);
  });

  it('labels bearish when the mean is clearly negative', () => {
    const a = aggregateSentiment([
      news('Shares plunge on downgrade'),
      news('Company misses earnings badly'),
    ]);
    expect(a.label).toBe('bearish');
    expect(a.score).toBeLessThan(-15);
  });
});

describe('runSentimentScan', () => {
  const origFetch = global.fetch;
  beforeEach(() => { process.env.FINNHUB_API_KEY = 'test'; });
  afterEach(() => { global.fetch = origFetch; vi.restoreAllMocks(); });

  it('scores the universe, drops no-news tickers, sorts most-bullish first', async () => {
    global.fetch = vi.fn(async (url: any) => {
      const u = String(url);
      const body =
        u.includes('symbol=AAA')
          ? [{ headline: 'AAA surges as it beats and raises guidance', summary: '', url: 'u', source: 's', datetime: 1 }]
          : u.includes('symbol=BBB')
            ? [{ headline: 'BBB shares plunge on downgrade and guidance cut', summary: '', url: 'u', source: 's', datetime: 1 }]
            : []; // CCC has no news → dropped
      return { ok: true, status: 200, json: async () => body } as any;
    }) as any;

    const res = await runSentimentScan({ universe: 'sp500', concurrency: 3 });
    expect(res.tickersChecked).toBe(3);
    expect(res.rows.map((r) => r.ticker)).toEqual(['AAA', 'BBB']); // CCC dropped, AAA (bull) before BBB (bear)
    expect(res.rows[0].label).toBe('bullish');
    expect(res.rows[1].label).toBe('bearish');
  });
});
