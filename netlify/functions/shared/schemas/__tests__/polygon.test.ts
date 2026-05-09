import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PolygonAggregatesResponseSchema,
  PolygonFinancialsResponseSchema,
  PolygonNewsResponseSchema,
} from '../polygon';
import { parseOrFallback } from '../parse';

// Real-shape fixtures captured from production responses (anonymized).
// These are intentionally not minimal — they include the full vendor
// envelope so we exercise .passthrough() behavior.

const aggregatesFixture = {
  ticker: 'AAPL',
  status: 'OK',
  queryCount: 2,
  resultsCount: 2,
  adjusted: true,
  results: [
    { v: 47000000, vw: 188.34, o: 187.99, c: 188.71, h: 189.55, l: 187.45, t: 1700000000000, n: 350000 },
    { v: 51000000, vw: 189.10, o: 188.71, c: 189.85, h: 190.20, l: 188.30, t: 1700086400000, n: 380000 },
  ],
  request_id: 'req_abc123',
};

const financialsFixture = {
  status: 'OK',
  request_id: 'fin_req_1',
  count: 1,
  results: [
    {
      start_date: '2024-07-01',
      end_date: '2024-09-30',
      filing_date: '2024-10-30',
      fiscal_period: 'Q3',
      fiscal_year: '2024',
      cik: '0000320193',
      company_name: 'APPLE INC',
      financials: {
        income_statement: {
          revenues: { value: 94930000000, unit: 'USD', label: 'Revenues' },
          basic_earnings_per_share: { value: 1.40, unit: 'USD/shares' },
          gross_profit: { value: 43880000000, unit: 'USD' },
          operating_income_loss: { value: 29591000000, unit: 'USD' },
        },
        balance_sheet: {
          long_term_debt: { value: 96798000000, unit: 'USD' },
          equity: { value: 56950000000, unit: 'USD' },
        },
      },
    },
  ],
};

const newsFixture = {
  status: 'OK',
  count: 2,
  request_id: 'news_req_1',
  results: [
    {
      id: 'abc-123',
      title: 'Apple announces new iPhone',
      description: 'Apple unveiled its latest iPhone model today...',
      published_utc: '2024-09-12T13:00:00Z',
      article_url: 'https://example.com/news/apple-iphone',
      tickers: ['AAPL'],
      publisher: { name: 'Reuters', homepage_url: 'https://reuters.com', logo_url: 'https://reuters.com/logo.png' },
      author: 'Jane Doe',
      keywords: ['apple', 'iphone'],
    },
    {
      id: 'def-456',
      title: 'Apple beats earnings',
      published_utc: '2024-10-30T22:30:00Z',
      article_url: 'https://example.com/news/apple-earnings',
      tickers: ['AAPL', 'MSFT'],
    },
  ],
};

describe('PolygonAggregatesResponseSchema', () => {
  it('parses a real aggregates response', () => {
    const parsed = PolygonAggregatesResponseSchema.safeParse(aggregatesFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(2);
      expect(parsed.data.results?.[0].c).toBe(188.71);
    }
  });

  it('tolerates extra top-level fields via passthrough', () => {
    const withExtra = { ...aggregatesFixture, brand_new_field: 'hello', another: 42 };
    const parsed = PolygonAggregatesResponseSchema.safeParse(withExtra);
    expect(parsed.success).toBe(true);
  });

  it('tolerates extra fields within bars via passthrough', () => {
    const withBarExtra = {
      ...aggregatesFixture,
      results: [{ ...aggregatesFixture.results[0], otc: false, future_field: 'x' }],
    };
    const parsed = PolygonAggregatesResponseSchema.safeParse(withBarExtra);
    expect(parsed.success).toBe(true);
  });

  it('fails when a required bar field is renamed (drift detection)', () => {
    const drifted = {
      ...aggregatesFixture,
      results: [{ ...aggregatesFixture.results[0], c: undefined, close: 188.71 }],
    };
    const parsed = PolygonAggregatesResponseSchema.safeParse(drifted);
    expect(parsed.success).toBe(false);
  });

  it('defaults results to [] when missing entirely', () => {
    const parsed = PolygonAggregatesResponseSchema.safeParse({ status: 'OK' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.results).toEqual([]);
  });

  it('handles a status-only error envelope without crashing', () => {
    const parsed = PolygonAggregatesResponseSchema.safeParse({
      status: 'ERROR',
      error: 'Unknown ticker',
    });
    expect(parsed.success).toBe(true);
  });
});

describe('PolygonFinancialsResponseSchema', () => {
  it('parses a real financials response', () => {
    const parsed = PolygonFinancialsResponseSchema.safeParse(financialsFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const item = parsed.data.results?.[0]?.financials?.income_statement?.revenues;
      expect(item?.value).toBe(94930000000);
    }
  });

  it('coerces a stringified large value (Polygon has shipped these)', () => {
    const cloned = JSON.parse(JSON.stringify(financialsFixture));
    cloned.results[0].financials.income_statement.revenues.value = '94930000000';
    const parsed = PolygonFinancialsResponseSchema.safeParse(cloned);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results?.[0]?.financials?.income_statement?.revenues?.value).toBe(94930000000);
    }
  });

  it('tolerates an entirely empty results array', () => {
    const parsed = PolygonFinancialsResponseSchema.safeParse({ status: 'OK', results: [] });
    expect(parsed.success).toBe(true);
  });

  it('passes through unknown nested financial sections', () => {
    const cloned = JSON.parse(JSON.stringify(financialsFixture));
    cloned.results[0].financials.cash_flow_statement = { net_cash_flow: { value: 1234 } };
    const parsed = PolygonFinancialsResponseSchema.safeParse(cloned);
    expect(parsed.success).toBe(true);
  });
});

describe('PolygonNewsResponseSchema', () => {
  it('parses a real news response', () => {
    const parsed = PolygonNewsResponseSchema.safeParse(newsFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.results).toHaveLength(2);
      expect(parsed.data.results?.[0].publisher?.name).toBe('Reuters');
    }
  });

  it('fails when a required article field (id) is missing', () => {
    const drifted = {
      ...newsFixture,
      results: [{ ...newsFixture.results[0], id: undefined }],
    };
    const parsed = PolygonNewsResponseSchema.safeParse(drifted);
    expect(parsed.success).toBe(false);
  });

  it('defaults tickers to [] when omitted', () => {
    const minimal = {
      status: 'OK',
      results: [
        {
          id: 'x',
          title: 't',
          published_utc: '2024-01-01T00:00:00Z',
          article_url: 'https://e.com',
        },
      ],
    };
    const parsed = PolygonNewsResponseSchema.safeParse(minimal);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.results?.[0].tickers).toEqual([]);
  });
});

describe('parseOrFallback with Polygon', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('returns parsed data on happy path with no warn log', () => {
    const out = parseOrFallback(
      PolygonAggregatesResponseSchema,
      aggregatesFixture,
      { provider: 'polygon', endpoint: 'aggregates', ticker: 'AAPL' },
      { results: [] },
    );
    expect(out.results).toHaveLength(2);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('returns fallback and emits schema_mismatch on parse failure', () => {
    const broken = { results: [{ this: 'is', not: 'a bar' }] };
    const fallback = { results: [] };
    const out = parseOrFallback(
      PolygonAggregatesResponseSchema,
      broken,
      { provider: 'polygon', endpoint: 'aggregates', ticker: 'AAPL' },
      fallback,
    );
    expect(out).toBe(fallback);
    expect(warnSpy).toHaveBeenCalledOnce();
    const arg = warnSpy.mock.calls[0]?.[0] as string;
    const parsed = JSON.parse(arg);
    expect(parsed.event).toBe('schema_mismatch');
    expect(parsed.provider).toBe('polygon');
    expect(parsed.endpoint).toBe('aggregates');
    expect(parsed.ticker).toBe('AAPL');
  });
});
