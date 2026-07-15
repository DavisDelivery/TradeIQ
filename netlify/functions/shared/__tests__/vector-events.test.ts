import { describe, it, expect } from 'vitest';
import {
  computeSue, e1Agreement, resolveEventDay,
  qualifiesE2, isRoutineInsider, detectClusters, sellClusterActive,
  parseSc13dIndex, monthEnds,
  type InsiderTx,
} from '../vector-events';
import { computeFeatures, type FBar } from '../vector-features';

// ---------------------------------------------------------------------
// SUE
// ---------------------------------------------------------------------
describe('computeSue', () => {
  it('returns null under 12 quarters (hygiene) or degenerate sigma', () => {
    expect(computeSue(Array(11).fill(1))).toBeNull();
    expect(computeSue(Array(16).fill(1))).toBeNull(); // flat: sigma 0
  });

  // NOTE: noise must have a period that does NOT divide 4 — lag-4 seasonal
  // differencing cancels any period-2/period-4 pattern exactly, leaving
  // sigma 0 (degenerate => null). Period-3 noise survives differencing.
  const mk = (noise: number, jump: number) => {
    const eps: number[] = [];
    for (let i = 0; i < 16; i++) eps.push(1 + i * 0.1 + (i % 3 === 0 ? noise : i % 3 === 1 ? -noise : 0));
    eps.push(eps[12] + 0.4 + jump); // EPS_q vs EPS_{q-4} carries the surprise
    return eps;
  };

  it('computes (EPS_q - EPS_{q-4}) / sigma of the prior 8 seasonal diffs', () => {
    const sue = computeSue(mk(0.05, 1.0));
    expect(sue).not.toBeNull();
    expect(sue!).toBeGreaterThan(0); // positive surprise => positive SUE
    const negative = computeSue(mk(0.05, -1.0));
    expect(negative!).toBeLessThan(0);
  });

  it('scales with sigma: noisier history shrinks |SUE|', () => {
    const calm = computeSue(mk(0.02, 1.0));
    const noisy = computeSue(mk(0.3, 1.0));
    expect(calm).not.toBeNull();
    expect(noisy).not.toBeNull();
    expect(Math.abs(calm!)).toBeGreaterThan(Math.abs(noisy!));
  });
});

describe('e1Agreement', () => {
  it('requires all three legs at exact thresholds (1.5 / 2% / 2x)', () => {
    expect(e1Agreement(1.5, 0.02, 2)).toBe(true);
    expect(e1Agreement(1.49, 0.02, 2)).toBe(false);
    expect(e1Agreement(1.5, 0.019, 2)).toBe(false);
    expect(e1Agreement(1.5, 0.02, 1.99)).toBe(false);
    expect(e1Agreement(null, 0.02, 2)).toBe(false);
  });
});

describe('resolveEventDay', () => {
  const isTrading = (d: string) => !['2026-01-03', '2026-01-04'].includes(d); // weekend
  const next = (d: string) => {
    let cur = new Date(Date.parse(d + 'T00:00:00Z'));
    do { cur = new Date(cur.getTime() + 86_400_000); } while (!isTrading(cur.toISOString().slice(0, 10)));
    return cur.toISOString().slice(0, 10);
  };

  it('BMO on a trading day is that day; AMC is next trading day', () => {
    expect(resolveEventDay('2026-01-05', 'bmo', next, isTrading)).toBe('2026-01-05');
    expect(resolveEventDay('2026-01-05', 'amc', next, isTrading)).toBe('2026-01-06');
  });

  it('unknown hour is treated as AMC (conservative t+1)', () => {
    expect(resolveEventDay('2026-01-05', '', next, isTrading)).toBe('2026-01-06');
    expect(resolveEventDay('2026-01-05', null, next, isTrading)).toBe('2026-01-06');
  });

  it('AMC on Friday resolves across the weekend', () => {
    expect(resolveEventDay('2026-01-02', 'amc', next, isTrading)).toBe('2026-01-05');
  });
});

// ---------------------------------------------------------------------
// E2
// ---------------------------------------------------------------------
const tx = (over: Partial<InsiderTx>): InsiderTx => ({
  insiderName: 'A', code: 'P', transactionDate: '2026-01-05', filingDate: '2026-01-06',
  dollars: 50_000, isOfficerOrDirector: true, ...over,
});

describe('qualifiesE2', () => {
  it('enforces $25k, code P, officer/director, and 30d file lag', () => {
    expect(qualifiesE2(tx({}))).toBe(true);
    expect(qualifiesE2(tx({ dollars: 24_999 }))).toBe(false);
    expect(qualifiesE2(tx({ dollars: 25_000 }))).toBe(true);
    expect(qualifiesE2(tx({ code: 'S' }))).toBe(false);
    expect(qualifiesE2(tx({ isOfficerOrDirector: false }))).toBe(false);
    expect(qualifiesE2(tx({ transactionDate: '2025-12-01', filingDate: '2026-01-06' }))).toBe(false); // 36d lag
  });
});

describe('isRoutineInsider (Cohen-Malloy-Pomorski screen)', () => {
  const janBuys = (years: number[]) => years.map((y) => ({ transactionDate: `${y}-01-15` }));

  it('full screen: same month in 3 consecutive prior years => routine', () => {
    expect(isRoutineInsider('2026-01-10', janBuys([2025, 2024, 2023]), 'full')).toBe(true);
    expect(isRoutineInsider('2026-01-10', janBuys([2025, 2023, 2022]), 'full')).toBe(false); // 2024 gap
    expect(isRoutineInsider('2026-01-10', janBuys([2025, 2024]), 'full')).toBe(false); // only 2
  });

  it('reduced screen needs only 2 consecutive prior years', () => {
    expect(isRoutineInsider('2026-01-10', janBuys([2025, 2024]), 'reduced')).toBe(true);
  });

  it('different-month history is not routine', () => {
    const juneBuys = [2025, 2024, 2023].map((y) => ({ transactionDate: `${y}-06-15` }));
    expect(isRoutineInsider('2026-01-10', juneBuys, 'full')).toBe(false);
  });
});

describe('detectClusters', () => {
  it('fires on the filing date the 2nd distinct buyer appears within 90d', () => {
    const events = detectClusters([
      tx({ insiderName: 'alice', filingDate: '2026-01-10' }),
      tx({ insiderName: 'bob', filingDate: '2026-02-15', dollars: 30_000 }),
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].date).toBe('2026-02-15');
    expect(events[0].buyers.sort()).toEqual(['alice', 'bob']);
    expect(events[0].aggregateDollars).toBe(80_000);
  });

  it('same buyer twice is NOT a cluster (distinct buyers required)', () => {
    expect(detectClusters([
      tx({ insiderName: 'alice', filingDate: '2026-01-10' }),
      tx({ insiderName: 'ALICE', filingDate: '2026-02-15' }), // case-insensitive same person
    ])).toHaveLength(0);
  });

  it('buyers > 90 days apart do not cluster; a later re-cluster fires a NEW event', () => {
    const events = detectClusters([
      tx({ insiderName: 'alice', filingDate: '2026-01-10' }),
      tx({ insiderName: 'bob', filingDate: '2026-05-20' }), // 130d later: no cluster
      tx({ insiderName: 'carol', filingDate: '2026-06-01' }), // bob+carol within 90d: cluster
    ]);
    expect(events).toHaveLength(1);
    expect(events[0].date).toBe('2026-06-01');
  });

  it('a running cluster does not re-fire on every additional buy', () => {
    const events = detectClusters([
      tx({ insiderName: 'alice', filingDate: '2026-01-10' }),
      tx({ insiderName: 'bob', filingDate: '2026-01-20' }),
      tx({ insiderName: 'carol', filingDate: '2026-02-01' }),
    ]);
    expect(events).toHaveLength(1); // fired once at bob; carol extends, not re-fires
  });
});

describe('sellClusterActive', () => {
  it('needs >= 2 distinct sellers AND >= $1M aggregate in 90d', () => {
    const sells = [
      tx({ insiderName: 'x', code: 'S', dollars: 600_000, filingDate: '2026-01-05' }),
      tx({ insiderName: 'y', code: 'S', dollars: 500_000, filingDate: '2026-02-01' }),
    ];
    expect(sellClusterActive(sells, '2026-02-10')).toBe(true);
    expect(sellClusterActive(sells.slice(0, 1), '2026-02-10')).toBe(false); // 1 seller
    expect(sellClusterActive(
      sells.map((s) => ({ ...s, dollars: 400_000 })), '2026-02-10',
    )).toBe(false); // $800k < $1M
  });
});

// ---------------------------------------------------------------------
// E3 — 13D index parsing
// ---------------------------------------------------------------------
describe('parseSc13dIndex', () => {
  const IDX = [
    'Form Type   Company Name   CIK   Date Filed   File Name',
    '---------------------------------------------------------------',
    'SC 13D      ACME HOLDINGS INC             1234567     20240215    edgar/data/1234567/0001.txt',
    'SC 13D/A    OLD NEWS CORP                 7654321     20240215    edgar/data/7654321/0002.txt',
    '10-K        SOMETHING ELSE                1111111     20240215    edgar/data/1111111/0003.txt',
    'SC 13D      BETA MICRO CAP                  99887     20240215    edgar/data/99887/0004.txt',
  ].join('\n');

  it('keeps initial SC 13D rows, drops amendments and other forms', () => {
    const rows = parseSc13dIndex(IDX);
    expect(rows).toHaveLength(2);
    expect(rows[0].company).toBe('ACME HOLDINGS INC');
    expect(rows[0].cik).toBe('0001234567'); // zero-padded to 10
    expect(rows[0].dateFiled).toBe('2024-02-15');
    expect(rows[1].cik).toBe('0000099887');
  });
});

describe('monthEnds', () => {
  it('emits calendar month-ends across year boundaries incl. leap Feb', () => {
    expect(monthEnds('2023-11-01', '2024-03-01')).toEqual([
      '2023-11-30', '2023-12-31', '2024-01-31', '2024-02-29', '2024-03-31',
    ]);
  });
});

// ---------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------
describe('computeFeatures', () => {
  const mkBars = (n: number, drift = 0.001): FBar[] => {
    const out: FBar[] = [];
    let c = 100;
    for (let i = 0; i < n; i++) {
      c *= 1 + drift + (i % 3 === 0 ? 0.004 : -0.002); // deterministic wiggle
      out.push({ t: i, c, h: c * 1.01, l: c * 0.99, v: 1_000_000 + (i % 5) * 50_000 });
    }
    return out;
  };

  it('computes the full feature set on 300 bars, nulls on 30 bars', () => {
    const spy = mkBars(300, 0.0005);
    const full = computeFeatures(mkBars(300), spy);
    expect(full.sma200).not.toBeNull();
    expect(full.trendState).toBe('above200_50above'); // uptrend series
    expect(full.dist52w).toBeGreaterThan(0);
    expect(full.ivol63).not.toBeNull();
    expect(full.amihud63).not.toBeNull();
    expect(full.volumeShock).not.toBeNull();

    const thin = computeFeatures(mkBars(30), spy);
    expect(thin.sma200).toBeNull();
    expect(thin.trendState).toBeNull();
    expect(thin.ivol63).toBeNull();
    expect(thin.dist52w).toBeNull(); // < 252 bars
  });

  it('drawdown = 1 - dist52w and higherFiveDayLow tracks stabilization', () => {
    const bars = mkBars(300);
    const f = computeFeatures(bars, mkBars(300, 0.0005));
    expect(f.drawdown).toBeCloseTo(1 - (f.dist52w as number), 10);
    expect(typeof f.higherFiveDayLow).toBe('boolean');
  });
});
