// Pins the forward-test cohort math: top-N extraction (with buy-side
// filters), horizon freezing vs SPY, maturity, and league ranking.

import { describe, it, expect } from 'vitest';
import {
  extractTopN,
  evaluatePick,
  buildLeague,
  daysBetween,
  FORWARD_BOARDS,
  type ForwardPick,
} from '../forward-test';

const basePick = (over: Partial<ForwardPick> = {}): ForwardPick => ({
  board: 'trident',
  universe: 'sp500',
  ticker: 'AAA',
  entryDate: '2026-01-02',
  entryPrice: 100,
  spyEntry: 500,
  rankAtEntry: 1,
  scoreAtEntry: 90,
  status: 'open',
  daysOnBoard: 1,
  lastSeenDate: '2026-01-02',
  lastPrice: 100,
  lastPriceDate: '2026-01-02',
  currentPct: 0,
  currentAlpha: 0,
  returns: {},
  ...over,
});

describe('extractTopN', () => {
  it('takes the first N unique tickers in stored order with ranks', () => {
    const rows = [
      { ticker: 'aaa', composite: 90 },
      { ticker: 'BBB', percentile: 99 },
      { ticker: 'AAA', composite: 88 }, // dup — skipped
      { ticker: 'CCC' },
    ];
    const top = extractTopN(rows, { board: 'trident', universe: 'sp500', take: 2 });
    expect(top).toEqual([
      { ticker: 'AAA', rank: 1, score: 90 },
      { ticker: 'BBB', rank: 2, score: 99 },
    ]);
  });

  it('applies buy-side filters (crosses → golden only; sentiment → bullish only)', () => {
    const crosses = FORWARD_BOARDS.find((c) => c.board === 'crosses')!;
    const top = extractTopN(
      [
        { ticker: 'DTH', type: 'death' },
        { ticker: 'GLD1', type: 'golden' },
        { ticker: 'GLD2', type: 'golden' },
      ],
      crosses,
    );
    expect(top.map((t) => t.ticker)).toEqual(['GLD1', 'GLD2']);

    const sentiment = FORWARD_BOARDS.find((c) => c.board === 'sentiment')!;
    const stop = extractTopN(
      [
        { ticker: 'BULL', label: 'bullish' },
        { ticker: 'BEAR', label: 'bearish' },
      ],
      sentiment,
    );
    expect(stop.map((t) => t.ticker)).toEqual(['BULL']);
  });
});

describe('evaluatePick', () => {
  const closes = (price: number) => new Map([['AAA', price]]);

  it('marks the pick to the latest close with alpha vs SPY', () => {
    const { pick, changed } = evaluatePick(basePick(), closes(110), 510, '2026-01-05');
    expect(changed).toBe(true);
    expect(pick.currentPct).toBe(10);
    expect(pick.currentAlpha).toBe(8); // 10% − 2% SPY
    expect(pick.returns.d7).toBeUndefined(); // only 3 days elapsed
  });

  it('freezes horizons as they come due and never overwrites them', () => {
    let p = basePick();
    ({ pick: p } = evaluatePick(p, closes(105), 505, '2026-01-09')); // day 7
    expect(p.returns.d7).toEqual({ pct: 5, spyPct: 1, alpha: 4, frozenAt: '2026-01-09' });
    ({ pick: p } = evaluatePick(p, closes(120), 520, '2026-02-02')); // day 31
    expect(p.returns.d7?.pct).toBe(5); // frozen value untouched
    expect(p.returns.d30?.pct).toBe(20);
    expect(p.status).toBe('open');
  });

  it('matures at the 1y freeze', () => {
    const { pick } = evaluatePick(basePick(), closes(150), 550, '2027-01-04');
    expect(pick.returns.d365?.pct).toBe(50);
    expect(pick.status).toBe('matured');
  });

  it('is a no-op when the ticker has no close today (halt/delist gap)', () => {
    const { changed } = evaluatePick(basePick(), new Map(), 510, '2026-01-05');
    expect(changed).toBe(false);
  });
});

describe('buildLeague', () => {
  it('ranks boards by avg alpha at the longest horizon with n ≥ 5', () => {
    const winner = Array.from({ length: 5 }, (_, i) =>
      basePick({
        board: 'trident', ticker: `W${i}`,
        returns: { d90: { pct: 12, spyPct: 2, alpha: 10, frozenAt: '2026-04-02' } },
      }),
    );
    const loser = Array.from({ length: 5 }, (_, i) =>
      basePick({
        board: 'lynch', ticker: `L${i}`,
        returns: { d90: { pct: -3, spyPct: 2, alpha: -5, frozenAt: '2026-04-02' } },
      }),
    );
    const league = buildLeague([...winner, ...loser]);
    expect(league[0].board).toBe('trident');
    expect(league[0].rankScore).toBe(10);
    expect(league[0].provisional).toBe(false);
    expect(league[1].board).toBe('lynch');
    expect(league[1].horizons.d90?.winRate).toBe(0);
  });

  it('falls back to unrealized open-cohort alpha (provisional) with no matured sample', () => {
    const young = [
      basePick({ board: 'fable', ticker: 'Y1', currentAlpha: 4, currentPct: 5 }),
      basePick({ board: 'fable', ticker: 'Y2', currentAlpha: 2, currentPct: 1 }),
    ];
    const league = buildLeague(young);
    expect(league[0].rankScore).toBe(3);
    expect(league[0].provisional).toBe(true);
    expect(league[0].rankBasis).toMatch(/open cohort/);
  });
});

describe('daysBetween', () => {
  it('computes calendar-day gaps', () => {
    expect(daysBetween('2026-01-02', '2026-01-09')).toBe(7);
    expect(daysBetween('2026-01-02', '2027-01-02')).toBe(365);
  });
});
