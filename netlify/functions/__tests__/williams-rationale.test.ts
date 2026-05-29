// Phase 6 W1 — /api/williams-rationale endpoint contract tests.
//
// The data-provider (bar fetch) is mocked; the real runWilliams + component
// decomposition + thesis + risk-callout generators run, so this pins both the
// HTTP shape AND that the surface layer wires the real scoring through.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Bar } from '../shared/data-provider';

const getDailyBarsMock = vi.fn();
vi.mock('../shared/data-provider', () => ({
  getDailyBars: (...a: unknown[]) => getDailyBarsMock(...a),
}));

vi.mock('../shared/logger', () => ({
  createLogger: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }),
}));

import { handler } from '../williams-rationale';

function evt(qs: Record<string, string> = {}) {
  return { httpMethod: 'GET', queryStringParameters: qs, headers: {}, body: null } as any;
}

// 60 gently-rising bars — enough for runWilliams (>=30) and the indicators.
function genBars(n = 60): Bar[] {
  const bars: Bar[] = [];
  let c = 100;
  const startT = Date.parse('2026-01-01T00:00:00Z');
  for (let i = 0; i < n; i++) {
    const o = c;
    c = c * (1 + (i % 5 === 0 ? -0.005 : 0.008));
    const h = Math.max(o, c) * 1.01;
    const l = Math.min(o, c) * 0.99;
    bars.push({ t: startT + i * 86400000, o, h, l, c, v: 1_000_000 });
  }
  return bars;
}

beforeEach(() => {
  getDailyBarsMock.mockReset();
});

describe('GET /api/williams-rationale', () => {
  it('returns 400 when ticker is missing', async () => {
    const res = await handler(evt({}), {} as any, () => {});
    expect((res as any).statusCode).toBe(400);
    expect(getDailyBarsMock).not.toHaveBeenCalled();
  });

  it('uppercases the ticker before fetching bars', async () => {
    getDailyBarsMock.mockResolvedValue(genBars());
    await handler(evt({ ticker: 'nvda' }), {} as any, () => {});
    expect(getDailyBarsMock).toHaveBeenCalledWith('NVDA', expect.any(String), expect.any(String));
  });

  it('returns 404 when there is insufficient price history', async () => {
    getDailyBarsMock.mockResolvedValue(genBars(10));
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(404);
    const body = JSON.parse((res as any).body);
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/insufficient price history/i);
  });

  it('returns components + thesis + risk callouts on a successful recompute', async () => {
    getDailyBarsMock.mockResolvedValue(genBars());
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const body = JSON.parse((res as any).body);

    expect(body.ok).toBe(true);
    expect(body.ticker).toBe('NVDA');
    expect(typeof body.score).toBe('number');
    expect(['long', 'short', 'neutral']).toContain(body.direction);
    expect(typeof body.thesis).toBe('string');
    expect(body.thesis.length).toBeGreaterThan(20);
    expect(Array.isArray(body.components)).toBe(true);
    expect(body.components).toHaveLength(5);
    expect(Array.isArray(body.riskCallouts)).toBe(true);
    expect(body.riskCallouts.length).toBeGreaterThan(0);
    expect(body.modelVersion).toBeTruthy();

    // Each component carries the full ScoreComponent shape.
    for (const c of body.components) {
      expect(typeof c.name).toBe('string');
      expect(typeof c.score).toBe('number');
      expect(typeof c.weight).toBe('number');
      expect(['long', 'short', 'neutral']).toContain(c.direction);
      expect(typeof c.rationale).toBe('string');
      expect(typeof c.signals).toBe('object');
    }
  });

  it('returns 500 on an unexpected provider error', async () => {
    getDailyBarsMock.mockRejectedValue(new Error('polygon exploded'));
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
    const body = JSON.parse((res as any).body);
    expect(body.error).toContain('polygon exploded');
  });

  it('sets a short browser cache header', async () => {
    getDailyBarsMock.mockResolvedValue(genBars());
    const res = await handler(evt({ ticker: 'NVDA' }), {} as any, () => {});
    expect((res as any).headers['Cache-Control']).toMatch(/max-age=/);
  });
});
