import { describe, expect, it } from 'vitest';
import { CONSUMER_SECTORS, selectConsumerRows } from '../consumer-universe';
import type { FinvizRow } from '../finviz';

const row = (ticker: string, sector: string | null, marketCapM: number | null): FinvizRow =>
  ({ ticker, sector, marketCapM } as FinvizRow);

describe('selectConsumerRows', () => {
  it('keeps only the consumer sectors', () => {
    const out = selectConsumerRows(
      [
        row('CROX', 'Consumer Cyclical', 5000),
        row('AAPL', 'Technology', 3_000_000),
        row('KO', 'Consumer Defensive', 260_000),
        row('XOM', 'Energy', 400_000),
      ],
      10,
    );
    expect(out.map((r) => r.ticker)).toEqual(['KO', 'CROX']);
  });

  it('drops rows with no usable market cap rather than sorting them to the end', () => {
    // A null cap sorted as 0 would silently pack the tail of the list with
    // names we know nothing about, and the tail is where the cut falls.
    const out = selectConsumerRows(
      [row('A', 'Consumer Cyclical', null), row('B', 'Consumer Cyclical', 0), row('C', 'Consumer Cyclical', 100)],
      10,
    );
    expect(out.map((r) => r.ticker)).toEqual(['C']);
  });

  it('orders largest first — a stability choice, not a quality ranking', () => {
    const out = selectConsumerRows(
      [row('SMALL', 'Consumer Cyclical', 100), row('BIG', 'Consumer Cyclical', 9000), row('MID', 'Consumer Cyclical', 500)],
      10,
    );
    expect(out.map((r) => r.ticker)).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('breaks cap ties deterministically, so the watchlist does not churn day to day', () => {
    // The whole point of the ordering is a stable set: ApeWisdom and Apple
    // only become a SERIES because the same names are polled every day.
    const rows = [row('ZZZ', 'Consumer Cyclical', 500), row('AAA', 'Consumer Cyclical', 500)];
    expect(selectConsumerRows(rows, 10).map((r) => r.ticker)).toEqual(['AAA', 'ZZZ']);
    expect(selectConsumerRows([...rows].reverse(), 10).map((r) => r.ticker)).toEqual(['AAA', 'ZZZ']);
  });

  it('truncates to the limit', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`T${i}`, 'Consumer Cyclical', 1000 - i));
    expect(selectConsumerRows(rows, 40)).toHaveLength(40);
  });

  it('treats a negative or fractional limit as zero-or-floor rather than slicing from the end', () => {
    const rows = [row('A', 'Consumer Cyclical', 100), row('B', 'Consumer Cyclical', 200)];
    expect(selectConsumerRows(rows, -5)).toEqual([]);
    expect(selectConsumerRows(rows, 1.9)).toHaveLength(1);
  });

  it('exposes the sector list so callers report the filter they actually applied', () => {
    expect(CONSUMER_SECTORS).toEqual(['Consumer Cyclical', 'Consumer Defensive']);
  });
});
