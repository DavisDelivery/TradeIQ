// PROFILE-1 — the direction table is a gate, so it is tested as one.

import { describe, it, expect } from 'vitest';
import {
  METRIC_POLICY,
  NEUTRAL_METRICS,
  mayRenderVerdict,
  comparativePhrase,
  policyFor,
} from '../metric-direction';

// The kickoff's NEUTRAL list, transcribed. If someone reclassifies one of
// these as good/bad, this fails before the UI can.
const MUST_BE_NEUTRAL = [
  'pe', 'forwardPe', 'ps', 'pb', 'evEbitda', 'pfcf', 'fcfYield',
  'dividendYield', 'beta', 'rsi14', 'atrPct', 'instOwnPct', 'insiderOwnPct',
];

const MUST_BE_HIGHER = [
  'grossMargin', 'opMargin', 'netMargin', 'roa', 'roe',
  'interestCoverage', 'revenueGrowth', 'epsGrowth',
];

const MUST_BE_BAND = ['debtEquity', 'currentRatio', 'quickRatio', 'payoutRatio'];

describe('no valuation metric may ever emit a good/bad verdict', () => {
  it.each(MUST_BE_NEUTRAL)('%s is neutral', (key) => {
    expect(policyFor(key), `${key} missing from the table`).toBeTruthy();
    expect(policyFor(key)!.direction).toBe('neutral');
    expect(mayRenderVerdict(key), `${key} must not render a verdict`).toBe(false);
  });

  it('exposes exactly the neutral set', () => {
    expect([...NEUTRAL_METRICS].sort()).toEqual([...MUST_BE_NEUTRAL].sort());
  });

  it('a flag metric renders no verdict either', () => {
    // Short float is noteworthy in BOTH directions; colouring it picks a side.
    expect(policyFor('shortFloatPct')!.direction).toBe('flag');
    expect(mayRenderVerdict('shortFloatPct')).toBe(false);
  });

  it('an unknown metric is descriptive until someone decides', () => {
    expect(mayRenderVerdict('somethingNobodyClassified')).toBe(false);
  });
});

describe('arrow metrics are industry-scoped', () => {
  it.each(MUST_BE_HIGHER)('%s is higher-in-industry and marked industryOnly', (key) => {
    const p = policyFor(key)!;
    expect(p.direction).toBe('higher-in-industry');
    // A margin ranked against the whole market compares a software company
    // with a grocer, which is not a comparison.
    expect(p.industryOnly, `${key} must be industry-scoped`).toBe(true);
    expect(mayRenderVerdict(key)).toBe(true);
  });

  it('ROE carries its leverage caveat and shows D/E beside it', () => {
    const p = policyFor('roe')!;
    expect(p.caveat).toMatch(/leverage/i);
    expect(p.showBeside).toContain('debtEquity');
  });

  it('EPS growth carries its buyback caveat', () => {
    expect(policyFor('epsGrowth')!.caveat).toMatch(/buyback/i);
  });

  it('net margin carries its one-off caveat', () => {
    expect(policyFor('netMargin')!.caveat).toMatch(/one-off|write-down|disposal/i);
  });
});

describe('band metrics', () => {
  it.each(MUST_BE_BAND)('%s is a band', (key) => {
    expect(policyFor(key)!.direction).toBe('band');
  });

  it('uses the kickoff\'s stated ranges', () => {
    expect(policyFor('currentRatio')!.band).toEqual({ low: 1.2, high: 3 });
    expect(policyFor('quickRatio')!.band).toEqual({ low: 0.8, high: 3 });
    expect(policyFor('payoutRatio')!.band).toEqual({ low: 0, high: 60 });
  });

  it('excludes financials from debt/equity and non-payers from payout', () => {
    expect(policyFor('debtEquity')!.excludes).toBe('financials');
    expect(policyFor('payoutRatio')!.excludes).toBe('non-payers');
  });
});

describe('negative-denominator exclusions are declared, not implied', () => {
  it.each(['pe', 'forwardPe', 'evEbitda', 'pfcf'])('%s excludes negative denominators', (key) => {
    // A loss-making company has no meaningful P/E. Leaving it in the pool
    // either ranks it as infinitely expensive or silently drops it; the
    // policy says drop AND disclose.
    expect(policyFor(key)!.excludes).toBe('negative-denominator');
  });
});

describe('comparativePhrase never reaches for a verdict', () => {
  const BANNED = /\b(good|bad|great|poor|strong|weak|attractive|cheap enough|undervalued|overvalued|buy|sell)\b/i;

  it('describes position for every metric in the table', () => {
    for (const key of Object.keys(METRIC_POLICY)) {
      for (const pct of [0, 0.5, 0.72, 1]) {
        const phrase = comparativePhrase(key, pct);
        expect(phrase, `${key} @ ${pct}`).not.toMatch(BANNED);
        expect(phrase.length).toBeGreaterThan(0);
      }
    }
  });

  it('phrases a neutral metric as position, not judgement', () => {
    const s = comparativePhrase('pe', 0.72);
    expect(s).toMatch(/72th percentile/);
    expect(s).not.toMatch(/cheap|expensive|good|bad/i);
  });

  it('phrases an arrow metric as a comparison against peers', () => {
    expect(comparativePhrase('grossMargin', 0.72)).toMatch(/higher than 72% of industry peers/);
  });

  it('sends short float to days-to-cover rather than picking a side', () => {
    const s = comparativePhrase('shortFloatPct', 0.9);
    expect(s).toMatch(/days-to-cover/);
    expect(s).not.toMatch(/squeeze imminent|bearish signal/i);
  });
});

describe('the table is internally consistent', () => {
  it('every entry key matches its record key', () => {
    for (const [k, v] of Object.entries(METRIC_POLICY)) expect(v.key).toBe(k);
  });

  it('only band metrics declare a band', () => {
    for (const p of Object.values(METRIC_POLICY)) {
      if (p.band) expect(p.direction).toBe('band');
    }
  });

  it('every showBeside target exists in the table', () => {
    for (const p of Object.values(METRIC_POLICY)) {
      for (const other of p.showBeside ?? []) {
        expect(METRIC_POLICY[other], `${p.key} points at missing ${other}`).toBeTruthy();
      }
    }
  });
});
