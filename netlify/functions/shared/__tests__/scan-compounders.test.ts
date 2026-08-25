// COMP-1 — the Compounders SCAN, i.e. the wiring rather than the scoring.
//
// compounders.test.ts guards the scoring core. What is unguarded, and what
// the QS post-mortem says actually breaks, is the assembly around it: the
// first Quiet Strength production run scored 0 of 1851 names because the
// function that WIRED four well-tested modules together had no test of its
// own. So these drive the real runCompoundersScan through injected
// providers, and the real worker through a mocked store.
//
// Three things here are load-bearing enough to be stated as tests:
//
//   1. THE SKIP. A 12-1 momentum that quietly includes the most recent month
//      is a different (and dead) signal. The test gives the skipped month a
//      spike and asserts it changes nothing.
//   2. THE FUNNEL. Statements cost two calls a name, so only finalists may
//      be fetched — and a name the universe policy excludes must never cost
//      one at all.
//   3. THE BASIS. A board that degraded to the ROE proxy must say so and
//      must not promote. Mixing the two bases in one ranking is the failure
//      mode this refuses.

import { WINDOW_MONTHS } from '../residual-momentum';
import type { MassiveIncomeStatement } from '../schemas';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { GroupedRow } from '../vector-data';
import type { FinvizRow } from '../finviz';
import type { CompounderInput } from '../compounders';
import { MIN_MEDIAN_DOLLAR_VOL } from '../research-policy';

const mocks = vi.hoisted(() => ({
  runScan: vi.fn(),
  writeSnapshot: vi.fn(),
}));

// Only the entry point is replaced; every pure helper below is the real one.
vi.mock('../scan-compounders', async () => {
  const actual = await vi.importActual<any>('../scan-compounders');
  return { ...actual, runCompoundersScan: mocks.runScan };
});

vi.mock('../snapshot-store', async () => {
  const actual = await vi.importActual<any>('../snapshot-store');
  return { ...actual, writeSnapshot: mocks.writeSnapshot };
});

vi.mock('../logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

import {
  momentumWindow,
  selectFinalists,
  ttmGrossProfit,
  latestTotalAssets,
  resolveQualityBasis,
  buildCompoundersBanner,
  MOMENTUM_MONTHS,
  MOMENTUM_SKIP_MONTHS,
  MIN_EXACT_BASIS_SHARE,
  UNKNOWN_PROVISIONAL_PCT,
  GROSS_EDGE_PP,
  type CompounderRow,
  type RunCompoundersOpts,
  type RunCompoundersResult,
  windowSpanMonths,} from '../scan-compounders';

// The genuine scan, so the funnel tests exercise the code that ships.
const { runCompoundersScan } = await vi.importActual<typeof import('../scan-compounders')>(
  '../scan-compounders',
);

import { handler } from '../../scan-compounders-background';

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

describe('the momentum window skips the most recent month', () => {
  it('ends one month before the last COMPLETE month', () => {
    const w = momentumWindow(new Date('2026-08-22T21:40:00Z'));
    // August is in flight, July is complete — and July is what the skip drops.
    expect(w.skippedYm).toBe(202607);
    expect(w.endYm).toBe(202606);
    expect(w.startYm).toBe(202507);
  });

  it('matches the house 12-1 window — eleven returns, t-12 to t-2', () => {
    // residual-momentum.ts is the standard: WINDOW_START_LAG 12,
    // WINDOW_END_LAG 2, WINDOW_MONTHS 11. This span was briefly twelve
    // returns, which meant this board and Quiet Strength printed a column
    // labelled "12-1" over different windows. Pinned against the shared
    // constants rather than a literal so the two cannot drift again.
    for (const iso of ['2026-08-22T21:40:00Z', '2027-01-15T21:40:00Z', '2026-01-02T21:40:00Z']) {
      const w = momentumWindow(new Date(iso));
      const months =
        (Math.floor(w.endYm / 100) - Math.floor(w.startYm / 100)) * 12 +
        ((w.endYm % 100) - (w.startYm % 100));
      expect(months, `span wrong at ${iso}`).toBe(WINDOW_MONTHS);
      expect(w.skippedYm, `skip wrong at ${iso}`).not.toBe(w.endYm);
    }
  });

  it('the return span equals the window, so the anchors and the maths agree', () => {
    // The bug this pins: momentumWindow chose anchors t-12 and t-2 while
    // trailingReturnPct derived its own start as endYm - MOMENTUM_MONTHS,
    // asking for a month that was never fetched. Every name scored momentum
    // null and the board came back empty with no warning.
    for (const iso of ['2026-08-22T21:40:00Z', '2027-01-15T21:40:00Z', '2026-01-02T21:40:00Z']) {
      expect(windowSpanMonths(momentumWindow(new Date(iso)))).toBe(WINDOW_MONTHS);
    }
  });

  it('scores the same window Quiet Strength scores', () => {
    // The concrete case from the review: at 2026-08-22 this must be
    // 202507..202606, not 202506..202606.
    const w = momentumWindow(new Date('2026-08-22T21:40:00Z'));
    expect(w.startYm).toBe(202507);
    expect(w.endYm).toBe(202606);
    expect(w.skippedYm).toBe(202607);
  });

  it('drops exactly one month, not zero and not two', () => {
    expect(MOMENTUM_SKIP_MONTHS).toBe(1);
    const w = momentumWindow(new Date('2027-01-15T21:40:00Z'));
    expect(w.skippedYm).toBe(202612);
    expect(w.endYm).toBe(202611);
  });
});

// ---------------------------------------------------------------------------
// The funnel's ordering
// ---------------------------------------------------------------------------

const input = (over: Partial<CompounderInput> & { ticker: string }): CompounderInput => ({
  marketCapM: 50_000,
  medianDollarVol: 500_000_000,
  price: 100,
  ...over,
});

describe('finalist selection', () => {
  it('takes the best by the provisional blend, not the first N', () => {
    const candidates = Array.from({ length: 10 }, (_, i) =>
      input({ ticker: `T${i}`, roePct: i, momentum12_1Pct: i }),
    );
    const picked = selectFinalists(candidates, 3).map((c) => c.ticker);
    expect(picked).toEqual(['T9', 'T8', 'T7']);
  });

  it('uses the same weights the real score uses, so the funnel points the right way', () => {
    // High quality / low momentum beats low quality / high momentum, because
    // QUALITY_WEIGHT > MOMENTUM_WEIGHT. If the funnel were momentum-led it
    // would starve the axis the board leads on.
    const candidates = [
      input({ ticker: 'QUAL', roePct: 100, momentum12_1Pct: -50 }),
      input({ ticker: 'MOM', roePct: -50, momentum12_1Pct: 100 }),
      input({ ticker: 'MID', roePct: 0, momentum12_1Pct: 0 }),
    ];
    expect(selectFinalists(candidates, 1)[0].ticker).toBe('QUAL');
  });

  it('treats a missing input as the MIDDLE, so an absent cell is not a permanent exclusion', () => {
    // A name with no ROE but real momentum must still be able to reach the
    // statement stage — otherwise one blank Finviz cell decides, forever,
    // that the exact basis is never fetched for it.
    const candidates = [
      input({ ticker: 'NOROE', roePct: null, momentum12_1Pct: 90 }),
      input({ ticker: 'LOW', roePct: -100, momentum12_1Pct: -100 }),
      input({ ticker: 'HIGH', roePct: 100, momentum12_1Pct: 100 }),
    ];
    const picked = selectFinalists(candidates, 2).map((c) => c.ticker);
    expect(picked).toContain('NOROE');
    expect(picked).not.toContain('LOW');
    expect(UNKNOWN_PROVISIONAL_PCT).toBe(0.5);
  });

  it('breaks ties on ticker, so which names get statements does not churn nightly', () => {
    const tied = ['C', 'A', 'B'].map((t) => input({ ticker: t, roePct: 5, momentum12_1Pct: 5 }));
    expect(selectFinalists(tied, 2).map((c) => c.ticker)).toEqual(['A', 'B']);
    expect(selectFinalists([...tied].reverse(), 2).map((c) => c.ticker)).toEqual(['A', 'B']);
  });

  it('never returns more than the universe holds', () => {
    const two = [input({ ticker: 'A' }), input({ ticker: 'B' })];
    expect(selectFinalists(two, 250)).toHaveLength(2);
    expect(selectFinalists(two, 0)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// The statement derivations
// ---------------------------------------------------------------------------

const quarters = (values: Array<number | null>) =>
  // A gross profit is only usable when the filer reports a cost line, so the
  // helper models one: revenue = 2.5x gross profit, the rest is COGS.
  values.map((gross_profit, i) => ({
    gross_profit,
    // A null gross profit stays null across the row — the point of those
    // cases is a quarter with no usable statement at all.
    revenue: gross_profit === null ? null : gross_profit * 2.5,
    cost_of_revenue: gross_profit === null ? null : gross_profit * 1.5,
    period_end: `2026-0${6 - i}-30`,
  })) as any[];

describe('TTM gross profit is all four quarters or nothing', () => {
  it('sums the four most recent quarters', () => {
    expect(ttmGrossProfit(quarters([10, 20, 30, 40, 50]))).toBe(100);
  });

  it('refuses a short history rather than reporting a part-year as a year', () => {
    expect(ttmGrossProfit(quarters([10, 20, 30]))).toBeNull();
  });

  it('refuses when any quarter in the window is missing the line item', () => {
    // Summing what is present would halve the numerator and drop the name
    // down the board for a data reason no reader could see.
    expect(ttmGrossProfit(quarters([10, null, 30, 40]))).toBeNull();
  });
});

describe('total assets is a stock, taken from the latest sheet', () => {
  it('reads the most recent balance sheet only', () => {
    expect(latestTotalAssets([{ total_assets: 500 }, { total_assets: 400 }] as any)).toBe(500);
  });

  it('refuses missing or non-positive denominators', () => {
    expect(latestTotalAssets([] as any)).toBeNull();
    expect(latestTotalAssets([{ total_assets: 0 }] as any)).toBeNull();
    expect(latestTotalAssets([{ total_assets: null }] as any)).toBeNull();
  });
});

describe('the quality basis is all-or-nothing', () => {
  it('stays exact while coverage clears the threshold', () => {
    expect(resolveQualityBasis(60, 100)).toBe('exact');
    expect(resolveQualityBasis(100, 100)).toBe('exact');
  });

  it('falls to the proxy for the WHOLE pool once coverage breaks', () => {
    // Not "the proxy for the ones that failed": percentileRank ranks one list
    // of numbers, and a ratio (~0.4) and a percent (~25) are not the same
    // scale. A mixed pool puts every proxy name above every exact name.
    expect(resolveQualityBasis(59, 100)).toBe('roe-proxy');
    expect(resolveQualityBasis(0, 100)).toBe('roe-proxy');
    expect(MIN_EXACT_BASIS_SHARE).toBe(0.6);
  });

  it('does not divide by zero on an empty finalist set', () => {
    expect(resolveQualityBasis(0, 0)).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// The banner
// ---------------------------------------------------------------------------

describe('the banner tells the truth about what has been measured', () => {
  it('publishes no edge figure, because none has been measured', () => {
    const b = buildCompoundersBanner();
    expect(GROSS_EDGE_PP).toBeNull();
    expect(b.netEdgeLowPp).toBeNull();
    expect(b.netEdgeHighPp).toBeNull();
    expect(b.headline).toMatch(/UNMEASURED/);
    expect(b.discovery).toMatch(/NOT MEASURED/);
  });

  it('states the value-axis departure rather than leaving it implicit', () => {
    expect(buildCompoundersBanner().departure).toMatch(/value/i);
    expect(buildCompoundersBanner().grade).toBe('axes-replicated-blend-unmeasured');
  });
});

// ---------------------------------------------------------------------------
// The scan, end to end, on injected providers
// ---------------------------------------------------------------------------

const NOW = new Date('2026-08-22T21:40:00Z');
const START_YM = 202507;   // house 12-1 window: t-12 = 202507 at 2026-08-22
const END_YM = 202606;
const SKIPPED_YM = 202607;

interface Fixture {
  ticker: string;
  startClose: number;
  endClose: number;
  /** The month the skip must ignore. */
  skipClose: number;
  roePct: number | null;
  grossProfit: number | null;
  price?: number;
  avgVolume?: number;
  marketCapM?: number;
}

const fixtures = (n: number): Fixture[] =>
  Array.from({ length: n }, (_, i) => ({
    ticker: `T${String(i).padStart(2, '0')}`,
    startClose: 100,
    endClose: 100 + i,          // momentum spreads 0%..(n-1)%
    skipClose: 1_000 - i * 10,  // deliberately the OPPOSITE ordering
    roePct: 5 + i,
    grossProfit: 10 + i,
  }));

function harness(rows: Fixture[], opts: { failStatementsFor?: (t: string) => boolean } = {}) {
  const groupedDates: string[] = [];
  const incomeCalls: string[] = [];
  const balanceCalls: string[] = [];

  const universe = (): FinvizRow[] =>
    rows.map((r) => ({
      ticker: r.ticker,
      sector: 'Technology',
      industry: 'Semiconductors',
      marketCapM: r.marketCapM ?? 50_000,
      avgVolume: r.avgVolume ?? 5_000_000,
      price: r.price ?? 100,
      roePct: r.roePct,
    }) as unknown as FinvizRow);

  const closeFor = (ym: number, r: Fixture): number | null =>
    ym === START_YM ? r.startClose : ym === END_YM ? r.endClose : ym === SKIPPED_YM ? r.skipClose : null;

  const grouped = async (date: string): Promise<GroupedRow[]> => {
    groupedDates.push(date);
    const ym = Number(date.slice(0, 4) + date.slice(5, 7));
    const out: GroupedRow[] = [];
    for (const r of rows) {
      const c = closeFor(ym, r);
      if (c === null) continue;
      out.push({ T: r.ticker, c, h: c, l: c, o: c, v: 1_000_000, t: 0 });
    }
    return out;
  };

  const income = async (ticker: string) => {
    incomeCalls.push(ticker);
    const r = rows.find((x) => x.ticker === ticker)!;
    if (opts.failStatementsFor?.(ticker)) {
      return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: 'boom' } as any;
    }
    return {
      data: Array.from({ length: 4 }, () => {
        const gp = (r.grossProfit ?? 0) / 4;
        // Real statements carry revenue and a cost line; without them the
        // scan (correctly) refuses to treat the figure as gross profit.
        return { gross_profit: gp, revenue: gp * 2.5, cost_of_revenue: gp * 1.5 };
      }),
      rateLimited: false,
      rateLimitExhausted: false,
    } as any;
  };

  const balance = async (ticker: string) => {
    balanceCalls.push(ticker);
    if (opts.failStatementsFor?.(ticker)) {
      return { data: [], rateLimited: false, rateLimitExhausted: false, errorMessage: 'boom' } as any;
    }
    return { data: [{ total_assets: 100 }], rateLimited: false, rateLimitExhausted: false } as any;
  };

  return { groupedDates, incomeCalls, balanceCalls, universe, grouped, income, balance };
}

const run = (h: ReturnType<typeof harness>, over: Partial<RunCompoundersOpts> = {}) =>
  runCompoundersScan({
    now: NOW,
    finalists: 5,
    getUniverse: async () => h.universe(),
    getGrouped: h.grouped,
    getIncome: h.income,
    getBalance: h.balance,
    ...over,
  });

describe('the scan scores names, on the window it claims', () => {
  it('never asks for a close in the skipped month', async () => {
    const h = harness(fixtures(12));
    await run(h);
    const monthsAsked = new Set(h.groupedDates.map((d) => Number(d.slice(0, 4) + d.slice(5, 7))));
    expect(monthsAsked).toEqual(new Set([START_YM, END_YM]));
  });

  it('reports the 12-1 return, not the trailing-12m return', async () => {
    // Every fixture's skipped month is ordered the OPPOSITE way to its 12-1
    // return, so a scan that included it would invert the board.
    const h = harness(fixtures(12));
    const res = await run(h);
    const byTicker = new Map(res.rows.map((r) => [r.ticker, r]));
    expect(byTicker.get('T11')!.momentum12_1Pct).toBeCloseTo(11, 6);
    expect(res.rows[0].ticker).toBe('T11');
    expect(res.momentumStartYm).toBe(START_YM);
    expect(res.momentumEndYm).toBe(END_YM);
    expect(res.momentumSkippedYm).toBe(SKIPPED_YM);
  });

  it('ranks best-first with dense ranks — the league logs by array position', async () => {
    const h = harness(fixtures(12));
    const res = await run(h);
    expect(res.rows.map((r) => r.rank)).toEqual(res.rows.map((_, i) => i + 1));
    for (let i = 1; i < res.rows.length; i++) {
      expect(res.rows[i - 1].composite).toBeGreaterThanOrEqual(res.rows[i].composite);
    }
  });
});

describe('the funnel spends statement calls only where it is allowed to', () => {
  it('fetches statements for the finalists and nobody else', async () => {
    const h = harness(fixtures(12));
    const res = await run(h);
    expect(res.finalistCount).toBe(5);
    expect(new Set(h.incomeCalls).size).toBe(5);
    expect(h.incomeCalls).toEqual(h.balanceCalls);
    expect(res.statementCalls).toBe(10); // 2 per finalist
    // Every name on the board was fetched. The reverse does NOT hold: the
    // junk-momentum floor (compounders.MIN_QUALITY_PCT) cuts the bottom
    // quartile of the pool, so a fetched finalist can still be unscorable.
    for (const r of res.rows) expect(h.incomeCalls).toContain(r.ticker);
    expect(res.scored + res.unscorableCounts['below-quality-floor']).toBe(5);
  });

  it('spends nothing on names the universe policy already excludes', async () => {
    const rows = fixtures(6);
    rows[0].price = 2;                                    // price floor
    rows[1].marketCapM = 100;                             // microcap
    // Illiquid at $100/share. avgVolume is THOUSANDS of shares, so the floor
    // divides by 1000 as well as by price — the earlier line omitted that and
    // therefore described a name 1000x more liquid than it claimed to.
    rows[2].avgVolume = MIN_MEDIAN_DOLLAR_VOL / 100 / 1_000 / 100;
    const h = harness(rows);
    const res = await run(h);

    for (const t of ['T00', 'T01', 'T02']) expect(h.incomeCalls).not.toContain(t);
    expect(res.excludedCounts['price-floor']).toBe(1);
    expect(res.excludedCounts.microcap).toBe(1);
    expect(res.excludedCounts.illiquid).toBe(1);
    expect(res.universeSize).toBe(6);
    expect(res.universeChecked).toBe(6);   // the universe
    expect(res.finalistsScored).toBe(3);   // what actually reached scoring
  });

  it('stops starting fetches when the budget is gone, and says so', async () => {
    const h = harness(fixtures(12));
    const res = await run(h, { scanBudgetMs: 0 });
    expect(res.budgetExceeded).toBe(true);
    expect(res.warnings.join(' ')).toMatch(/budget exceeded/);
    expect(h.incomeCalls).toHaveLength(0);
  });
});

describe('the quality basis is uniform across the board, or the board says so', () => {
  it('uses the exact Novy-Marx basis when the statements are there', async () => {
    const h = harness(fixtures(12));
    const res = await run(h);
    expect(res.qualityBasis).toBe('exact');
    expect(res.exactBasisCount).toBe(res.scored);
    for (const row of res.rows) {
      expect(row.qualityBasis).toBe('gross-profits-to-assets');
      expect(row.grossProfitability).not.toBeNull();
    }
  });

  it('leaves a name unscorable rather than letting a proxy leapfrog the pool', async () => {
    // One failed fetch out of five keeps the board on the exact basis. The
    // failed name must NOT be ranked on ROE: its percent-scaled value would
    // sit above every ratio in the pool and take the top of the board.
    const h = harness(fixtures(12), { failStatementsFor: (t) => t === 'T11' });
    const res = await run(h);
    expect(res.qualityBasis).toBe('exact');
    expect(res.rows.map((r) => r.ticker)).not.toContain('T11');
    expect(res.unscorableCounts['no-quality']).toBe(1);
    expect(res.warnings.join(' ')).toMatch(/no usable statements/);
    for (const row of res.rows) expect(row.qualityBasis).toBe('gross-profits-to-assets');
  });

  it('falls back to the proxy for EVERYONE when coverage collapses, and warns', async () => {
    const h = harness(fixtures(12), { failStatementsFor: (t) => t !== 'T11' });
    const res = await run(h);
    expect(res.qualityBasis).toBe('roe-proxy');
    expect(res.exactBasisCount).toBe(0);
    expect(res.warnings.join(' ')).toMatch(/ROE proxy/);
    for (const row of res.rows) {
      expect(row.qualityBasis).toBe('roe-proxy');
      // No exact ratio is displayed on a proxy-scored row.
      expect(row.grossProfitability).toBeNull();
    }
    expect(res.statementErrors).toBeGreaterThan(0);
  });

  it('warns and scores nothing when the universe fetch comes back empty', async () => {
    const res = await runCompoundersScan({
      now: NOW,
      getUniverse: async () => null,
      getGrouped: async () => [],
      getIncome: async () => ({ data: [], rateLimited: false, rateLimitExhausted: false }) as any,
      getBalance: async () => ({ data: [], rateLimited: false, rateLimitExhausted: false }) as any,
    });
    expect(res.warnings.join(' ')).toMatch(/universe fetch returned no rows/);
    expect(res.rows).toHaveLength(0);
    expect(res.scored).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The worker's publication rules
// ---------------------------------------------------------------------------

const scanResult = (over: Partial<RunCompoundersResult> = {}): RunCompoundersResult => {
  const rows: CompounderRow[] = Array.from({ length: 10 }, (_, i) => ({
    rank: i + 1,
    ticker: `T${i}`,
    sector: 'Technology',
    composite: 1 - i / 20,
    qualityPct: 0.9,
    momentumPct: 0.8,
    grossProfitability: 0.4,
    momentum12_1Pct: 12,
    qualityBasis: 'gross-profits-to-assets',
  }));
  return {
    rows,
    banner: buildCompoundersBanner(),
    universeSize: 600,
    // The UNIVERSE, not the finalists. The earlier fixture set this to 250 —
    // the finalist count — which meant the "hollow run" test below fed the
    // publish guard a healthy denominator it could never see in the outage it
    // was supposed to cover, and looked like coverage of the open case.
    universeChecked: 600,
    finalistsScored: 250,
    universeLegsRequested: 3,
    universeLegsAnswered: 3,
    scored: rows.length,
    excludedCounts: { microcap: 1, illiquid: 2, 'price-floor': 0, 'no-data': 3 },
    unscorableCounts: { 'no-quality': 4, 'no-momentum': 1, 'below-quality-floor': 7 },
    exactBasisCount: rows.length,
    qualityBasis: 'exact',
    finalistCount: 250,
    momentumStartYm: START_YM,
    momentumEndYm: END_YM,
    momentumSkippedYm: SKIPPED_YM,
    datesFetched: 2,
    statementCalls: 500,
    statementErrors: 0,
    statementRateLimited: 0,
    warnings: [],
    budgetExceeded: false,
    scanDurationMs: 1234,
    ...over,
  };
};

const post = () => ({ httpMethod: 'POST', body: '{}', queryStringParameters: {} }) as any;
const written = () => mocks.writeSnapshot.mock.calls[0][2] as any;

describe('the worker publishes only what it can stand behind', () => {
  beforeEach(() => {
    mocks.runScan.mockReset();
    mocks.writeSnapshot.mockReset();
    mocks.writeSnapshot.mockResolvedValue({ snapshotId: 'compounders-test', promotedToLatest: true });
  });

  it('writes a complete snapshot on a clean run', async () => {
    mocks.runScan.mockResolvedValue(scanResult());
    const res = (await handler(post(), {} as any)) as any;
    expect(res.statusCode).toBe(200);
    expect(written().status).toBe('complete');
  });

  it('marks partial when the scan blew its budget', async () => {
    mocks.runScan.mockResolvedValue(scanResult({ budgetExceeded: true }));
    await handler(post(), {} as any);
    expect(written().status).toBe('partial');
  });

  it('marks partial when most scored names fell back to the proxy', async () => {
    // Every provider answered and the scan finished — but the board is no
    // longer the measurement it advertises, so it must not become canonical.
    mocks.runScan.mockResolvedValue(
      scanResult({ exactBasisCount: 5, scored: 10, qualityBasis: 'roe-proxy' }),
    );
    await handler(post(), {} as any);
    const doc = written();
    expect(doc.status).toBe('partial');
    expect(doc.warnings.join(' ')).toMatch(/exact gross-profits-to-assets basis/);
  });

  it('keeps a run at the threshold complete — the rule is "fewer than", not "at most"', async () => {
    mocks.runScan.mockResolvedValue(scanResult({ exactBasisCount: 6, scored: 10 }));
    await handler(post(), {} as any);
    expect(written().status).toBe('complete');
  });

  it('defers to the publish guard when the run came back hollow', async () => {
    mocks.runScan.mockResolvedValue(scanResult({ rows: [], scored: 0, exactBasisCount: 0 }));
    await handler(post(), {} as any);
    const doc = written();
    expect(doc.status).toBe('partial');
    expect(doc.warnings.join(' ')).toMatch(/publish guard/);
  });

  it('carries the contract fields — banner, rows and the basis count — into the snapshot', async () => {
    mocks.runScan.mockResolvedValue(scanResult());
    await handler(post(), {} as any);
    const doc = written();
    expect(doc.banner.discovery).toMatch(/NOT MEASURED/);
    // No parallel `rows` array: writeSnapshot's 1 MiB trim only trims
    // `results`, so a second copy escapes it, keeps the doc over the ceiling
    // and makes `truncated: true` a lie. The endpoint reads `results`.
    expect(doc.rows).toBeUndefined();
    // `results` is the single ranked array: the snapshot infrastructure, the
    // PIT readers and the forward league all read it, and the board endpoint
    // falls back to it.
    expect(doc.results).toHaveLength(10);
    expect(doc.exactBasisCount).toBe(10);
    expect(doc.universeSize).toBe(600);
    expect(doc.unscorableCounts['below-quality-floor']).toBe(7);
    expect(mocks.writeSnapshot.mock.calls[0][0]).toBe('compounders');
    expect(mocks.writeSnapshot.mock.calls[0][1]).toBe('largecap');
  });

  it('refuses anything but POST, so a browser cannot trigger a scan', async () => {
    const res = (await handler({ httpMethod: 'GET' } as any, {} as any)) as any;
    expect(res.statusCode).toBe(405);
    expect(mocks.writeSnapshot).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Gross profit has to BE gross profit
//
// The 2026-08-25 run — the first with a correct liquidity filter — ranked
// JBHT, LUV, DAL, ODFL, UAL, FDX and EXPD in the top ten and pushed NVDA out
// of the top 25. Airlines and truckers as the highest-quality franchises in
// the index is not a plausible reading of Novy-Marx; it is what you get when
// a filer reports no cost line, the provider returns gross_profit ≈ revenue,
// and (revenue / assets) quietly becomes the quality axis. That ratio is asset
// turnover, and it structurally favours exactly the capital-heavy businesses
// the measure is supposed to rank last.
// ---------------------------------------------------------------------------
describe('gross profit is refused when it is really revenue', () => {
  const q = (over: Partial<MassiveIncomeStatement>): MassiveIncomeStatement =>
    ({ revenue: 1000, cost_of_revenue: 600, gross_profit: 400, ...over }) as MassiveIncomeStatement;

  it('accepts a real gross profit with a reported cost line', () => {
    expect(ttmGrossProfit([q({}), q({}), q({}), q({})])).toBe(1600);
  });

  it('refuses a filer with no reported cost of revenue (LUV, ODFL)', () => {
    // gross_profit === revenue, COGS absent. GP/A here is revenue/assets.
    const rows = Array.from({ length: 4 }, () =>
      q({ revenue: 1000, cost_of_revenue: null, gross_profit: 1000 }));
    expect(ttmGrossProfit(rows)).toBeNull();
  });

  it('refuses a zero cost line, which is the same thing spelled differently', () => {
    const rows = Array.from({ length: 4 }, () =>
      q({ revenue: 1000, cost_of_revenue: 0, gross_profit: 1000 }));
    expect(ttmGrossProfit(rows)).toBeNull();
  });

  it('refuses gross profit ABOVE revenue — FDX reported a 169.8% margin', () => {
    const rows = Array.from({ length: 4 }, () =>
      q({ revenue: 1000, cost_of_revenue: 50, gross_profit: 1698 }));
    expect(ttmGrossProfit(rows)).toBeNull();
  });

  it('still accepts a genuinely high-margin business (NVDA ~75%)', () => {
    const rows = Array.from({ length: 4 }, () =>
      q({ revenue: 1000, cost_of_revenue: 251, gross_profit: 749 }));
    expect(ttmGrossProfit(rows)).toBe(2996);
  });

  it('refuses when revenue is missing, so the check cannot be made', () => {
    const rows = Array.from({ length: 4 }, () =>
      q({ revenue: null, cost_of_revenue: 600, gross_profit: 400 }));
    expect(ttmGrossProfit(rows)).toBeNull();
  });
});
