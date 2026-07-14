import { describe, it, expect, vi, beforeEach } from 'vitest';

// getDailyBars is the only real dependency we need to control. It receives
// (ticker, from, to); we assert the handler requests a warmup window wider
// than the visible lookback, and return a synthetic series spanning it.
const getDailyBarsMock = vi.fn();
vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...a: unknown[]) => getDailyBarsMock(...a),
}));
vi.mock('../shared/technical-setups', () => ({
  detectSetups: () => [],
  scoreSetups: () => 0,
}));
vi.mock('../shared/anthropic-client', () => ({
  callAnthropic: vi.fn(),
  BudgetExhaustedError: class extends Error {},
  CircuitOpenError: class extends Error {},
}));

import { handler } from '../chart-analysis';

const DAY = 86_400_000;

function evt(params: Record<string, string>) {
  return { queryStringParameters: params, httpMethod: 'GET' } as any;
}

// Build `n` daily bars ending today, gently rising so SMAs are well-defined.
function series(n: number) {
  const now = Date.now();
  return Array.from({ length: n }, (_, i) => {
    const c = 100 + i; // strictly rising
    return { t: now - (n - 1 - i) * DAY, o: c, h: c + 1, l: c - 1, c, v: 1_000_000 };
  });
}

beforeEach(() => getDailyBarsMock.mockReset());

describe('chart-analysis — SMA200 warmup window', () => {
  it('fetches a warmup window wider than the visible lookback', async () => {
    getDailyBarsMock.mockResolvedValue(series(400));
    await handler(evt({ ticker: 'WARM', lookback: '180', skipAi: '1' }), {} as any, () => {});
    expect(getDailyBarsMock).toHaveBeenCalledTimes(1);
    const [, from, to] = getDailyBarsMock.mock.calls[0];
    const spanDays = (Date.parse(to) - Date.parse(from)) / DAY;
    // 180 visible + 365 warmup ≈ 545 calendar days.
    expect(spanDays).toBeGreaterThan(500);
  });

  it('populates sma200 on the FIRST visible bar (the bug: it was null everywhere)', async () => {
    getDailyBarsMock.mockResolvedValue(series(400));
    const res: any = await handler(evt({ ticker: 'MU', lookback: '180', skipAi: '1' }), {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    // Visible window is ~180 calendar days, not the full 400 fetched.
    expect(body.bars.length).toBeLessThan(220);
    expect(body.bars.length).toBeGreaterThan(120);
    // Every visible bar now carries a real SMA200 (200 warmup bars fed it).
    expect(body.bars[0].sma200).not.toBeNull();
    expect(body.bars[body.bars.length - 1].sma200).not.toBeNull();
    expect(body.indicators.latest.sma200).not.toBeNull();
  });

  it('still leaves sma200 null when there is genuinely < 200 bars of history', async () => {
    // A recent IPO: only 150 total bars exist, all inside the visible window.
    getDailyBarsMock.mockResolvedValue(series(150));
    const res: any = await handler(evt({ ticker: 'IPO', lookback: '180', skipAi: '1' }), {} as any, () => {});
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.bars[body.bars.length - 1].sma200).toBeNull(); // honest: not enough data
    expect(body.bars[body.bars.length - 1].sma50).not.toBeNull(); // 50 still fine
  });
});
