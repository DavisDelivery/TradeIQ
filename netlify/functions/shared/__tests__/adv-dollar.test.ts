// Finviz reports Average Volume in THOUSANDS of shares. Reading it as raw
// shares is a 1000x error that produces entirely plausible-looking numbers,
// which is why it shipped and survived review in two places at once.
//
// How it surfaced: the Compounders board's first live run excluded 487 of 518
// S&P/NDX/DJI names as "illiquid" against a $3M floor. The floor was really
// behaving like $3B. Among the rejected: Coca-Cola and Johnson & Johnson.

import { describe, it, expect } from 'vitest';
import { advDollar } from '../finviz';
import { MIN_MEDIAN_DOLLAR_VOL, exclusionReason } from '../research-policy';

/** Real values read from production on 2026-08-24. */
const LIVE = [
  { ticker: 'AAPL', avgVolumeK: 56_434.28, price: 310.34, trueAdvB: 17.5 },
  { ticker: 'MSFT', avgVolumeK: 39_618, price: 487.31, trueAdvB: 19.3 },
  { ticker: 'KO', avgVolumeK: 17_603, price: 91.99, trueAdvB: 1.6 },
  { ticker: 'JNJ', avgVolumeK: 7_983, price: 273.04, trueAdvB: 2.2 },
];

describe('average daily turnover is dollars, from thousands of shares', () => {
  it('converts to the right order of magnitude', () => {
    for (const { ticker, avgVolumeK, price, trueAdvB } of LIVE) {
      const adv = advDollar(avgVolumeK, price)!;
      expect(adv / 1e9, `${ticker} ADV$ in billions`).toBeCloseTo(trueAdvB, 0);
    }
  });

  it('is exactly 1000x the naive product — the bug it replaces', () => {
    const naive = 56_434.28 * 310.34;
    expect(advDollar(56_434.28, 310.34)).toBeCloseTo(naive * 1000, 6);
  });

  it('returns null rather than guessing from a missing input', () => {
    expect(advDollar(null, 100)).toBeNull();
    expect(advDollar(50_000, null)).toBeNull();
    expect(advDollar(undefined, undefined)).toBeNull();
    expect(advDollar(NaN, 100)).toBeNull();
  });
});

describe('the liquidity floor no longer rejects the most liquid companies alive', () => {
  // The regression, stated as the absurdity that revealed it.
  it.each(LIVE)('does not call $ticker illiquid', ({ avgVolumeK, price }) => {
    const reason = exclusionReason({
      ticker: 'X',
      marketCapM: 500_000,
      medianDollarVol: advDollar(avgVolumeK, price),
      price,
    });
    expect(reason).toBeNull();
  });

  it('KO and JNJ WOULD have been excluded by the naive product', () => {
    // Both sit under the $3M floor when the x1000 is missing, which is how a
    // large-cap universe lost 94% of itself without anything looking broken.
    for (const { avgVolumeK, price } of LIVE.filter((l) => l.ticker === 'KO' || l.ticker === 'JNJ')) {
      expect(avgVolumeK * price).toBeLessThan(MIN_MEDIAN_DOLLAR_VOL);
    }
  });

  it('still excludes something genuinely thin', () => {
    // 20k shares a day at $10 = $200k. Real, and correctly rejected.
    expect(
      exclusionReason({
        ticker: 'THIN',
        marketCapM: 400,
        medianDollarVol: advDollar(20, 10),
        price: 10,
      }),
    ).toBe('illiquid');
  });
});
