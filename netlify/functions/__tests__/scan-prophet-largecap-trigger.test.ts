// Phase 6 PR-H — manual trigger endpoint tests.
//
// The trigger is a SYNC DISPATCHER: it gates the request and then POSTs to
// the background worker (`scan-prophet-largecap-trigger-background`), which
// does the actual minutes-long scan. So these tests pin the gating +
// dispatch contract:
//   1. POST-only; GET refuses (405).
//   2. Token-gated; misses fail closed (401) and unset env returns 503.
//   3. Skips by default on market-closed days; ?ignoreHoliday=1 overrides —
//      and a skip must NOT dispatch the background scan.
//   4. On accept, returns 202 and dispatches exactly once, forwarding the
//      token + forcePartial flag to the worker.

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

describe('scan-prophet-largecap-trigger (dispatcher)', () => {
  it('refuses GET (method_not_allowed)', async () => {
    const handler = makeHandler({ dispatch: vi.fn() as any, marketClosed: () => false });
    const res = await handler(evt({ method: 'GET', qs: { token: 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(405);
  });

  it('returns 503 when the trigger token env is unset', async () => {
    delete process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    const dispatch = vi.fn();
    const handler = makeHandler({ dispatch: dispatch as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'anything' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(503);
    expect(JSON.parse((res as any).body).error).toBe('trigger_unconfigured');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('returns 401 when the token does not match', async () => {
    const dispatch = vi.fn();
    const handler = makeHandler({ dispatch: dispatch as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'wrong' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(401);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('skips by default on a market-closed day, surfacing the reason and NOT dispatching', async () => {
    const dispatch = vi.fn();
    const handler = makeHandler({ dispatch: dispatch as any, marketClosed: () => true });
    const res = await handler(evt({ qs: { token: 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    const b = JSON.parse((res as any).body);
    expect(b.skipped).toBe(true);
    expect(b.reason).toBe('market_closed');
    expect(dispatch).not.toHaveBeenCalled();
  });

  it('dispatches on a market-closed day when ?ignoreHoliday=1 (202 accepted)', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handler = makeHandler({ dispatch: dispatch as any, marketClosed: () => true });
    const res = await handler(evt({ qs: { token: 'secret-test-token', ignoreHoliday: '1' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(202);
    expect(JSON.parse((res as any).body).accepted).toBe(true);
    expect(dispatch).toHaveBeenCalledOnce();
    expect(dispatch).toHaveBeenCalledWith(
      expect.objectContaining({ forcePartial: false, ignoreHoliday: true, token: 'secret-test-token' }),
    );
  });

  it('forwards ?forcePartial=1 to the background worker', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const handler = makeHandler({ dispatch: dispatch as any, marketClosed: () => false });
    const res = await handler(evt({ qs: { token: 'secret-test-token', forcePartial: '1' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(202);
    const b = JSON.parse((res as any).body);
    expect(b.forcePartial).toBe(true);
    expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ forcePartial: true }));
  });
});
