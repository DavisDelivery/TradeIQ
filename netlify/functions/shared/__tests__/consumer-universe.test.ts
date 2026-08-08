import { describe, expect, it } from 'vitest';
import { CONSUMER_SECTORS, dollarVolumeOf, selectConsumerRows } from '../consumer-universe';
import { MIN_MARKET_CAP_M, MIN_PRICE } from '../research-policy';
import type { FinvizRow } from '../finviz';

// avgVolume is in THOUSANDS of shares. 500k shares x $20 = $10M/day, which
// clears the $3M liquidity floor comfortably.
const row = (
  ticker: string,
  sector: string | null,
  marketCapM: number | null,
  extra: Partial<FinvizRow> = {},
): FinvizRow => ({ ticker, sector, marketCapM, price: 20, avgVolume: 500, ...extra } as FinvizRow);

const pick = (rows: FinvizRow[], limit: number) => selectConsumerRows(rows, limit).kept;

describe('selectConsumerRows', () => {
  it('keeps only the consumer sectors', () => {
    const out = pick(
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
    const out = pick(
      [row('A', 'Consumer Cyclical', null), row('B', 'Consumer Cyclical', 0), row('C', 'Consumer Cyclical', 400)],
      10,
    );
    expect(out.map((r) => r.ticker)).toEqual(['C']);
  });

  it('orders largest first — a stability choice, not a quality ranking', () => {
    const out = pick(
      [row('SMALL', 'Consumer Cyclical', 400), row('BIG', 'Consumer Cyclical', 9000), row('MID', 'Consumer Cyclical', 500)],
      10,
    );
    expect(out.map((r) => r.ticker)).toEqual(['BIG', 'MID', 'SMALL']);
  });

  it('breaks cap ties deterministically, so the watchlist does not churn day to day', () => {
    // The whole point of the ordering is a stable set: ApeWisdom and Apple
    // only become a SERIES because the same names are polled every day.
    const rows = [row('ZZZ', 'Consumer Cyclical', 500), row('AAA', 'Consumer Cyclical', 500)];
    expect(pick(rows, 10).map((r) => r.ticker)).toEqual(['AAA', 'ZZZ']);
    expect(pick([...rows].reverse(), 10).map((r) => r.ticker)).toEqual(['AAA', 'ZZZ']);
  });

  it('truncates to the limit', () => {
    const rows = Array.from({ length: 50 }, (_, i) => row(`T${i}`, 'Consumer Cyclical', 1000 - i));
    expect(pick(rows, 40)).toHaveLength(40);
  });

  it('treats a negative or fractional limit as zero-or-floor rather than slicing from the end', () => {
    const rows = [row('A', 'Consumer Cyclical', 400), row('B', 'Consumer Cyclical', 500)];
    expect(pick(rows, -5)).toEqual([]);
    expect(pick(rows, 1.9)).toHaveLength(1);
  });

  it('exposes the sector list so callers report the filter they actually applied', () => {
    expect(CONSUMER_SECTORS).toEqual(['Consumer Cyclical', 'Consumer Defensive']);
  });
});

describe('the ratified universe policy is applied (PR #198)', () => {
  it('excludes microcaps below the $300M floor', () => {
    const out = selectConsumerRows([
      row('BIG', 'Consumer Cyclical', 5000),
      row('TINY', 'Consumer Cyclical', MIN_MARKET_CAP_M - 1),
    ], 10);
    expect(out.kept.map((r) => r.ticker)).toEqual(['BIG']);
    expect(out.excluded.TINY).toBe('microcap');
    expect(out.counts.microcap).toBe(1);
  });

  it('excludes sub-$5 names', () => {
    const out = selectConsumerRows([row('PENNY', 'Consumer Cyclical', 1000, { price: MIN_PRICE - 0.01 })], 10);
    expect(out.kept).toEqual([]);
    expect(out.excluded.PENNY).toBe('price-floor');
  });

  it('excludes illiquid names on dollar volume, not share count', () => {
    // 10k shares x $6 = $60k/day. Passes any share-count screen, fails the
    // floor that actually governs whether an order can be filled.
    const out = selectConsumerRows([row('THIN', 'Consumer Cyclical', 1000, { price: 6, avgVolume: 10 })], 10);
    expect(out.kept).toEqual([]);
    expect(out.excluded.THIN).toBe('illiquid');
  });

  it('excludes on MISSING data rather than assuming the name qualifies', () => {
    const out = selectConsumerRows([
      row('NOCAP', 'Consumer Cyclical', null),
      row('NOPX', 'Consumer Cyclical', 1000, { price: null }),
      row('NOVOL', 'Consumer Cyclical', 1000, { avgVolume: null }),
    ], 10);
    expect(out.kept).toEqual([]);
    expect(out.counts['no-data']).toBe(3);
  });

  it('applies the policy BEFORE truncating, so the next eligible name takes the slot', () => {
    // Filtering after the slice would silently return one name instead of two.
    const out = selectConsumerRows([
      row('A', 'Consumer Cyclical', 9000),
      row('BAD', 'Consumer Cyclical', 8000, { price: 1 }),
      row('C', 'Consumer Cyclical', 7000),
    ], 2);
    expect(out.kept.map((r) => r.ticker)).toEqual(['A', 'C']);
  });

  it('returns plain FinvizRows without the derived policy field leaking out', () => {
    const out = selectConsumerRows([row('A', 'Consumer Cyclical', 1000)], 10);
    expect(out.kept[0]).not.toHaveProperty('medianDollarVol');
  });
});

describe('dollarVolumeOf', () => {
  it('reads avgVolume as thousands of shares', () => {
    expect(dollarVolumeOf({ avgVolume: 1000, price: 50 } as FinvizRow)).toBe(50_000_000);
  });

  it('is null when either input is missing, so the policy excludes on no-data', () => {
    expect(dollarVolumeOf({ avgVolume: null, price: 50 } as FinvizRow)).toBeNull();
    expect(dollarVolumeOf({ avgVolume: 1000, price: null } as FinvizRow)).toBeNull();
  });
});
