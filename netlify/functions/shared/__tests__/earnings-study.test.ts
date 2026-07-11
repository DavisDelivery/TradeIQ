// FIX-2 W2 — pure event-study aggregation tests.
//
// These pin the statistics (t-stat, IC, quintiles), the event windowing
// (reaction0_1, fwdRet +2→+N, null when the window runs off the data),
// the reversal-hypothesis classification, and the pre-committed rule
// evaluation — all on fixtures with hand-checkable answers. The study's
// verdict is only as trustworthy as this math, so it is nailed down here.

import { describe, it, expect } from 'vitest';
import {
  mean,
  sampleStd,
  tStatOneSample,
  pearson,
  assignSurpriseQuintiles,
  reactionSign,
  statsForEvents,
  buildBuckets,
  reversalHypothesis,
  evaluateRule,
  assembleStudy,
  buildEvent,
  announceBarIndex,
  COST_MODEL_BPS,
  type StudyEvent,
  type StudyBar,
} from '../earnings-study';

const DAY = 86_400_000;
function barsFrom(startIso: string, closes: number[]): StudyBar[] {
  const t0 = Date.parse(`${startIso}T00:00:00Z`);
  return closes.map((c, i) => ({ t: t0 + i * DAY, c }));
}

function ev(overrides: Partial<StudyEvent> = {}): StudyEvent {
  return {
    ticker: 'TST',
    announceDate: '2022-01-10',
    surprisePct: 5,
    reaction0_1: 3,
    fwdRet5: 0.01,
    fwdRet20: 0.02,
    fwdRet60: 0.03,
    regime: 'neutral',
    ...overrides,
  };
}

describe('statistics', () => {
  it('mean + sampleStd', () => {
    expect(mean([2, 4, 6])).toBe(4);
    expect(sampleStd([2, 4, 6])).toBeCloseTo(2, 10); // n-1 var = (4+0+4)/2 = 4
    expect(sampleStd([5])).toBe(0);
  });

  it('t-stat one-sample: mean/(s/sqrt(n))', () => {
    // xs = [1,2,3,4,5]: mean 3, s = sqrt(2.5)=1.5811, n=5
    // t = 3 / (1.5811/sqrt(5)) = 3 / 0.7071 = 4.2426
    expect(tStatOneSample([1, 2, 3, 4, 5])).toBeCloseTo(4.2426, 3);
    expect(tStatOneSample([2, 2, 2])).toBe(0); // no dispersion → not significant
    expect(tStatOneSample([1])).toBe(0);
  });

  it('pearson: perfect + / perfect - / flat', () => {
    expect(pearson([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 10);
    expect(pearson([1, 2, 3], [6, 4, 2])).toBeCloseTo(-1, 10);
    expect(pearson([1, 2, 3], [5, 5, 5])).toBe(0);
  });
});

describe('assignSurpriseQuintiles', () => {
  it('splits 10 values into five 2-wide bands, low surprise = q1', () => {
    const s = [10, 9, 8, 7, 6, 5, 4, 3, 2, 1];
    const q = assignSurpriseQuintiles(s);
    // value 1 (lowest) → q1; value 10 (highest) → q5
    expect(q[s.indexOf(1)]).toBe(1);
    expect(q[s.indexOf(2)]).toBe(1);
    expect(q[s.indexOf(9)]).toBe(5);
    expect(q[s.indexOf(10)]).toBe(5);
    // each quintile has exactly 2 members
    for (let k = 1; k <= 5; k++) {
      expect(q.filter((x) => x === k).length).toBe(2);
    }
  });
});

describe('reactionSign', () => {
  it('non-negative is up, negative is down', () => {
    expect(reactionSign(0)).toBe('up');
    expect(reactionSign(0.5)).toBe('up');
    expect(reactionSign(-0.1)).toBe('down');
  });
});

describe('buildEvent — windowing', () => {
  it('reaction0_1 is close0→close1; fwdRet is +2→+N; nulls run off the end', () => {
    // day0 = index 0 (announce 2022-01-03). closes chosen for round numbers.
    // c0=100, c1=110 → reaction +10%.
    // baseIdx=+2 (c=121). fwdRet5 = close[+5]/close[+2]-1.
    const closes = [100, 110, 121, 130, 140, 150, 160];
    const bars = barsFrom('2022-01-03', closes);
    const e = buildEvent('AAA', '2022-01-03', 8, bars, 'neutral')!;
    expect(e).not.toBeNull();
    expect(e.reaction0_1).toBeCloseTo(10, 10);
    // fwdRet5: close[+5]=150 vs close[+2]=121 → 150/121-1
    expect(e.fwdRet5).toBeCloseTo(150 / 121 - 1, 10);
    // fwdRet20 & fwdRet60 run off the 7-bar array → null
    expect(e.fwdRet20).toBeNull();
    expect(e.fwdRet60).toBeNull();
  });

  it('anchors on first bar ≥ announceDate (after-close print maps to next session)', () => {
    // announce on a weekend 2022-01-08; first bar 2022-01-10.
    const bars = barsFrom('2022-01-10', [50, 55, 60, 66]);
    expect(announceBarIndex('2022-01-08', bars)).toBe(0);
    const e = buildEvent('BBB', '2022-01-08', -3, bars, 'risk_off')!;
    expect(e.reaction0_1).toBeCloseTo(10, 10); // 55/50-1
  });

  it('returns null when there is no +1 bar to measure the reaction', () => {
    const bars = barsFrom('2022-01-03', [100]); // only day0
    expect(buildEvent('CCC', '2022-01-03', 5, bars, null)).toBeNull();
  });
});

describe('statsForEvents', () => {
  it('n, means, hit rate, t-stat, IC over a small cell', () => {
    const events = [
      ev({ surprisePct: 1, fwdRet20: 0.01 }),
      ev({ surprisePct: 2, fwdRet20: 0.02 }),
      ev({ surprisePct: 3, fwdRet20: 0.03 }),
      ev({ surprisePct: 4, fwdRet20: -0.01 }),
    ];
    const s = statsForEvents(5, 'up', events);
    expect(s.n).toBe(4);
    expect(s.meanFwdRet20).toBeCloseTo((0.01 + 0.02 + 0.03 - 0.01) / 4, 10);
    expect(s.hitRate).toBe(3 / 4); // three positive of four
    expect(s.ic).not.toBeNull();
    expect(s.tStat).not.toBeNull();
  });

  it('null forward returns are excluded, not zeroed', () => {
    const events = [
      ev({ fwdRet20: 0.05 }),
      ev({ fwdRet20: null }),
      ev({ fwdRet20: 0.05 }),
    ];
    const s = statsForEvents(3, 'up', events);
    expect(s.n).toBe(3); // n counts all events...
    expect(s.meanFwdRet20).toBeCloseTo(0.05, 10); // ...but the mean skips the null
  });
});

describe('buildBuckets', () => {
  it('partitions into quintile × sign cells summing to the input n', () => {
    const events: StudyEvent[] = [];
    for (let i = 0; i < 20; i++) {
      events.push(
        ev({
          surprisePct: i - 10, // -10..9
          reaction0_1: i % 2 === 0 ? 2 : -2,
          fwdRet20: 0.01,
        }),
      );
    }
    const buckets = buildBuckets(events);
    expect(buckets.reduce((a, b) => a + b.n, 0)).toBe(20);
    // sorted by quintile then sign
    expect(buckets[0].quintile).toBe(1);
  });

  it('empty input → no buckets', () => {
    expect(buildBuckets([])).toEqual([]);
  });
});

describe('reversalHypothesis', () => {
  it('isolates gap-against-surprise and reports continuation vs reversal', () => {
    // gap up (+) on a miss (-) and gap down (-) on a beat (+): both "against".
    // Case A: gaps that keep going (continuation) → positive gap-dir mean.
    const contin = [
      ev({ surprisePct: -5, reaction0_1: 3, fwdRet20: 0.04 }), // gap up, keeps up
      ev({ surprisePct: 6, reaction0_1: -3, fwdRet20: -0.04 }), // gap down, keeps down
      ev({ surprisePct: -4, reaction0_1: 2, fwdRet20: 0.05 }),
    ];
    const r = reversalHypothesis(contin);
    expect(r.n).toBe(3);
    expect(r.verdict).toBe('continues');
    expect(r.meanFwdRetInGapDirection).toBeGreaterThan(0);
  });

  it('detects reversal when gap-against events mean-revert', () => {
    const rev = [
      ev({ surprisePct: -5, reaction0_1: 3, fwdRet20: -0.04 }), // gap up then falls
      ev({ surprisePct: 6, reaction0_1: -3, fwdRet20: 0.04 }), // gap down then rises
      ev({ surprisePct: -6, reaction0_1: 4, fwdRet20: -0.05 }),
    ];
    const r = reversalHypothesis(rev);
    expect(r.verdict).toBe('reverses');
    expect(r.meanFwdRetInGapDirection).toBeLessThan(0);
  });

  it('agreeing gap+surprise events are excluded (not "against")', () => {
    const agree = [ev({ surprisePct: 5, reaction0_1: 3 }), ev({ surprisePct: -5, reaction0_1: -3 })];
    expect(reversalHypothesis(agree).n).toBe(0);
  });
});

describe('evaluateRule — the pre-committed three-part gate', () => {
  const base = { quintile: 5, reactionSign: 'up' as const, n: 100, meanFwdRet5: null, meanFwdRet60: null, hitRate: 0.6 };

  it('survives only when |t|≥2 AND IC>0 AND edge>cost', () => {
    const s = { ...base, meanFwdRet20: 0.005, tStat: 3.1, ic: 0.04 }; // 50bps edge
    const r = evaluateRule(s, COST_MODEL_BPS.sp500); // cost 20bps
    expect(r.survives).toBe(true);
    expect(r.passStat && r.passIc && r.passEconomic).toBe(true);
    expect(r.meanEdgeBps).toBeCloseTo(50, 6);
  });

  it('significant but below cost ⇒ fails (economic gate)', () => {
    const s = { ...base, meanFwdRet20: 0.001, tStat: 4.0, ic: 0.05 }; // 10bps < 20 cost
    const r = evaluateRule(s, COST_MODEL_BPS.sp500);
    expect(r.survives).toBe(false);
    expect(r.passStat).toBe(true);
    expect(r.passEconomic).toBe(false);
  });

  it('big edge but negative IC ⇒ fails (no ranking info)', () => {
    const s = { ...base, meanFwdRet20: 0.01, tStat: 3.0, ic: -0.02 };
    expect(evaluateRule(s, COST_MODEL_BPS.sp500).survives).toBe(false);
  });

  it('big edge but |t|<2 ⇒ fails (not reliable)', () => {
    const s = { ...base, meanFwdRet20: 0.01, tStat: 1.5, ic: 0.05 };
    expect(evaluateRule(s, COST_MODEL_BPS.sp500).survives).toBe(false);
  });

  it('short-side edge survives on magnitude (abs compare)', () => {
    const s = { ...base, reactionSign: 'down' as const, meanFwdRet20: -0.006, tStat: -3.0, ic: 0.03 };
    const r = evaluateRule(s, COST_MODEL_BPS.sp500);
    expect(r.survives).toBe(true); // |−60bps| > 20, |−3| ≥ 2
  });
});

describe('assembleStudy', () => {
  it('rolls up counts, regime cuts, reversal, and the anySurvives gate', () => {
    const events: StudyEvent[] = [];
    for (let i = 0; i < 30; i++) {
      events.push(
        ev({
          ticker: `T${i % 6}`,
          surprisePct: i - 15,
          reaction0_1: i % 2 === 0 ? 2 : -2,
          fwdRet20: 0.001 * (i - 15),
          regime: i % 3 === 0 ? 'risk_on' : i % 3 === 1 ? 'neutral' : 'risk_off',
        }),
      );
    }
    const study = assembleStudy('sp500', '2018-01-31', '2024-12-31', events, 'current-membership seed');
    expect(study.eventCount).toBe(30);
    expect(study.tickerCount).toBe(6);
    expect(study.costBps).toBe(20);
    expect(study.buckets.length).toBeGreaterThan(0);
    expect(study.perRegime.risk_on.length + study.perRegime.neutral.length + study.perRegime.risk_off.length).toBeGreaterThan(0);
    expect(study.ruleByBucket.length).toBe(study.buckets.length);
    expect(typeof study.anySurvives).toBe('boolean');
    expect(study.survivorshipNote).toMatch(/seed/);
  });
});
