import { describe, it, expect, vi, beforeEach } from 'vitest';

const store = new Map<string, any>();
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (data: any) => { store.set(path, data); },
    }),
  }),
}));

import { handler } from '../broker-sync';

const evt = (method: string, body?: any) =>
  ({ httpMethod: method, headers: {}, body: body ? JSON.stringify(body) : null, queryStringParameters: {} }) as any;

beforeEach(() => store.clear());

describe('broker-sync', () => {
  it('GET before any sync reports available:false', async () => {
    const res: any = await handler(evt('GET'), {} as any, () => {});
    expect(JSON.parse(res.body)).toMatchObject({ ok: true, available: false });
  });

  it('POST validates required numbers and stores a capped snapshot', async () => {
    const bad: any = await handler(evt('POST', { totalValue: 'x' }), {} as any, () => {});
    expect(bad.statusCode).toBe(400);

    const positions = Array.from({ length: 50 }, (_, i) => ({ symbol: `T${i}`, qty: 1, avgCost: 10, marketValue: 11 }));
    const ok: any = await handler(evt('POST', {
      accountMasked: '••••6945', totalValue: 7030.3, cash: 5546.7, buyingPower: 5546.7,
      pendingDeposits: 5000, positions, source: 'executor-agent',
    }), {} as any, () => {});
    const body = JSON.parse(ok.body);
    expect(body.stored).toBe(true);
    expect(body.positions).toBeLessThanOrEqual(30); // hard cap

    const get: any = await handler(evt('GET'), {} as any, () => {});
    const snap = JSON.parse(get.body);
    expect(snap.available).toBe(true);
    expect(snap.totalValue).toBe(7030.3);
    expect(snap.buyingPower).toBe(5546.7);
    expect(snap.syncedAt).toBeTruthy();
  });

  it('rejects malformed symbols and non-numeric qty rows', async () => {
    await handler(evt('POST', {
      totalValue: 100, buyingPower: 100,
      positions: [{ symbol: 'ok!@#$bad', qty: 1 }, { symbol: 'AMD', qty: 'x' }, { symbol: 'NVDA', qty: 3 }],
    }), {} as any, () => {});
    const get: any = await handler(evt('GET'), {} as any, () => {});
    const snap = JSON.parse(get.body);
    expect(snap.positions.map((p: any) => p.symbol)).toEqual(['NVDA']);
  });
});
