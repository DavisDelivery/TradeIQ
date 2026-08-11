// QS-1 — the scan ASSEMBLY, which had no test and therefore had the bug.
//
// The first production run scored 0 of 1851 names, every one of them
// 'insufficient-history', with all 157 dates fetched in 24s of an 11-minute
// budget. Nothing was slow and nothing was missing: the month-end close
// window was anchored to `now` while the scoring window was anchored to
// `now - WINDOW_END_LAG`, so the closes started one month too late.
//
// A return is dated to the LATER of the two months it spans, so the earliest
// close can only produce a return one month after itself. Covering returns
// [end-35 .. end] needs closes [end-36 .. end]. The old loop produced
// [end-35 .. end+1]: the first needed month was unobtainable and the last
// fetched month was never used. The alignment loop then refused every
// ticker — permanently, on any date, for any universe.
//
// Every piece this bug passed through had tests. residual-momentum,
// ff-factors, monthly-returns and quiet-strength were all covered; the
// function that WIRES them was not. So these tests drive the real
// runQuietStrengthScan with injected providers rather than testing another
// pure helper in isolation.

import { describe, it, expect } from 'vitest';
import {
  runQuietStrengthScan,
  closeMonthsFor,
  MONTH_ENDS,
  BENCH,
} from '../scan-quiet-strength';
import { addMonths, ymOf, type FactorMonth } from '../ff-factors';
import { ESTIMATION_MONTHS, WINDOW_END_LAG } from '../residual-momentum';
import type { GroupedRow } from '../vector-data';
import type { FinvizRow } from '../finviz';

/** The date the first production run failed on. */
const FAILING_RUN = new Date('2026-08-10T22:41:00Z');

// ---------------------------------------------------------------------------
// The window identity, stated directly
// ---------------------------------------------------------------------------

describe('the close window feeds the scoring window exactly', () => {
  /** Returns are dated to the later month, so drop the first close. */
  const returnsFrom = (closes: number[]) => closes.slice(1);

  const neededReturns = (endYm: number) =>
    Array.from({ length: ESTIMATION_MONTHS }, (_, i) =>
      addMonths(endYm, -(ESTIMATION_MONTHS - 1 - i)));

  it.each([
    '2026-08-10T22:40:00Z', // the failing run
    '2026-09-01T22:40:00Z', // month roll
    '2027-01-15T22:40:00Z', // year roll
    '2026-12-31T22:40:00Z', // year end
  ])('at %s the returns cover the factor window with nothing missing or spare', (iso) => {
    const endYm = addMonths(ymOf(new Date(iso)), -WINDOW_END_LAG);
    const got = returnsFrom(closeMonthsFor(endYm));
    expect(got).toEqual(neededReturns(endYm));
  });

  it('asks for exactly one more close than the returns it needs', () => {
    expect(closeMonthsFor(202606)).toHaveLength(MONTH_ENDS);
    expect(MONTH_ENDS).toBe(ESTIMATION_MONTHS + 1);
  });

  it('puts the extra month at the START, which is the half that was wrong', () => {
    const closes = closeMonthsFor(202606);
    // The bug shipped [202307..202607]; correct is [202306..202606].
    expect(closes[0]).toBe(202306);
    expect(closes[closes.length - 1]).toBe(202606);
    expect(closes).not.toContain(addMonths(202606, 1));
  });
});

// ---------------------------------------------------------------------------
// End to end, through the real scan
// ---------------------------------------------------------------------------

const TICKERS = Array.from({ length: 40 }, (_, i) => `TK${String(i).padStart(2, '0')}`);
const ALL = [...TICKERS, BENCH];

/** Deterministic, no Math.random — a resumed run must produce the same numbers. */
const wobble = (seed: number) => Math.sin(seed) * 10_000 % 1;

function universe(): FinvizRow[] {
  return TICKERS.map((t, i) => ({
    ticker: t,
    sector: i % 2 ? 'Technology' : 'Industrials',
    industry: 'Test Industry',
    marketCapM: 5_000 + i * 100,
    price: 50,
  } as unknown as FinvizRow));
}

/**
 * Grouped daily for ANY date. Prices drift with the date so month-over-month
 * returns are non-degenerate, which residual momentum needs to identify betas.
 */
function grouped(date: string): GroupedRow[] {
  const day = Number(date.replace(/-/g, ''));
  return ALL.map((t, i) => {
    const c = 50 + (day % 997) / 40 + wobble(day / 7 + i) * 5 + i;
    return { T: t, c, h: c, l: c, o: c, v: 2_000_000 + i * 1_000, t: 0 };
  });
}

/** FF3 covering well past the window, full-rank so betas are identifiable. */
function factors(): FactorMonth[] {
  const out: FactorMonth[] = [];
  let ym = 202201;
  for (let i = 0; i < 60; i++) {
    out.push({
      ym,
      mktRf: 1.5 * wobble(i + 1) + 0.4,
      smb: 2.0 * wobble(i + 31) - 0.2,
      hml: 1.7 * wobble(i + 71) + 0.1,
      rf: 0.28,
    });
    ym = addMonths(ym, 1);
  }
  return out;
}

const run = (now: Date) =>
  runQuietStrengthScan({
    now,
    getGrouped: async (d) => grouped(d),
    getFactors: async () => ({ factors: factors(), memberName: 'test.csv', fetchedAt: '' }),
    getUniverse: async () => universe(),
  });

describe('the scan actually scores names', () => {
  it('scores the universe on the exact date that returned 0 of 1851', async () => {
    const res = await run(FAILING_RUN);

    // The regression, stated as the symptom that was observed in production.
    expect(res.unscorableCounts['insufficient-history'] ?? 0).toBe(0);
    expect(res.scored).toBeGreaterThan(0);
  }, 30_000);

  it('does not blame the budget for something the budget did not cause', async () => {
    // Production fetched all 157 dates in 24s of an 11-minute allowance, so a
    // budget warning here would mean the fixture, not the code, is the story.
    const res = await run(FAILING_RUN);
    expect(res.budgetExceeded).toBe(false);
    expect(res.warnings.join(' ')).not.toMatch(/budget exceeded/);
  }, 30_000);

  it('clears the 30-name floor, so a board is publishable', async () => {
    const res = await run(FAILING_RUN);
    expect(res.warnings.join(' ')).not.toMatch(/below the 30-name floor/);
    expect(res.rows.length).toBeGreaterThan(0);
  }, 30_000);

  it('keeps scoring as the calendar advances', async () => {
    // The bug was invariant to the date, so a fix that only works in August
    // would be no fix at all.
    for (const iso of ['2026-09-15T22:40:00Z', '2027-02-01T22:40:00Z']) {
      const res = await run(new Date(iso));
      expect(res.scored, `nothing scored at ${iso}`).toBeGreaterThan(0);
    }
  }, 60_000);

  it('fetches the closes the scoring window needs', async () => {
    const res = await run(FAILING_RUN);
    expect(res.scoringEndYm).toBe(202606);
    expect(res.factorLatestYm).not.toBeNull();
    expect(res.datesFetched).toBeGreaterThan(ESTIMATION_MONTHS);
  }, 30_000);
});
