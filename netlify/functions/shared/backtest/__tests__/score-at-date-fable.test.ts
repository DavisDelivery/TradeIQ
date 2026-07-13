// FABLE — PIT integrity test for the backtest scoring path.
//
// Proves: (1) every fetch carries asOfDate (bars end at asOf, insider txs
// asOf-filtered); (2) gate-fail ⇒ null (valid no-trade); (3) an ideal
// smooth-uptrend name scores with all pillars populated; (4) the composite
// equals the pure engine's number for identical inputs (live/PIT parity).

import { describe, it, expect, vi, beforeEach } from 'vitest';

const barCalls: Array<{ ticker: string; from: string; to: string }> = [];
const insiderCalls: Array<{ ticker: string; asOfDate?: string }> = [];

let UPTREND_TICKERS = new Set<string>(['AAPL']);

const DAY = 86_400_000;
// SPY gets its OWN return stream (slower drift, different wiggle phase) so
// idiosyncratic momentum is well-defined — a spy that is a scaled copy of
// the ticker produces zero residuals and a degenerate imom.
function synthBars(from: string, to: string, kind: 'up' | 'down' | 'spy') {
  const start = Date.parse(`${from}T12:00:00Z`);
  const end = Date.parse(`${to}T12:00:00Z`);
  const bars: any[] = [];
  let i = 0;
  for (let t = start; t <= end; t += DAY) {
    const dow = new Date(t).getUTCDay();
    if (dow === 0 || dow === 6) continue;
    const g = kind === 'up' ? 1.0016 : kind === 'down' ? 0.9987 : 1.0005;
    const base = (kind === 'spy' ? 400 : 100) * Math.pow(g, i);
    const wig =
      kind === 'spy'
        ? 0.004 * Math.sin(i / 5) + 0.003 * Math.sin(i / 11)
        : 0.006 * Math.sin(i / 3) + 0.004 * Math.sin(i / 7);
    const c = base * (1 + wig);
    bars.push({ t, o: c * 0.995, h: c * 1.01, l: c * 0.99, c, v: 5_000_000 });
    i++;
  }
  return bars;
}

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>('../../data-provider');
  return {
    ...actual,
    getDailyBars: vi.fn(async (ticker: string, from: string, to: string) => {
      barCalls.push({ ticker, from, to });
      if (ticker === 'SPY') return synthBars(from, to, 'spy');
      return synthBars(from, to, UPTREND_TICKERS.has(ticker) ? 'up' : 'down');
    }),
    getFinnhubInsiderTransactions: vi.fn(
      async (ticker: string, _daysBack: number, opts: { asOfDate?: string } = {}) => {
        insiderCalls.push({ ticker, asOfDate: opts.asOfDate });
        return [
          {
            name: 'EXEC ONE',
            share: 10_000,
            change: 2_000,
            filingDate: '2022-05-20',
            transactionDate: '2022-05-18',
            transactionPrice: 50,
            transactionCode: 'P',
            isDerivative: false,
            source: 't',
            currency: 'USD',
          },
        ];
      },
    ),
  };
});

vi.mock('../../pit-cache', async () => {
  const actual = await vi.importActual<typeof import('../../pit-cache')>('../../pit-cache');
  return {
    ...actual,
    pitCacheWrap: vi.fn(async <T,>(_key: unknown, loader: () => Promise<T>) => loader()),
  };
});

vi.mock('../../regime', async () => {
  const actual = await vi.importActual<typeof import('../../regime')>('../../regime');
  return { ...actual, computeRegime: vi.fn(async () => ({ regime: 'neutral' })) };
});

import { scoreTickerAtDate, buildMarketContextAtDate } from '../score-at-date';
import { scoreFable } from '../../fable-scoring';

const AS_OF = '2022-06-15';

beforeEach(() => {
  barCalls.length = 0;
  insiderCalls.length = 0;
  UPTREND_TICKERS = new Set(['AAPL']);
});

describe('fable score-at-date — PIT integrity', () => {
  it('bars never extend past asOfDate; insider fetch carries asOfDate', async () => {
    const ctx = await buildMarketContextAtDate(AS_OF);
    const res = await scoreTickerAtDate('AAPL', AS_OF, 'fable', ctx, { discreteSignalOnly: true });
    expect(res).not.toBeNull();
    for (const call of barCalls) expect(call.to <= AS_OF).toBe(true);
    const ins = insiderCalls.find((c) => c.ticker === 'AAPL');
    expect(ins?.asOfDate).toBe(AS_OF);
  });

  it('gate-fail (downtrend) ⇒ null — a valid no-trade', async () => {
    UPTREND_TICKERS = new Set(); // AAPL now a downtrend
    const ctx = await buildMarketContextAtDate(AS_OF);
    const res = await scoreTickerAtDate('AAPL', AS_OF, 'fable', ctx, { discreteSignalOnly: true });
    expect(res).toBeNull();
  });

  it('populated pillars + insider edge from the filed buy', async () => {
    const ctx = await buildMarketContextAtDate(AS_OF);
    const res = await scoreTickerAtDate('AAPL', AS_OF, 'fable', ctx, { discreteSignalOnly: true });
    expect(res!.layers.fableComposite).toBe(res!.composite);
    const m = res!.metadata as any;
    expect(m.ascent).toBeGreaterThan(0);
    expect(m.highGround).toBeGreaterThan(0);
    expect(m.insiderEdge).toBeGreaterThan(0); // $100k buy filed 2022-05-20 < asOf
  });

  it('live/PIT parity: composite equals the pure engine on identical inputs', async () => {
    const ctx = await buildMarketContextAtDate(AS_OF);
    const res = await scoreTickerAtDate('AAPL', AS_OF, 'fable', ctx, { discreteSignalOnly: true });
    // Recompute with the same synthetic inputs the mock served. NB: the
    // market-context build also fetches SPY (different window) — the call
    // scoreFableAtDate made shares the ticker's `from` (same 460d lookback).
    const from = barCalls.find((c) => c.ticker === 'AAPL')!.from;
    const bars = synthBars(from, AS_OF, 'up');
    const spyCalls = barCalls.filter((c) => c.ticker === 'SPY' && c.to === AS_OF);
    const spyFrom = (spyCalls.find((c) => c.from === from) ?? spyCalls[spyCalls.length - 1])!.from;
    const spy = synthBars(spyFrom, AS_OF, 'spy');
    const txs = [
      {
        name: 'EXEC ONE',
        change: 2_000,
        transactionPrice: 50,
        transactionCode: 'P',
        filingDate: '2022-05-20',
        transactionDate: '2022-05-18',
      },
    ];
    const pure = scoreFable(bars as any, spy as any, txs as any, AS_OF);
    expect(pure).not.toBeNull();
    expect(res!.composite).toBeCloseTo(pure!.composite, 8);
    // pillar-level parity too — the whole board, not just the sum
    const m = res!.metadata as any;
    expect(m.ascent).toBeCloseTo(+pure!.pillars.ascent.toFixed(1), 6);
    expect(m.smoothPath).toBeCloseTo(+pure!.pillars.smoothPath.toFixed(1), 6);
    expect(m.highGround).toBeCloseTo(+pure!.pillars.highGround.toFixed(1), 6);
    expect(m.coiledSpring).toBeCloseTo(+pure!.pillars.coiledSpring.toFixed(1), 6);
    expect(m.insiderEdge).toBeCloseTo(+pure!.insider.score.toFixed(1), 6);
  });
});
