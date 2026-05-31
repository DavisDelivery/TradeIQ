// Phase 6 PR-H — manual trigger endpoint tests.
//
// Pins the scan-trigger's safety discipline:
//   1. POST-only; GET refuses.
//   2. Token-gated; misses fail closed (401) and unset env returns 503.
//   3. Skips by default on market-closed days; ?ignoreHoliday=1 overrides.
//   4. Delegates to the shared runProphetSnapshot body so the cron and
//      the trigger run identical code.
//   5. forcePartial=1 is passed through so the partial-safe write path
//      is exercisable end-to-end.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeHandler } from '../scan-prophet-largecap-trigger';

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

function evt(opts: { method?: string; qs?: Record<string, string> } = {}) {
  return {
    httpMethod: opts.method ?? 'POST',
    queryStringParameters: opts.qs ?? {},
    headers: {},
    body: null,
  } as any;
}

beforeEach(() => {
  process.env.SCHEDULED_SCAN_TRIGGER_TOKEN = 'secret-test-token';
});
afterEach(() => {
  delete process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
});

describe('scan-prophet-largecap-trigger', () => {
  it('refuses GET (method_not_allowed)', async () => {
    const handler = makeHandler({
      run: vi.fn() as any,
      marketClosed: () => false,
    });
    const res = await handler(evt({ method: 'GET', qs: { token: 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(405);
  });

  it('returns 503 when the trigger token env is unset', async () => {
    delete process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    const handler = makeHandler({ run: vi.fn() as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'anything' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(503);
    expect(JSON.parse((res as any).body).error).toBe('trigger_unconfigured');
  });

  it('returns 401 when the token does not match', async () => {
    const handler = makeHandler({ run: vi.fn() as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'wrong' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(401);
  });

  it('skips by default on a market-closed day, surfacing the reason', async () => {
    const run = vi.fn();
    const handler = makeHandler({ run: run as any, marketClosed: () => true });
    const res = await handler(evt({ qs: { token: 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);
    expect(b.skipped).toBe(true);
    expect(b.reason).toBe('market_closed');
    expect(run).not.toHaveBeenCalled();
  });

  it('runs on a market-closed day when ?ignoreHoliday=1', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true, snapshotId: 'foo', status: 'complete', picks: 5,
      universeChecked: 500, scanDurationMs: 100, overallDurationMs: 120,
      promotedToLatest: true,
    });
    const handler = makeHandler({ run: run as any, marketClosed: () => true });
    const res = await handler(evt({ qs: { token: 'secret-test-token', ignoreHoliday: '1' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(expect.objectContaining({
      universe: 'largecap',
      storeKey: 'largecap',
      forcePartial: false,
    }));
  });

  it('passes ?forcePartial=1 through to the shared runner (partial-safe write path)', async () => {
    const run = vi.fn().mockResolvedValue({
      ok: true, snapshotId: 'foo', status: 'partial', picks: 3,
      universeChecked: 500, scanDurationMs: 100, overallDurationMs: 120,
      promotedToLatest: false,
    });
    const handler = makeHandler({ run: run as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'secret-test-token', forcePartial: '1' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);
    expect(b.status).toBe('partial');
    expect(b.promotedToLatest).toBe(false);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ forcePartial: true }));
  });
});
