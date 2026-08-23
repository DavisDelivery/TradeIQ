// COMP-1 — the Compounders board scoring core.
//
// This board exists because a real complaint was correct: none of the seven
// live boards could ever surface a consensus mega-cap, because every one of
// them ranks a DISLOCATION. The risk in fixing that is obvious — a board with
// no cheapness axis, built after someone asked why their favourite stock never
// appeared, is exactly the shape of a screen bent to fit a conclusion.
//
// So these tests guard the two things that keep it honest: the quality
// definition that actually replicated (and cannot be gamed with leverage),
// and the refusal to rank a name on half the evidence.

import { describe, it, expect } from 'vitest';
import {
  scoreCompounders,
  qualityOf,
  QUALITY_WEIGHT,
  MOMENTUM_WEIGHT,
  MIN_QUALITY_PCT,
  type CompounderInput,
} from '../compounders';

/** A candidate that clears the universe policy, so tests isolate the scoring. */
const cand = (over: Partial<CompounderInput> & { ticker: string }): CompounderInput => ({
  marketCapM: 50_000,
  medianDollarVol: 500_000_000,
  price: 100,
  ...over,
});

/** n names spread across quality and momentum, to give percentiles something to rank. */
const spread = (n: number): CompounderInput[] =>
  Array.from({ length: n }, (_, i) =>
    cand({
      ticker: `T${i}`,
      grossProfit: 10 + i,
      totalAssets: 100,
      momentum12_1Pct: i,
    }),
  );

describe('the weights are a stated judgement, not a fitted parameter', () => {
  it('blends to exactly 1 so the composite stays a percentile', () => {
    expect(QUALITY_WEIGHT + MOMENTUM_WEIGHT).toBeCloseTo(1, 10);
  });

  it('leads with quality — the persistent, large-capacity axis', () => {
    expect(QUALITY_WEIGHT).toBeGreaterThan(MOMENTUM_WEIGHT);
  });
});

describe('quality is gross profits over ASSETS', () => {
  // Hou/Xue/Zhang: operating-profits-to-BOOK-EQUITY fails replication while
  // the cash-based, assets-denominated version survives even the q-factor
  // model. The denominator is the entire finding.
  it('uses the exact ratio when both statement inputs are present', () => {
    const q = qualityOf(cand({ ticker: 'A', grossProfit: 40, totalAssets: 100 }));
    expect(q.value).toBeCloseTo(0.4, 10);
    expect(q.basis).toBe('gross-profits-to-assets');
  });

  it('cannot be gamed with leverage, which is why ROE is only a fallback', () => {
    // Same business, same gross profit and assets. The second one has borrowed
    // heavily, shrinking equity and inflating ROE. On the exact basis they are
    // identical — on an ROE-led score the levered one would look better.
    const clean = qualityOf(cand({ ticker: 'CLEAN', grossProfit: 40, totalAssets: 100, roePct: 12 }));
    const levered = qualityOf(cand({ ticker: 'LEV', grossProfit: 40, totalAssets: 100, roePct: 90 }));
    expect(clean.value).toBe(levered.value);
    expect(levered.basis).toBe('gross-profits-to-assets');
  });

  it('falls back to ROE only when the statements are missing, and says so', () => {
    const q = qualityOf(cand({ ticker: 'B', grossProfit: null, totalAssets: null, roePct: 30 }));
    expect(q.value).toBe(30);
    expect(q.basis).toBe('roe-proxy');
  });

  it('refuses to invent quality from nothing', () => {
    const q = qualityOf(cand({ ticker: 'C' }));
    expect(q.value).toBeNull();
    expect(q.basis).toBe('none');
  });

  it('needs BOTH statement inputs — a missing denominator is not an assumption', () => {
    expect(qualityOf(cand({ ticker: 'D', grossProfit: 40, totalAssets: null })).basis)
      .not.toBe('gross-profits-to-assets');
  });
});

describe('the two axes are integrated, not two sleeves', () => {
  // Fisher, Shah & Titman (2016): scoring both signals simultaneously beats
  // blending two independently-formed portfolios, because it declines to buy
  // a name that is excellent on one axis and terrible on the other.
  it('ranks a both-good name above a one-sided name', () => {
    const rows = [
      ...spread(20),
      cand({ ticker: 'BOTH', grossProfit: 60, totalAssets: 100, momentum12_1Pct: 200 }),
      cand({ ticker: 'ONESIDED', grossProfit: 60, totalAssets: 100, momentum12_1Pct: -50 }),
    ];
    const out = scoreCompounders(rows).scored;
    const both = out.findIndex((s) => s.ticker === 'BOTH');
    const one = out.findIndex((s) => s.ticker === 'ONESIDED');
    expect(both).toBeLessThan(one);
  });

  it('composite is the stated weighted blend of the two percentiles', () => {
    const out = scoreCompounders(spread(11)).scored;
    for (const s of out) {
      if (s.composite === null) continue;
      expect(s.composite).toBeCloseTo(
        QUALITY_WEIGHT * (s.qualityPct as number) + MOMENTUM_WEIGHT * (s.momentumPct as number),
        10,
      );
    }
  });
});

describe('a name is never ranked on half the evidence', () => {
  it('marks a name with no quality input unscorable rather than scoring it on momentum', () => {
    const rows = [...spread(20), cand({ ticker: 'NOQ', momentum12_1Pct: 500 })];
    const out = scoreCompounders(rows);
    const noq = out.scored.find((s) => s.ticker === 'NOQ');
    expect(noq?.composite).toBeNull();
    expect(noq?.unscorable).toBe('no-quality');
    expect(out.unscorable['no-quality']).toBe(1);
  });

  it('marks a name with no momentum unscorable rather than scoring it on quality', () => {
    const rows = [...spread(20), cand({ ticker: 'NOM', grossProfit: 90, totalAssets: 100 })];
    const out = scoreCompounders(rows);
    const nom = out.scored.find((s) => s.ticker === 'NOM');
    expect(nom?.composite).toBeNull();
    expect(nom?.unscorable).toBe('no-momentum');
  });

  it('sorts unscorable names last so they cannot occupy a rank', () => {
    const rows = [...spread(10), cand({ ticker: 'NOQ', momentum12_1Pct: 999 })];
    const out = scoreCompounders(rows).scored;
    expect(out[out.length - 1].ticker).toBe('NOQ');
  });
});

describe('junk momentum is gated out', () => {
  // QMJ's finding is that junk does not pay, and a hard-run low-quality name
  // is the classic momentum-crash casualty. A percentile floor adapts to the
  // universe instead of hard-coding a ratio that means nothing across sectors.
  it('drops a bottom-quartile-quality name no matter how hard it ran', () => {
    const rows = [
      ...spread(40),
      cand({ ticker: 'JUNK', grossProfit: 0.1, totalAssets: 100, momentum12_1Pct: 10_000 }),
    ];
    const out = scoreCompounders(rows);
    const junk = out.scored.find((s) => s.ticker === 'JUNK');
    expect(junk?.momentumPct).toBe(1);          // it did top the momentum axis
    expect(junk?.qualityPct).toBeLessThan(MIN_QUALITY_PCT);
    expect(junk?.composite).toBeNull();          // and it still does not rank
    expect(junk?.unscorable).toBe('below-quality-floor');
  });

  it('the floor is the reason, not a missing input', () => {
    const rows = [
      ...spread(40),
      cand({ ticker: 'JUNK', grossProfit: 0.1, totalAssets: 100, momentum12_1Pct: 10_000 }),
    ];
    const out = scoreCompounders(rows);
    // The floor is a percentile, so it catches the whole bottom quartile of
    // whatever universe it is given — not just the one planted name. What
    // matters is that these are gated for LOW QUALITY, not missing data.
    expect(out.unscorable['below-quality-floor']).toBeGreaterThanOrEqual(1);
    expect(out.unscorable['no-quality']).toBe(0);
    expect(out.scored.filter((s) => s.unscorable === 'below-quality-floor')
      .every((s) => s.qualityPct !== null && s.qualityPct < MIN_QUALITY_PCT)).toBe(true);
  });
});

describe('the universe policy still governs', () => {
  it('excludes a microcap before it can score, however good it looks', () => {
    const rows = [
      ...spread(20),
      cand({ ticker: 'TINY', marketCapM: 50, grossProfit: 90, totalAssets: 100, momentum12_1Pct: 300 }),
    ];
    const out = scoreCompounders(rows);
    expect(out.scored.find((s) => s.ticker === 'TINY')).toBeUndefined();
    expect(out.excluded.microcap).toBe(1);
  });

  it('excludes an illiquid name — HXZ-style microcap edges are untradeable here', () => {
    const rows = [
      ...spread(20),
      cand({ ticker: 'THIN', medianDollarVol: 1000, grossProfit: 90, totalAssets: 100, momentum12_1Pct: 300 }),
    ];
    const out = scoreCompounders(rows);
    expect(out.scored.find((s) => s.ticker === 'THIN')).toBeUndefined();
    expect(out.excluded.illiquid).toBe(1);
  });
});

describe('the NVDA case, which is why this board was built', () => {
  // Measured 2026-08-21 from the live detail bundle: gross profits / assets
  // ~0.64 (top-quintile starts near 0.33-0.40) but trailing-year relative
  // strength vs SPY of only +2.23%. Elite quality, unremarkable momentum.
  //
  // The fixture below deliberately DE-CORRELATES the two axes. An earlier
  // version of this test had quality and momentum both ascending with the
  // index, which made every high-quality name also a momentum leader and
  // flattered the result. Real universes do not look like that.
  const N = 200;
  const universe: CompounderInput[] = Array.from({ length: N }, (_, i) =>
    cand({
      ticker: `U${i}`,
      grossProfit: 5 + (i * 45) / N,          // quality ascends, 0.05..0.50
      totalAssets: 100,
      momentum12_1Pct: ((i * 97) % N) - 50,   // momentum shuffled against it
    }),
  );
  const nvdaLike = (momentum12_1Pct: number) =>
    cand({ ticker: 'NVDALIKE', grossProfit: 64, totalAssets: 100, momentum12_1Pct });

  const placementOf = (mom: number) => {
    const out = scoreCompounders([...universe, nvdaLike(mom)]).scored
      .filter((s) => s.composite !== null);
    return (out.findIndex((s) => s.ticker === 'NVDALIKE') + 1) / out.length;
  };

  // THESE TEST THE MECHANISM, NOT A PLACEMENT NUMBER.
  //
  // An earlier version asserted `placementOf(10) < 0.25` and
  // `placementOf(50) < 0.15`. A review measured what that actually pinned:
  // QUALITY_WEIGHT 0.55 and 0.50 both FAIL those thresholds, so the suite had
  // quietly locked the weight at roughly >= 0.57 to keep an NVDA-shaped name
  // in a chosen band. Nobody swept a parameter, but a ticker-shaped result had
  // become a regression invariant — which is the same thing wearing a
  // different hat. What is actually worth guarding is that the quality axis
  // CAN carry a momentum laggard, not how far.
  //
  // VERIFIED after the rewrite: the suite now passes at QUALITY_WEIGHT 0.55,
  // 0.60, 0.75 and 0.80. The only value that fails is 0.50, and it fails on
  // "leads with quality" — the stated design of the board, not a placement.

  it('lifts a momentum laggard above where momentum alone would put it', () => {
    const withQuality = placementOf(10);
    const momentumOnlyRank = 1 - 0.3;  // ~30th percentile momentum, i.e. bottom 70%
    expect(withQuality).toBeLessThan(momentumOnlyRank);
  });

  it('improves monotonically as momentum improves, quality held at the top', () => {
    expect(placementOf(150)).toBeLessThanOrEqual(placementOf(50));
    expect(placementOf(50)).toBeLessThanOrEqual(placementOf(10));
  });

  it('is NOT engineered to the top — a name strong on BOTH axes still wins', () => {
    // The honest limit of the design, and the integrated-scoring behaviour we
    // want: elite quality alone does not buy the top of the board.
    expect(placementOf(10)).toBeGreaterThan(0);
    const out = scoreCompounders([...universe, nvdaLike(10)]).scored
      .filter((s) => s.composite !== null);
    expect(out[0].ticker).not.toBe('NVDALIKE');
  });

  it('would NOT rank on momentum alone — the reason every old board missed it', () => {
    const out = scoreCompounders([...universe, nvdaLike(10)]).scored;
    const n = out.find((s) => s.ticker === 'NVDALIKE');
    expect(n?.momentumPct).toBeLessThan(0.5);   // mid-pack on price trend
    expect(n?.qualityPct).toBe(1);              // top of the quality axis
  });

  it('reports the exact basis so the UI can say the score is not a proxy', () => {
    const out = scoreCompounders([...universe, nvdaLike(10)]);
    const n = out.scored.find((s) => s.ticker === 'NVDALIKE');
    expect(n?.qualityBasis).toBe('gross-profits-to-assets');
    expect(n?.grossProfitability).toBeCloseTo(0.64, 10);
    expect(out.exactBasisCount).toBeGreaterThan(0);
  });
});

describe('degenerate inputs', () => {
  it('handles an empty universe', () => {
    const out = scoreCompounders([]);
    expect(out.scored).toEqual([]);
    expect(out.universeChecked).toBe(0);
  });

  it('handles a single name without dividing by zero', () => {
    const out = scoreCompounders([
      cand({ ticker: 'ONLY', grossProfit: 40, totalAssets: 100, momentum12_1Pct: 5 }),
    ]);
    expect(out.scored[0].qualityPct).toBe(1);
    expect(out.scored[0].composite).toBeCloseTo(1, 10);
  });
});
