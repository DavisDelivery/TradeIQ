// Phase 6 PR-H — background worker tests.
//
// The worker does the actual scan. It is publicly POST-able at its own
// `/.netlify/functions/...` URL, so it re-checks the trigger token
// (defense-in-depth) before delegating to the shared runProphetSnapshot
// body. Pins:
//   1. Unset token env fails closed (503).
//   2. Missing/wrong `x-trigger-token` header fails closed (401) and does
//      NOT scan.
//   3. A valid call delegates to runProphetSnapshot with the largecap
//      universe + storeKey, forwarding forcePartial.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeWorker } from '../scan-prophet-largecap-trigger-background';

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

function evt(opts: { headers?: Record<string, string>; qs?: Record<string, string> } = {}) {
  return {
    httpMethod: 'POST',
    queryStringParameters: opts.qs ?? {},
    headers: opts.headers ?? {},
    body: '{}',
  } as any;
}

const okResult = {
  ok: true,
  snapshotId: 'largecap-2026-06-02-0934',
  status: 'complete' as const,
  picks: 25,
  universeChecked: 208,
  scanDurationMs: 1000,
  overallDurationMs: 1100,
  promotedToLatest: true,
};

beforeEach(() => {
  process.env.SCHEDULED_SCAN_TRIGGER_TOKEN = 'secret-test-token';
});
afterEach(() => {
  delete process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
});

describe('scan-prophet-largecap-trigger-background (worker)', () => {
  it('returns 503 when the trigger token env is unset', async () => {
    delete process.env.SCHEDULED_SCAN_TRIGGER_TOKEN;
    const run = vi.fn();
    const worker = makeWorker({ run: run as any });
    const res = await worker(evt({ headers: { 'x-trigger-token': 'anything' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(503);
    expect(run).not.toHaveBeenCalled();
  });

  it('returns 401 and does not scan when the header token is missing/wrong', async () => {
    const run = vi.fn();
    const worker = makeWorker({ run: run as any });
    const res = await worker(evt({ headers: { 'x-trigger-token': 'wrong' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(401);
    expect(run).not.toHaveBeenCalled();
  });

  it('delegates to runProphetSnapshot with largecap opts on a valid call', async () => {
    const run = vi.fn().mockResolvedValue(okResult);
    const worker = makeWorker({ run: run as any });
    const res = await worker(evt({ headers: { 'x-trigger-token': 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(200);
    expect(run).toHaveBeenCalledOnce();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ universe: 'largecap', storeKey: 'largecap', forcePartial: false }),
    );
  });

  it('passes ?forcePartial=1 through to the shared runner', async () => {
    const run = vi.fn().mockResolvedValue({ ...okResult, status: 'partial', promotedToLatest: false });
    const worker = makeWorker({ run: run as any });
    const res = await worker(
      evt({ headers: { 'x-trigger-token': 'secret-test-token' }, qs: { forcePartial: '1' } }),
      {} as any,
      () => {},
    );
    expect((res as any).statusCode).toBe(200);
    expect(run).toHaveBeenCalledWith(expect.objectContaining({ forcePartial: true }));
  });

  it('returns 500 when the scan reports failure', async () => {
    const run = vi.fn().mockResolvedValue({ ...okResult, ok: false, error: 'boom' });
    const worker = makeWorker({ run: run as any });
    const res = await worker(evt({ headers: { 'x-trigger-token': 'secret-test-token' } }), {} as any, () => {});
    expect((res as any).statusCode).toBe(500);
  });
});
