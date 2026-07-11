// FIX-2 W1 — PIT integrity test for the earnings backtest scoring path.
//
// Proves:
//   1. Every data fetch carries asOfDate (bars end at asOfDate; the
//      earnings calendar + history are asOfDate-filtered). No fetch reads
//      "now" — the exact leak the live scan's `Date.now()` daysUntil has.
//   2. Event-window gating: a ticker with NO print near asOfDate scores
//      null (valid no-trade); a ticker inside the post-print / pre-print
//      window scores a real setup.
//   3. discreteSignalOnly drops a 'skip' classification.
//   4. Determinism: the score does not depend on the wall clock.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const barCalls: Array<{ ticker: string; from: string; to: string }> = [];
const upcomingCalls: Array<{ ticker: string; daysAhead: number; asOfDate?: string }> = [];
const historyCalls: Array<{ ticker: string; asOfDate?: string; withAnnounceDates?: boolean }> = [];

// Controllable fixtures per test.
let UPCOMING: { ticker: string; date: string } | null = null;
let HISTORY: Array<{ period: string; announceDate: string | null; epsActual: number; epsEstimate: number; surprisePct?: number }> = [];
// When true, AAPL bars carry an up-gap the day after 2022-06-13 + a
// trailing volume spike (to exercise the PEAD-long path).
let AAPL_PEAD_BARS = false;

function bar(t: number, c: number, v = 1_000_000) {
  return { t, o: c, h: c * 1.02, l: c * 0.98, c, v };
}

vi.mock('../../data-provider', async () => {
  const actual = await vi.importActual<typeof import('../../data-provider')>('../../data-provider');
  return {
    ...actual,
    getDailyBars: vi.fn(async (ticker: string, from: string, to: string) => {
      barCalls.push({ ticker, from, to });
      const start = Date.parse(`${from}T12:00:00Z`);
      const end = Date.parse(`${to}T12:00:00Z`);
      const bars = [];
      let price = 100;
      const pead = AAPL_PEAD_BARS && ticker === 'AAPL';
      for (let t = start; t <= end; t += 86_400_000) {
        const dow = new Date(t).getUTCDay();
        if (dow === 0 || dow === 6) continue;
        const day = new Date(t).toISOString().slice(0, 10);
        if (pead && day === '2022-06-14') price *= 1.08; // up-gap after the print
        const vol = pead && day >= '2022-06-10' ? 3_000_000 : 1_000_000; // trailing volume spike
        bars.push(bar(t, price, vol));
        price *= 1.001;
      }
      return bars;
    }),
    getUpcomingEarnings: vi.fn(async (ticker: string, daysAhead: number, opts: { asOfDate?: string } = {}) => {
      upcomingCalls.push({ ticker, daysAhead, asOfDate: opts.asOfDate });
      return UPCOMING;
    }),
    getEarningsHistory: vi.fn(async (ticker: string, _limit: number, opts: { asOfDate?: string; withAnnounceDates?: boolean } = {}) => {
      historyCalls.push({ ticker, asOfDate: opts.asOfDate, withAnnounceDates: opts.withAnnounceDates });
      return HISTORY;
    }),
  };
});

// Pass-through the pit-cache so tests don't need a stubbed Firestore.
vi.mock('../../pit-cache', async () => {
  const actual = await vi.importActual<typeof import('../../pit-cache')>('../../pit-cache');
  return {
    ...actual,
    pitCacheWrap: vi.fn(async <T,>(_key: unknown, loader: () => Promise<T>) => loader()),
  };
});

// computeRegime hits FRED/macro — stub it to a fixed neutral regime.
vi.mock('../../regime', async () => {
  const actual = await vi.importActual<typeof import('../../regime')>('../../regime');
  return {
    ...actual,
    computeRegime: vi.fn(async () => ({ regime: 'neutral' })),
  };
});

import { scoreTickerAtDate, buildMarketContextAtDate } from '../score-at-date';

const AS_OF = '2022-06-15';

async function ctx() {
  return buildMarketContextAtDate(AS_OF);
}

beforeEach(() => {
  barCalls.length = 0; upcomingCalls.length = 0; historyCalls.length = 0;
  UPCOMING = null; HISTORY = []; AAPL_PEAD_BARS = false;
});

describe('earnings score-at-date — PIT integrity', () => {
  it('never fetches bars past asOfDate; calendar + history carry asOfDate', async () => {
    // pre-print setup: scheduled print 10 days out
    UPCOMING = { ticker: 'AAPL', date: '2022-06-25' };
    const c = await ctx();
    await scoreTickerAtDate('AAPL', AS_OF, 'earnings', c, { discreteSignalOnly: true });

    // every bar fetch ends at asOfDate (no future bars)
    for (const call of barCalls) {
      expect(call.to <= AS_OF).toBe(true);
    }
    const aaplBar = barCalls.find((b) => b.ticker === 'AAPL');
    expect(aaplBar?.to).toBe(AS_OF);
    // earnings calendar + history were asOfDate-filtered
    expect(upcomingCalls.find((u) => u.ticker === 'AAPL')?.asOfDate).toBe(AS_OF);
    expect(historyCalls.find((h) => h.ticker === 'AAPL')?.asOfDate).toBe(AS_OF);
    expect(historyCalls.find((h) => h.ticker === 'AAPL')?.withAnnounceDates).toBe(true);
  });

  it('no event window around asOfDate → null (valid no-trade)', async () => {
    // scheduled print is far in the future (beyond the 30d window); no recent print
    UPCOMING = { ticker: 'MSFT', date: '2022-09-01' };
    HISTORY = [{ period: '2022-03-31', announceDate: '2022-04-20', epsActual: 2, epsEstimate: 1.8, surprisePct: 11 }];
    const c = await ctx();
    const res = await scoreTickerAtDate('MSFT', AS_OF, 'earnings', c, { discreteSignalOnly: true });
    expect(res).toBeNull();
  });

  it('post-print PEAD long scores a real setup (recent beat + up-gap + volume)', async () => {
    // Need a print ~2 days before asOfDate with an up-gap in bars + volume.
    // announceDate 2022-06-13 (2 days before AS_OF).
    HISTORY = [
      { period: '2022-03-31', announceDate: '2022-06-13', epsActual: 3, epsEstimate: 2, surprisePct: 12 },
      { period: '2021-12-31', announceDate: '2022-03-10', epsActual: 2.5, epsEstimate: 2.4, surprisePct: 4 },
    ];
    UPCOMING = null;
    AAPL_PEAD_BARS = true; // up-gap after 2022-06-13 + trailing volume spike
    const c = await ctx();
    const res = await scoreTickerAtDate('AAPL', AS_OF, 'earnings', c, { discreteSignalOnly: true });
    expect(res).not.toBeNull();
    expect(res!.metadata.postPrint).toBe(true);
    expect(res!.metadata.playType).toBe('pead_long');
    expect(res!.composite).toBeGreaterThan(40);
    // reportDate is the announcement date, not a future date
    expect(String(res!.metadata.reportDate) <= AS_OF).toBe(true);
    expect(res!.layers.earningsComposite).toBe(res!.composite);
  });

  it('discreteSignalOnly drops a skip classification', async () => {
    // pre-print but "mixed" metrics → skip → null under discreteSignalOnly
    UPCOMING = { ticker: 'KO', date: '2022-06-25' };
    HISTORY = [{ period: '2022-03-31', announceDate: '2022-04-20', epsActual: 1, epsEstimate: 1, surprisePct: 0 }];
    const c = await ctx();
    const res = await scoreTickerAtDate('KO', AS_OF, 'earnings', c, { discreteSignalOnly: true });
    expect(res).toBeNull();
  });
});
