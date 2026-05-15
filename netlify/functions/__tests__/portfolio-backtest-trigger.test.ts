// Phase 4e-1-finish — portfolio-backtest-trigger dispatch tests.
//
// Bug context: two production runs (pb-full-202605150933-fqrsid,
// pb-rolling-2022-202605142200-008f3z) sat at 'pending' forever
// because the trigger fired an UNAWAITED fetch and Lambda froze the
// container before the POST reached the background function.
//
// The fix: await the dispatch (with a 3s timeout race so the trigger
// stays within its 26s budget even on a slow gateway). These tests
// pin the new contract:
//   1. Trigger writes 'pending' to portfolioBacktests/{runId}.
//   2. Trigger awaits the dispatch fetch BEFORE returning 202.
//   3. Response body advertises dispatchOk so callers can detect
//      degraded behavior.
//   4. A slow gateway times out cleanly at 3s; trigger still
//      returns 202 with dispatchOk=false (the row is queued; the
//      background function may still pick it up).
//   5. Existing validation paths (405/400) still work.

import { describe, it, expect, beforeEach, vi } from 'vitest';

const writes: Array<{ collection: string; doc: string; payload: any }> = [];
const fetchSpy = vi.fn();

vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: vi.fn(() => ({
    collection: (cn: string) => ({
      doc: (dn: string) => ({
        set: async (payload: any) => {
          writes.push({ collection: cn, doc: dn, payload });
        },
      }),
    }),
  })),
}));

vi.mock('firebase-admin/firestore', () => ({
  Timestamp: { now: () => ({ _seconds: 1700000000, _nanoseconds: 0 }) },
}));

vi.stubGlobal('fetch', (...args: any[]) => fetchSpy(...args));

import { handler } from '../portfolio-backtest-trigger';

function makeEvent(opts: { method?: string; body?: any; host?: string } = {}): any {
  return {
    httpMethod: opts.method ?? 'POST',
    body: opts.body == null ? null : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body),
    headers: { host: opts.host ?? 'tradeiq-alpha.netlify.app' },
    queryStringParameters: null,
    path: '/api/portfolio-backtest/start',
    rawUrl: '',
    rawQuery: '',
    multiValueHeaders: {},
    multiValueQueryStringParameters: null,
    isBase64Encoded: false,
  };
}

async function invoke(h: any, ev: any): Promise<{ statusCode: number; body: string }> {
  const res = await h(ev, {} as any, () => {});
  return res as any;
}

beforeEach(() => {
  writes.length = 0;
  fetchSpy.mockReset();
});

describe('portfolio-backtest-trigger — validation', () => {
  it('rejects GET with 405', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 202 }));
    const res = await invoke(handler, makeEvent({ method: 'GET' }));
    expect(res.statusCode).toBe(405);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON with 400', async () => {
    const res = await invoke(handler, makeEvent({ body: 'not json' }));
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown window with 400', async () => {
    const res = await invoke(handler, makeEvent({ body: { window: 'NOT_A_WINDOW' } }));
    expect(res.statusCode).toBe(400);
  });

  it('accepts known windows + rolling-YYYY', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 202 }));
    for (const w of ['full', 'half-2018', 'half-2022', 'covid', 'rate-hikes', 'short-demo', 'rolling-2020']) {
      const res = await invoke(handler, makeEvent({ body: { window: w } }));
      expect(res.statusCode).toBe(202);
    }
  });
});

describe('portfolio-backtest-trigger — dispatch (bug fix)', () => {
  it('writes pending row before dispatching', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 202 }));
    await invoke(handler, makeEvent({ body: { window: 'short-demo' } }));
    expect(writes).toHaveLength(1);
    expect(writes[0].collection).toBe('portfolioBacktests');
    expect(writes[0].payload.status).toBe('pending');
    expect(writes[0].payload.window).toBe('short-demo');
  });

  it('AWAITS the dispatch fetch before returning (regression test for the stuck-pending bug)', async () => {
    // The bug: the original implementation did `fetch(...).then(...)` without
    // awaiting, so the trigger could return before Lambda actually sent the
    // POST. The fix awaits the fetch. We verify by making fetch resolve
    // asynchronously and asserting the trigger only returns after it does.
    let dispatchResolved = false;
    fetchSpy.mockImplementation(() =>
      new Promise((resolve) => {
        setTimeout(() => {
          dispatchResolved = true;
          resolve(new Response('', { status: 202 }));
        }, 30);
      }),
    );
    const res = await invoke(handler, makeEvent({ body: { window: 'short-demo' } }));
    // If the trigger had returned before awaiting fetch, this would be false.
    expect(dispatchResolved).toBe(true);
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.dispatchOk).toBe(true);
  });

  it('returns 202 with dispatchOk:false when the dispatch times out', async () => {
    // Simulate a hung gateway — fetch never resolves. The trigger should
    // race against its 3s internal timeout and return cleanly so the
    // 26s trigger budget isn't blown.
    fetchSpy.mockImplementation(() => new Promise(() => {})); // never resolves
    const start = Date.now();
    const res = await invoke(handler, makeEvent({ body: { window: 'short-demo' } }));
    const elapsed = Date.now() - start;
    expect(res.statusCode).toBe(202);
    const body = JSON.parse(res.body);
    expect(body.dispatchOk).toBe(false);
    expect(body.runId).toBeTruthy();
    // 3s race timeout + small slack — must NOT be the 26s trigger timeout.
    expect(elapsed).toBeLessThan(5000);
  }, 10_000);

  it('POSTs to the correct background-function URL', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 202 }));
    await invoke(handler, makeEvent({ body: { window: 'short-demo' } }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe(
      'https://tradeiq-alpha.netlify.app/.netlify/functions/run-portfolio-backtest-background',
    );
    expect(init.method).toBe('POST');
    const payload = JSON.parse(init.body);
    expect(payload.runId).toMatch(/^pb-short-demo-/);
    expect(payload.window).toBe('short-demo');
  });

  it('uses the request host so deploy previews invoke their own background', async () => {
    fetchSpy.mockResolvedValue(new Response('', { status: 202 }));
    await invoke(
      handler,
      makeEvent({ body: { window: 'short-demo' }, host: 'deploy-preview-42--tradeiq-alpha.netlify.app' }),
    );
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://deploy-preview-42--tradeiq-alpha.netlify.app/.netlify/functions/run-portfolio-backtest-background',
    );
  });
});
