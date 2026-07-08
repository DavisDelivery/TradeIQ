// Wave 3C — earnings-board methodology fixes (M2 + M3).
//
// M2: expectedMove must be an EVENT-WINDOW move (rv20/√252 × √2 × 100),
// invariant to days-until-report. The pre-fix formula
// rv20 × 100 × √(daysUntil/365) grew with event distance, so the
// movesBig/movesContained comparison against avgPriorMove (a 2-day event
// move) flipped classification with daysUntil: the invariance test below
// FAILS on pre-fix code (3d → long_volatility, 30d → skip, expectedMoves
// 0.21% vs 0.68% on this fixture).
//
// M3: 'reversal' fires on sign(lastMove) != sign(surprise), which includes
// gap-DOWN-on-a-BEAT — a LONG fade. Pre-fix triggers hardcoded the short
// side (stop above price, targets below, "SHORT shares"). The long-fade
// test below FAILS on pre-fix code.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../data-provider', () => ({
  getEarningsCalendarRange: vi.fn(),
  // FIX-1 W1 — the scan resolves its universe through the status-aware
  // variant; delegated to the legacy mock in beforeEach below.
  getEarningsCalendarRangeWithStatus: vi.fn(),
  getDailyBars: vi.fn(),
  getEarningsHistory: vi.fn(),
  getUpcomingEarnings: vi.fn(),
}));

import { runEarningsScan } from '../scan-earnings';
import {
  getEarningsCalendarRange, getEarningsCalendarRangeWithStatus,
  getDailyBars, getEarningsHistory, getUpcomingEarnings,
} from '../data-provider';

const DAY = 86400000;

/** Daily calendar bars from `from` to `to` inclusive (00:00Z stamps). */
function makeBars(
  from: string,
  to: string,
  closeAt: (iso: string) => number,
  volumeAt: (iso: string) => number = () => 1_000_000,
) {
  const bars: { t: number; o: number; h: number; l: number; c: number; v: number }[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += DAY) {
    const iso = new Date(t).toISOString().slice(0, 10);
    const c = closeAt(iso);
    bars.push({ t, o: c, h: c, l: c, c, v: volumeAt(iso) });
  }
  return bars;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-06-11T00:00:00Z'));
  (getUpcomingEarnings as any).mockResolvedValue(null);
  // FIX-1 W1 — delegate the status-aware calendar variant to the legacy
  // mock so the per-test mockResolvedValue([...]) setups keep working.
  (getEarningsCalendarRangeWithStatus as any).mockImplementation(async (...args: unknown[]) => {
    const entries = await (getEarningsCalendarRange as any)(...args);
    return { entries: entries ?? [], ok: true, httpStatus: 200, rateLimitExhausted: false };
  });
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// M2 — expectedMove horizon invariance
// ---------------------------------------------------------------------------

// Fixture geometry:
//   - 2026-02-15 .. 2026-05-16: ±3% zig-zag → high historical 20d-chunk
//     realized vols, so the CURRENT (quiet) rv20 ranks at the bottom of the
//     range → rvRank ≈ 0 (≤ 35, the long-vol gate).
//   - 2026-05-17 .. 2026-06-10: flat at 100 except a +1% step inside the
//     T-1→T+1 window matched around the 2026-06-01 announcement (the scan
//     matches the FIRST bar within 3d of the announce date, i.e. 05-30, so
//     the step sits at 05-30/05-31) → avgPriorMove = 1.0%, rv20 small.
//   - Event-window expectedMove ≈ 0.21%, so movesBig (1.0 > 0.21 × 1.15)
//     holds and BOTH scans classify long_volatility.
// Pre-fix, the 30d scan computed expectedMove ≈ 0.68% → movesBig fails →
// playType degrades to 'skip' and the expectedMove equality fails.
function m2CloseAt(iso: string): number {
  if (iso <= '2026-05-16') {
    const dayIdx = Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.parse('2026-02-15T00:00:00Z')) / DAY);
    return dayIdx % 2 === 1 ? 103 : 100;
  }
  if (iso <= '2026-05-29') return 100;
  if (iso === '2026-05-30') return 100.5;
  return 101;
}

async function runM2Scan(reportDate: string) {
  (getEarningsCalendarRange as any).mockResolvedValue([
    { ticker: 'AAPL', date: reportDate, hour: 'amc' },
  ]);
  (getEarningsHistory as any).mockResolvedValue([
    { period: '2026-03-31', announceDate: '2026-06-01', epsActual: 1.05, epsEstimate: 1.0, surprisePct: 5 },
  ]);
  (getDailyBars as any).mockResolvedValue(makeBars('2026-02-15', '2026-06-10', m2CloseAt));
  const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 0, scanBudgetMs: 10_000 });
  expect(out.setups).toHaveLength(1);
  return out.setups[0];
}

describe('M2 — expectedMove is an event-window move, invariant to daysUntil', () => {
  it('same ticker/vol reporting 3d vs 30d out → identical expectedMove AND identical vol classification', async () => {
    const near = await runM2Scan('2026-06-14'); // 3 days out
    const far = await runM2Scan('2026-07-11');  // 30 days out

    expect(near.daysUntil).toBe(3);
    expect(far.daysUntil).toBe(30);

    // The event-window expected move does not depend on event distance.
    expect(near.expectedMove).toBe(far.expectedMove);
    // ... and is the 2-trading-day move, the same scale as avgPriorMove
    // (per-day vol ≈ 0.15%, ×√2 ≈ 0.21%) — NOT a multi-week waiting-period
    // move (pre-fix 30d value was ≈ 0.68%).
    expect(near.expectedMove).toBeGreaterThan(0);
    expect(near.expectedMove).toBeLessThan(0.5);

    // Classification no longer flips with event distance: both are
    // long_volatility (rvRank low + history of moves bigger than the
    // event-window expectation). Pre-fix the 30d scan degraded to 'skip'.
    expect(near.playType).toBe('long_volatility');
    expect(far.playType).toBe('long_volatility');
  });

  it('exposes rvRank with ivr kept as a deprecated alias', async () => {
    const setup = await runM2Scan('2026-06-14');
    expect(setup.rvRank).toBeTypeOf('number');
    expect(setup.ivr).toBe(setup.rvRank);
    // Recommendation wording is honest about the data source: realized-vol
    // rank, not implied vol.
    expect(setup.rationale).toContain('RV rank');
    expect(setup.rationale).not.toMatch(/\bIV\b/);
  });
});

// ---------------------------------------------------------------------------
// M3 — reversal plays are direction-aware
// ---------------------------------------------------------------------------

function mockPostPrint(opts: { surprisePct: number; gapTo: number }) {
  // Printed 3 days ago (2026-06-08). The scan matches the first bar within
  // 3d of the announcement (06-06); window = 06-05 close → 06-07 close.
  (getEarningsCalendarRange as any).mockResolvedValue([
    { ticker: 'AAPL', date: '2026-06-08', hour: 'amc' },
  ]);
  (getEarningsHistory as any).mockResolvedValue([
    {
      period: '2026-03-31', announceDate: '2026-06-08',
      epsActual: 1 + opts.surprisePct / 100, epsEstimate: 1.0, surprisePct: opts.surprisePct,
    },
  ]);
  const mid = (100 + opts.gapTo) / 2;
  (getDailyBars as any).mockResolvedValue(makeBars(
    '2026-02-15', '2026-06-10',
    (iso) => (iso <= '2026-06-05' ? 100 : iso === '2026-06-06' ? mid : opts.gapTo),
    (iso) => (iso >= '2026-06-06' ? 3_000_000 : 1_000_000),
  ));
}

describe('M3 — reversal triggers follow the fade direction', () => {
  it('gap-DOWN on a BEAT → LONG fade: stop below price, targets above, no SHORT wording', async () => {
    mockPostPrint({ surprisePct: 8, gapTo: 92 }); // beat +8%, reaction −8%

    const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 5, scanBudgetMs: 10_000 });
    expect(out.setups).toHaveLength(1);
    const s = out.setups[0];

    expect(s.postPrint).toBe(true);
    expect(s.playType).toBe('reversal');
    expect(s.direction).toBe('long');
    expect(s.strategy).toContain('long');

    const t = s.triggers!;
    expect(t.stop).not.toBeNull();
    expect(t.stop!).toBeLessThan(s.price);
    expect(t.targets.t1!).toBeGreaterThan(s.price);
    expect(t.targets.t2!).toBeGreaterThan(t.targets.t1!);
    expect(t.targets.t3!).toBeGreaterThan(t.targets.t2!);
    expect(t.entry).toContain('gap-down');

    const stepText = (t.executionSteps ?? []).map((st) => `${st.title} ${st.detail}`).join(' ');
    expect(stepText).not.toContain('SHORT');
    expect(stepText).toContain('BUY shares');
    expect(stepText).toContain('calls');
  });

  it('gap-UP on a MISS → SHORT fade preserved: stop above price, targets below, SHORT wording', async () => {
    mockPostPrint({ surprisePct: -8, gapTo: 108 }); // miss −8%, reaction +8%

    const out = await runEarningsScan({ windowDays: 30, postPrintLookbackDays: 5, scanBudgetMs: 10_000 });
    expect(out.setups).toHaveLength(1);
    const s = out.setups[0];

    expect(s.playType).toBe('reversal');
    expect(s.direction).toBe('short');

    const t = s.triggers!;
    expect(t.stop!).toBeGreaterThan(s.price);
    expect(t.targets.t1!).toBeLessThan(s.price);
    expect(t.entry).toContain('gap-up');

    const stepText = (t.executionSteps ?? []).map((st) => `${st.title} ${st.detail}`).join(' ');
    expect(stepText).toContain('SHORT shares');
  });
});
