// FVZ-3 — published screening strategies.
//
// What these tests protect, in order of how badly it would hurt to get wrong:
//   1. The duplicate-filter-key guard. Finviz silently LAST-WINS on repeated
//      keys instead of AND-ing (measured: ta_highlow52w_a30h + _b0to10h
//      returns exactly the second filter's count). A screen that "adds" a
//      constraint could therefore silently REPLACE one and still look
//      plausible. This must throw, not shrug.
//   2. Evidence honesty. The short-squeeze screen must stay graded
//      'contrary' — the published literature says high short interest
//      predicts NEGATIVE returns — and the anecdotal screens must not
//      quietly get promoted to 'academic'.
//   3. Approximation disclosure. Where Finviz cannot express a rule (no
//      150-day MA for Minervini, no 10-day MA for Qullamaggie, only 4 of 9
//      Piotroski signals), the screen must SAY so.

import { describe, it, expect } from 'vitest';
import { SCREENS, SCREENS_BY_ID, applyScreen, type ScreenDef } from '../finviz-screens';
import { assertNoDuplicateFilterKeys, finvizFilterKey, type FinvizRow } from '../finviz';

const row = (over: Partial<FinvizRow>): FinvizRow =>
  ({
    ticker: 'TEST',
    sector: 'Technology',
    marketCapM: 50_000,
    pe: 20,
    forwardPe: 18,
    peg: 1.5,
    dividendYieldPct: 1,
    epsGrowthThisYearPct: 10,
    epsGrowthNextYearPct: 10,
    epsGrowthNext5YPct: 10,
    epsGrowthQoQPct: 10,
    salesGrowthQoQPct: 10,
    insiderOwnPct: 1,
    instOwnPct: 70,
    shortFloatPct: 3,
    roePct: 20,
    debtToEquity: 0.3,
    grossMarginPct: 50,
    profitMarginPct: 20,
    perfWeekPct: 1,
    perfMonthPct: 5,
    perfYearPct: 20,
    sma20DistPct: 2,
    sma50DistPct: 5,
    sma200DistPct: 10,
    high52wDistPct: -5,
    low52wDistPct: 40,
    rsi14: 55,
    analystRecom: 2,
    avgVolume: 5000,
    relVolume: 1,
    price: 100,
    changePct: 0.5,
    volume: 5_000_000,
    earningsDate: null,
    earningsSession: null,
    targetPrice: 120,
    ps: 3,
    pb: 4,
    payoutRatioPct: 20,
    epsGrowthPast5YPct: 15,
    floatM: 500,
    insiderTransPct: 0,
    shortRatio: 2,
    roaPct: 10,
    roicPct: 25,
    currentRatio: 2,
    perfQuarterPct: 10,
    beta: 1.1,
    atr: 2,
    ...over,
  }) as FinvizRow;

describe('duplicate filter-key guard (silent last-wins corruption)', () => {
  it('extracts the filter family', () => {
    expect(finvizFilterKey('ta_highlow52w_b0to10h')).toBe('ta_highlow52w');
    expect(finvizFilterKey('fa_pe_u15')).toBe('fa_pe');
    expect(finvizFilterKey('idx_sp500')).toBe('idx_sp500');
  });

  it('throws on a repeated family rather than silently dropping one', () => {
    expect(() =>
      assertNoDuplicateFilterKeys(['ta_highlow52w_a30h', 'ta_highlow52w_b0to10h']),
    ).toThrow(/duplicate filter family 'ta_highlow52w'/);
  });

  it('allows ta_perf + ta_perf2 — two INDEPENDENT slots that really do AND', () => {
    expect(() => assertNoDuplicateFilterKeys(['ta_perf_4w20o', 'ta_perf2_13w30o'])).not.toThrow();
  });

  it('EVERY shipped screen has conflict-free filters', () => {
    for (const s of SCREENS) {
      expect(() => assertNoDuplicateFilterKeys(s.filters), `screen ${s.id}`).not.toThrow();
    }
  });

  it('screen filters stay conflict-free once the universe filter is prepended', () => {
    // This is how screens-board actually calls it — a screen that carried its
    // own idx_ filter would collide with the requested universe.
    for (const s of SCREENS) {
      expect(() => assertNoDuplicateFilterKeys(['idx_sp500', ...s.filters]), `screen ${s.id}`).not.toThrow();
    }
  });
});

describe('evidence honesty', () => {
  it('the short-squeeze screen is graded CONTRARY and says so', () => {
    const s = SCREENS_BY_ID.get('short-squeeze')!;
    expect(s.evidence).toBe('contrary');
    expect(s.evidenceNote).toMatch(/NEGATIVE/);
  });

  it('Minervini and Qullamaggie are ANECDOTAL, not academic', () => {
    expect(SCREENS_BY_ID.get('minervini')!.evidence).toBe('anecdotal');
    expect(SCREENS_BY_ID.get('qullamaggie')!.evidence).toBe('anecdotal');
  });

  it('the academic screens cite a source', () => {
    for (const s of SCREENS.filter((x) => x.evidence === 'academic')) {
      expect(s.source, `screen ${s.id}`).toBeTruthy();
    }
  });

  it('every screen carries a non-trivial evidence note', () => {
    for (const s of SCREENS) {
      expect(s.evidenceNote.length, `screen ${s.id}`).toBeGreaterThan(60);
    }
  });

  it('screens that cannot reproduce their published rules disclose it', () => {
    // These three are the ones with known, measured vocabulary gaps.
    for (const id of ['minervini', 'qullamaggie', 'piotroski', 'magic-formula']) {
      const s = SCREENS_BY_ID.get(id)!;
      expect(s.approximations?.length, `screen ${id}`).toBeGreaterThan(0);
    }
  });

  it('Piotroski does not claim to be an F-Score', () => {
    const s = SCREENS_BY_ID.get('piotroski')!;
    expect(s.approximations!.join(' ')).toMatch(/not an F-Score/i);
  });
});

describe('applyScreen', () => {
  const screen = (over: Partial<ScreenDef>): ScreenDef => ({
    id: 't',
    name: 'T',
    thesis: 't',
    popularizedBy: 't',
    evidence: 'academic',
    evidenceNote: 'x'.repeat(70),
    filters: [],
    ...over,
  });

  it('filters by predicate and reports the universe it checked', () => {
    const res = applyScreen(
      screen({ predicate: (r) => (r.pe ?? 99) < 15 }),
      [row({ ticker: 'A', pe: 10 }), row({ ticker: 'B', pe: 30 })],
    );
    expect(res.rows.map((r) => r.ticker)).toEqual(['A']);
    expect(res.universeChecked).toBe(2);
  });

  it('ranks best-first and caps at take', () => {
    const res = applyScreen(
      screen({ rank: (r) => r.perfYearPct, take: 2 }),
      [
        row({ ticker: 'LOW', perfYearPct: 5 }),
        row({ ticker: 'HIGH', perfYearPct: 90 }),
        row({ ticker: 'MID', perfYearPct: 40 }),
      ],
    );
    expect(res.rows.map((r) => r.ticker)).toEqual(['HIGH', 'MID']);
  });

  it('rows missing the rank value sort LAST but are not dropped', () => {
    const res = applyScreen(
      screen({ rank: (r) => r.perfYearPct }),
      [row({ ticker: 'NULL', perfYearPct: null }), row({ ticker: 'REAL', perfYearPct: 3 })],
    );
    expect(res.rows.map((r) => r.ticker)).toEqual(['REAL', 'NULL']);
  });

  it('an empty result is a legitimate answer, not an error', () => {
    const res = applyScreen(screen({ predicate: () => false }), [row({}), row({})]);
    expect(res.rows).toEqual([]);
    expect(res.universeChecked).toBe(2);
  });

  it('never mutates the caller\'s universe array', () => {
    const universe = [row({ ticker: 'A', perfYearPct: 1 }), row({ ticker: 'B', perfYearPct: 9 })];
    applyScreen(screen({ rank: (r) => r.perfYearPct }), universe);
    expect(universe.map((r) => r.ticker)).toEqual(['A', 'B']);
  });
});

describe('screen predicates behave as documented', () => {
  it('Magic Formula excludes financials and utilities (Greenblatt\'s carve-out)', () => {
    const s = SCREENS_BY_ID.get('magic-formula')!;
    const base = { roicPct: 30, pe: 10, marketCapM: 5000, avgVolume: 5000 };
    expect(s.predicate!(row({ ...base, sector: 'Technology' }))).toBe(true);
    expect(s.predicate!(row({ ...base, sector: 'Financial' }))).toBe(false);
    expect(s.predicate!(row({ ...base, sector: 'Utilities' }))).toBe(false);
  });

  it('Tiny Titans honours the $25-250M band that no cap_ filter matches', () => {
    const s = SCREENS_BY_ID.get('tiny-titans')!;
    const base = { ps: 0.5, price: 10, avgVolume: 200 };
    expect(s.predicate!(row({ ...base, marketCapM: 100 }))).toBe(true);
    expect(s.predicate!(row({ ...base, marketCapM: 20 }))).toBe(false); // below band
    expect(s.predicate!(row({ ...base, marketCapM: 400 }))).toBe(false); // above band
  });

  it('52-week-high screen ranks nearest-to-high first', () => {
    const s = SCREENS_BY_ID.get('high52w')!;
    const res = applyScreen(s, [
      row({ ticker: 'FAR', high52wDistPct: -9 }),
      row({ ticker: 'NEAR', high52wDistPct: -1 }),
      row({ ticker: 'OUT', high52wDistPct: -40 }),
    ]);
    expect(res.rows.map((r) => r.ticker)).toEqual(['NEAR', 'FAR']);
  });

  it('low-volatility screen ranks lowest beta first and rejects high beta', () => {
    const s = SCREENS_BY_ID.get('lowvol')!;
    expect(s.predicate!(row({ beta: 0.4 }))).toBe(true);
    expect(s.predicate!(row({ beta: 1.6 }))).toBe(false);
    const res = applyScreen(s, [row({ ticker: 'B9', beta: 0.9 }), row({ ticker: 'B3', beta: 0.3 })]);
    expect(res.rows.map((r) => r.ticker)).toEqual(['B3', 'B9']);
  });

  it('a null field never counts as passing a numeric threshold', () => {
    // The guard against `(x ?? 0) > n` style bugs — the exact class that made
    // both earnings volatility strategies unreachable earlier this year.
    const s = SCREENS_BY_ID.get('lowvol')!;
    expect(s.predicate!(row({ beta: null }))).toBe(false);
    expect(s.predicate!(row({ roePct: null }))).toBe(false);
    expect(SCREENS_BY_ID.get('piotroski')!.predicate!(row({ pb: null }))).toBe(false);
  });
});

describe('catalog integrity', () => {
  it('ids are unique and index correctly', () => {
    expect(SCREENS_BY_ID.size).toBe(SCREENS.length);
  });

  it('every screen is either post-fetch-only or declares real filters', () => {
    for (const s of SCREENS) {
      expect(s.predicate || s.filters.length > 0, `screen ${s.id} does nothing`).toBeTruthy();
    }
  });
});
