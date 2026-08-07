// Wave 2D (CR-7) — Prophet thin-cron dispatcher tests.
//
// The three Prophet crons no longer run their 10–14-minute scan bodies
// in-handler (a scheduled function is killed at the ~26s synchronous
// ceiling); they gate on the holiday calendar and POST once to their
// `-background` worker, mirroring the insider/target dispatchers. These
// tests pin the gating + dispatch contract per universe:
//   1. Market-closed day → skip response, NO dispatch.
//   2. Open day → exactly one POST to the right worker path with the
//      empty-body fresh-start payload.
//   3. Worker status passthrough; dispatch failure → 500.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { makeProphetCronHandler } from '../shared/prophet-cron-dispatcher';
import { CRON as LARGECAP_CRON, WORKER_PATH as LARGECAP_WORKER } from '../scan-prophet-largecap';
import { CRON as RUSSELL_CRON, WORKER_PATH as RUSSELL_WORKER } from '../scan-prophet-russell';
import { CRON as ALL_CRON, WORKER_PATH as ALL_WORKER } from '../scan-prophet-all';

vi.mock('../shared/logger', () => ({
  logger: { child: () => ({ info: () => {}, warn: () => {}, error: () => {}, debug: () => {} }) },
}));

const CONFIGS = [
  { fn: 'scan-prophet-largecap', universe: 'largecap' as const, schedule: LARGECAP_CRON, workerPath: LARGECAP_WORKER },
  { fn: 'scan-prophet-russell', universe: 'russell' as const, schedule: RUSSELL_CRON, workerPath: RUSSELL_WORKER },
  { fn: 'scan-prophet-all', universe: 'all' as const, schedule: ALL_CRON, workerPath: ALL_WORKER },
];

function fetchOk(status = 202) {
  return vi.fn().mockResolvedValue({ status, text: async () => '' });
}

const evt = {} as any;
const ctx = {} as any;

beforeEach(() => {
  delete process.env.URL;
});
afterEach(() => {
  delete process.env.URL;
});

describe.each(CONFIGS)('$fn (thin cron dispatcher)', (config) => {
  it('skips on a market-closed day and does NOT dispatch the worker', async () => {
    const fetchImpl = fetchOk();
    const handler = makeProphetCronHandler(config, { fetchImpl, marketClosed: () => true });
    const res = (await handler(evt, ctx, () => {})) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.skipped).toBe(true);
    expect(body.reason).toBe('market_closed');
    expect(body.universe).toBe(config.universe);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('dispatches exactly once to its background worker on an open day', async () => {
    const fetchImpl = fetchOk();
    const handler = makeProphetCronHandler(config, { fetchImpl, marketClosed: () => false });
    const res = (await handler(evt, ctx, () => {})) as any;
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.universe).toBe(config.universe);
    expect(body.workerStatus).toBe(202);
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`https://tradeiq-alpha.netlify.app${config.workerPath}`);
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({}) });
  });

  it('builds the self-invoke URL from process.env.URL when set', async () => {
    process.env.URL = 'https://deploy-preview.example.com';
    const fetchImpl = fetchOk();
    const handler = makeProphetCronHandler(config, { fetchImpl, marketClosed: () => false });
    await handler(evt, ctx, () => {});
    expect(fetchImpl.mock.calls[0][0]).toBe(
      `https://deploy-preview.example.com${config.workerPath}`,
    );
  });

  it('returns 500 when the worker dispatch throws', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('gateway down'));
    const handler = makeProphetCronHandler(config, { fetchImpl, marketClosed: () => false });
    const res = (await handler(evt, ctx, () => {})) as any;
    expect(res.statusCode).toBe(500);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(false);
    expect(body.error).toContain('gateway down');
  });
});

describe('dispatcher wiring', () => {
  it('each cron targets a distinct -background worker', () => {
    const paths = CONFIGS.map((c) => c.workerPath);
    expect(new Set(paths).size).toBe(3);
    for (const p of paths) expect(p).toMatch(/-background$/);
  });
});
