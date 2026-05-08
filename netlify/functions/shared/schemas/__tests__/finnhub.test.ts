import { describe, it, expect, vi } from 'vitest';
import {
  FinnhubEarningsCalendarResponseSchema,
  FinnhubEarningsHistoryResponseSchema,
  FinnhubInsiderTxResponseSchema,
} from '../finnhub';

const earningsCalendarFixture = {
  earningsCalendar: [
    {
      symbol: 'AAPL',
      date: '2024-10-31',
      hour: 'amc',
      epsEstimate: 1.59,
      epsActual: null,
      revenueEstimate: 94300000000,
      revenueActual: null,
      year: 2024,
      quarter: 4,
    },
    {
      symbol: 'MSFT',
      date: '2024-10-30',
      hour: 'amc',
      epsEstimate: 3.10,
      revenueEstimate: 64500000000,
    },
  ],
};

const earningsHistoryFixture = [
  { symbol: 'AAPL', period: '2024-06-30', actual: 1.40, estimate: 1.35, surprise: 0.05, surprisePercent: 3.7, year: 2024, quarter: 2 },
  { symbol: 'AAPL', period: '2024-03-31', actual: 1.53, estimate: 1.50, surprise: 0.03, surprisePercent: 2.0 },
  { symbol: 'AAPL', period: '2023-12-31', actual: 2.18, estimate: 2.10, surprisePercent: 3.81 },
];

const insiderTxFixture = {
  data: [
    {
      name: 'COOK TIMOTHY D',
      share: 3280000,
      change: -50000,
      filingDate: '2024-09-15',
      transactionDate: '2024-09-13',
      transactionPrice: 224.83,
      transactionCode: 'S',
      isDerivative: false,
      source: 'EDGAR',
      currency: 'USD',
      symbol: 'AAPL',
    },
    {
      name: 'KONDO CHRIS',
      share: 14000,
      change: 5000,
      filingDate: '2024-09-12',
      transactionDate: '2024-09-10',
      transactionPrice: 0,
      transactionCode: 'A',
      isDerivative: false,
      source: 'EDGAR',
      currency: 'USD',
    },
  ],
  symbol: 'AAPL',
};

describe('FinnhubEarningsCalendarResponseSchema', () => {
  it('parses a real earnings calendar response', () => {
    const parsed = FinnhubEarningsCalendarResponseSchema.safeParse(earningsCalendarFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.earningsCalendar).toHaveLength(2);
      expect(parsed.data.earningsCalendar?.[0].symbol).toBe('AAPL');
    }
  });

  it('handles null estimates (Finnhub returns null for un-covered tickers)', () => {
    const parsed = FinnhubEarningsCalendarResponseSchema.safeParse({
      earningsCalendar: [{ symbol: 'XYZ', date: '2024-11-15', epsEstimate: null, revenueEstimate: null }],
    });
    expect(parsed.success).toBe(true);
  });

  it('coerces stringified estimates (seen in the wild)', () => {
    const parsed = FinnhubEarningsCalendarResponseSchema.safeParse({
      earningsCalendar: [{ symbol: 'XYZ', date: '2024-11-15', epsEstimate: '1.25' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.earningsCalendar?.[0].epsEstimate).toBe(1.25);
  });

  it('defaults earningsCalendar to [] when entirely missing', () => {
    const parsed = FinnhubEarningsCalendarResponseSchema.safeParse({});
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.earningsCalendar).toEqual([]);
  });

  it('passes through unknown future fields on calendar items', () => {
    const parsed = FinnhubEarningsCalendarResponseSchema.safeParse({
      earningsCalendar: [{ symbol: 'X', date: '2024-11-15', confidenceScore: 0.8 }],
    });
    expect(parsed.success).toBe(true);
  });
});

describe('FinnhubEarningsHistoryResponseSchema', () => {
  it('parses a real earnings surprise array', () => {
    const parsed = FinnhubEarningsHistoryResponseSchema.safeParse(earningsHistoryFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data).toHaveLength(3);
      expect(parsed.data[0].actual).toBe(1.40);
    }
  });

  it('rejects an envelope-shaped response (Finnhub returns bare array here)', () => {
    const parsed = FinnhubEarningsHistoryResponseSchema.safeParse({
      data: earningsHistoryFixture,
    });
    expect(parsed.success).toBe(false);
  });

  it('coerces stringified actual/estimate values', () => {
    const parsed = FinnhubEarningsHistoryResponseSchema.safeParse([
      { period: '2024-06-30', actual: '1.40', estimate: '1.35' },
    ]);
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data[0].actual).toBe(1.40);
  });
});

describe('FinnhubInsiderTxResponseSchema', () => {
  it('parses a real insider-tx response', () => {
    const parsed = FinnhubInsiderTxResponseSchema.safeParse(insiderTxFixture);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.data).toHaveLength(2);
      expect(parsed.data.data?.[0].change).toBe(-50000);
    }
  });

  it('defaults missing fields to safe values', () => {
    const parsed = FinnhubInsiderTxResponseSchema.safeParse({
      data: [{ name: 'X' }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const row = parsed.data.data?.[0];
      expect(row?.share).toBe(0);
      expect(row?.change).toBe(0);
      expect(row?.transactionPrice).toBe(0);
      expect(row?.isDerivative).toBe(false);
    }
  });

  it('passes through unknown row fields', () => {
    const parsed = FinnhubInsiderTxResponseSchema.safeParse({
      data: [
        {
          name: 'X',
          share: 100,
          change: 50,
          filingDate: '2024-01-01',
          transactionDate: '2024-01-01',
          transactionPrice: 1,
          transactionCode: 'P',
          isDerivative: false,
          source: 'EDGAR',
          currency: 'USD',
          newCustomField: 'present',
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it('handles an empty data array', () => {
    const parsed = FinnhubInsiderTxResponseSchema.safeParse({ data: [], symbol: 'X' });
    expect(parsed.success).toBe(true);
  });

  it('handles missing data field via default', () => {
    const parsed = FinnhubInsiderTxResponseSchema.safeParse({ symbol: 'X' });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.data).toEqual([]);
  });
});
