import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory Firestore double: enough surface for the queue's doc/collection ops.
const store = new Map<string, any>();
const dbMock = {
  collection: (name: string) => ({
    doc: (id: string) => ({
      get: async () => ({ exists: store.has(`${name}/${id}`), data: () => store.get(`${name}/${id}`) }),
      set: async (data: any, opts?: any) => {
        const key = `${name}/${id}`;
        store.set(key, opts?.merge ? { ...(store.get(key) ?? {}), ...data } : data);
      },
    }),
    where: (_f: string, _op: string, v: any) => ({
      limit: () => ({
        get: async () => ({
          docs: [...store.entries()]
            .filter(([k, r]) => k.startsWith(`${name}/`) && r.status === v)
            .map(([k, r]) => ({ data: () => r, ref: dbMock.collection(name).doc(k.split('/')[1]) })),
        }),
      }),
    }),
    orderBy: () => ({
      limit: () => ({
        get: async () => ({
          docs: [...store.entries()]
            .filter(([k]) => k.startsWith(`${name}/`))
            .map(([k, r]) => ({ data: () => r, ref: dbMock.collection(name).doc(k.split('/')[1]) })),
        }),
      }),
    }),
  }),
};
vi.mock('../shared/firebase-admin', () => ({ getAdminDb: () => dbMock }));

// Login auth double: 'good' bearer = signed-in owner; anything else fails
// the way shared/auth.ts fails (401), and authState 'unconfigured' = 501.
let authState: 'ok' | 'unconfigured' = 'ok';
vi.mock('../shared/auth', () => ({
  verifyOwnerBearer: async (headers: Record<string, string | undefined>) => {
    if (authState === 'unconfigured') return { ok: false, status: 501, error: 'OWNER_EMAILS not configured — login-gated mutations disabled' };
    const raw = headers['authorization'] ?? '';
    if (raw === 'Bearer good') return { ok: true, email: 'owner@example.com' };
    return { ok: false, status: 401, error: 'sign in required (missing bearer token)' };
  },
}));

import { handler } from '../trade-queue';

const evt = (method: string, body?: any, headers: Record<string, string> = {}, qs: Record<string, string> = {}) =>
  ({ httpMethod: method, headers, body: body ? JSON.stringify(body) : null, queryStringParameters: qs }) as any;
const authed = { authorization: 'Bearer good' };

beforeEach(() => {
  store.clear();
  authState = 'ok';
});

describe('trade-queue auth (login-gated, fail-closed)', () => {
  it('mutations 501 when the owner allowlist is unconfigured — never default-open', async () => {
    authState = 'unconfigured';
    const res: any = await handler(evt('POST', { ticker: 'AAPL', side: 'buy', qty: 1, sourceBoard: 'fable' }, authed), {} as any, () => {});
    expect(res.statusCode).toBe(501);
  });

  it('mutations 401 without a valid sign-in; GET stays open', async () => {
    const bad: any = await handler(evt('POST', { ticker: 'AAPL', side: 'buy', qty: 1, sourceBoard: 'fable' }, { authorization: 'Bearer nope' }), {} as any, () => {});
    expect(bad.statusCode).toBe(401);
    const get: any = await handler(evt('GET'), {} as any, () => {});
    expect(get.statusCode).toBe(200);
  });
});

describe('trade-queue lifecycle', () => {
  async function queueOne(over: any = {}) {
    const res: any = await handler(evt('POST', {
      ticker: 'NVDA', side: 'buy', qty: 3, limitPrice: 950, sourceBoard: 'vector', rationale: 'E2 cluster', ...over,
    }, authed), {} as any, () => {});
    return JSON.parse(res.body);
  }

  it('queues a valid buy; rejects sells (long-only v1) and missing size', async () => {
    const q = await queueOne();
    expect(q.ok).toBe(true);
    expect(q.row.status).toBe('queued');
    expect(q.row.side).toBe('buy');

    const sell: any = await handler(evt('POST', { ticker: 'NVDA', side: 'sell', qty: 1, sourceBoard: 'x' }, authed), {} as any, () => {});
    expect(sell.statusCode).toBe(400);
    const noSize: any = await handler(evt('POST', { ticker: 'NVDA', side: 'buy', sourceBoard: 'x' }, authed), {} as any, () => {});
    expect(noSize.statusCode).toBe(400);
  });

  it('cancel: queued -> cancelled; cannot cancel twice', async () => {
    const q = await queueOne();
    const c1: any = await handler(evt('PATCH', { id: q.row.id, action: 'cancel' }, authed), {} as any, () => {});
    expect(JSON.parse(c1.body).status).toBe('cancelled');
    const c2: any = await handler(evt('PATCH', { id: q.row.id, action: 'cancel' }, authed), {} as any, () => {});
    expect(c2.statusCode).toBe(409);
  });

  it('execute writes the fill AND the journal entry (source-tagged)', async () => {
    const q = await queueOne();
    const ex: any = await handler(evt('PATCH', {
      id: q.row.id, action: 'execute', fill: { price: 948.5, qty: 3 },
    }, authed), {} as any, () => {});
    const body = JSON.parse(ex.body);
    expect(body.status).toBe('executed');
    // Journal writeback landed with the source board tag.
    const journal = [...store.entries()].find(([k]) => k.startsWith('tradeLog/'));
    expect(journal).toBeDefined();
    expect(journal![1].ticker).toBe('NVDA');
    expect(journal![1].source).toBe('vector');
    expect(journal![1].price).toBe(948.5);
    expect(journal![1].via).toBe('trade-queue');
    // Row carries the journal link.
    const row = store.get(`tradeQueue/${q.row.id}`);
    expect(row.journalId).toBe(journal![0].split('/')[1]);
  });

  it('cannot execute a cancelled row (one-way state machine)', async () => {
    const q = await queueOne();
    await handler(evt('PATCH', { id: q.row.id, action: 'cancel' }, authed), {} as any, () => {});
    const ex: any = await handler(evt('PATCH', { id: q.row.id, action: 'execute', fill: { price: 1, qty: 1 } }, authed), {} as any, () => {});
    expect(ex.statusCode).toBe(409);
  });

  it('expired rows flip lazily on GET and refuse execution', async () => {
    const q = await queueOne({ expiresHours: 1 });
    // Force expiry in the past.
    const row = store.get(`tradeQueue/${q.row.id}`);
    row.expiresAt = new Date(Date.now() - 60_000).toISOString();
    store.set(`tradeQueue/${q.row.id}`, row);

    const get: any = await handler(evt('GET', undefined, {}, { status: 'queued' }), {} as any, () => {});
    const listed = JSON.parse(get.body).rows.find((r: any) => r.id === q.row.id);
    expect(listed.status).toBe('expired');

    const ex: any = await handler(evt('PATCH', { id: q.row.id, action: 'execute', fill: { price: 1, qty: 1 } }, authed), {} as any, () => {});
    expect(ex.statusCode).toBe(409);
  });
});
