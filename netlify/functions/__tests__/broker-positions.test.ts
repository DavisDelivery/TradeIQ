import { describe, it, expect, vi, beforeEach } from 'vitest';

let authState: 'ok' | 'unconfigured' = 'ok';
vi.mock('../shared/auth', () => ({
  verifyOwnerBearer: async (headers: Record<string, string | undefined>) => {
    if (authState === 'unconfigured') return { ok: false, status: 501, error: 'login not configured' };
    return headers['authorization'] === 'Bearer good'
      ? { ok: true, email: 'owner' }
      : { ok: false, status: 401, error: 'sign in required' };
  },
}));

const rh = vi.hoisted(() => ({ ensureToken: vi.fn(), getPositions: vi.fn() }));
vi.mock('../shared/robinhood', () => rh);

import { handler } from '../broker-positions';

const get = (qs: Record<string, string> = {}, headers: Record<string, string> = { authorization: 'Bearer good' }) =>
  handler({ httpMethod: 'GET', headers, queryStringParameters: qs } as any, {} as any, () => {}) as any;

beforeEach(() => {
  authState = 'ok';
  rh.ensureToken.mockReset();
  rh.getPositions.mockReset();
  rh.ensureToken.mockResolvedValue({ accessToken: 'AT' });
  rh.getPositions.mockResolvedValue([
    { symbol: 'NFLX', qty: 20, avgCost: 71.2, instrumentUrl: 'u1' },
    { symbol: 'AMD', qty: 5, avgCost: 140, instrumentUrl: 'u2' },
  ]);
});

describe('broker-positions', () => {
  it('501/401 gating; GET only', async () => {
    authState = 'unconfigured';
    expect((await get()).statusCode).toBe(501);
    authState = 'ok';
    expect((await get({}, { authorization: 'x' })).statusCode).toBe(401);
    expect((await handler({ httpMethod: 'POST', headers: {} } as any, {} as any, () => {}) as any).statusCode).toBe(405);
  });

  it('409 needsConnect when not connected', async () => {
    rh.ensureToken.mockRejectedValue(new Error('Robinhood not connected'));
    const res = await get();
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).needsConnect).toBe(true);
  });

  it('returns all positions (shape: symbol/qty/avgCost), sorted', async () => {
    const body = JSON.parse((await get()).body);
    expect(body.positions).toEqual([
      { symbol: 'AMD', qty: 5, avgCost: 140 },
      { symbol: 'NFLX', qty: 20, avgCost: 71.2 },
    ]);
  });

  it('filters to a single ticker', async () => {
    const body = JSON.parse((await get({ ticker: 'nflx' })).body);
    expect(body.positions).toEqual([{ symbol: 'NFLX', qty: 20, avgCost: 71.2 }]);
  });
});
