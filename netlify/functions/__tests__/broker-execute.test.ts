import { describe, it, expect, vi, beforeEach } from 'vitest';

// Auth double.
let authState: 'ok' | 'unconfigured' = 'ok';
vi.mock('../shared/auth', () => ({
  verifyOwnerBearer: async (headers: Record<string, string | undefined>) => {
    if (authState === 'unconfigured') return { ok: false, status: 501, error: 'login not configured' };
    return headers['authorization'] === 'Bearer good'
      ? { ok: true, email: 'owner' }
      : { ok: false, status: 401, error: 'sign in required' };
  },
}));

// Robinhood client double.
const rh = vi.hoisted(() => ({
  ensureToken: vi.fn(),
  loadCreds: vi.fn(),
  saveCreds: vi.fn(async () => {}),
  getAccount: vi.fn(),
  getInstrument: vi.fn(),
  getQuote: vi.fn(),
  placeEquityOrder: vi.fn(),
  placeStopLoss: vi.fn(),
  placeStopOrder: vi.fn(),
}));
vi.mock('../shared/robinhood', () => rh);

// Firestore double (journal writeback).
const store = new Map<string, any>();
vi.mock('../shared/firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (c: string) => ({ doc: (id: string) => ({ set: async (d: any) => { store.set(`${c}/${id}`, d); } }) }),
  }),
}));

import { handler } from '../broker-execute';

const post = (body: any, headers: Record<string, string> = { authorization: 'Bearer good' }) =>
  handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) } as any, {} as any, () => {}) as any;

beforeEach(() => {
  authState = 'ok';
  store.clear();
  Object.values(rh).forEach((f: any) => f.mockReset?.());
  rh.saveCreds.mockResolvedValue(undefined);
  // Default happy-path broker state (a connected account).
  rh.ensureToken.mockResolvedValue({ accessToken: 'AT', accountUrl: 'https://acct/1/', deviceToken: 'DT', expiresAt: 'z', refreshToken: 'RT' });
  rh.getInstrument.mockResolvedValue({ instrumentUrl: 'https://instr/1/', tradable: true });
  rh.getQuote.mockResolvedValue(100);
  rh.placeEquityOrder.mockResolvedValue({ id: 'ord_1', state: 'confirmed', raw: {} });
  rh.placeStopLoss.mockResolvedValue({ id: 'stop_1', state: 'confirmed', raw: {} });
  rh.placeStopOrder.mockResolvedValue({ id: 'stopord_1', state: 'confirmed', raw: {} });
});

describe('broker-execute gating + validation', () => {
  it('501 when app login unconfigured, 401 without token', async () => {
    authState = 'unconfigured';
    expect((await post({ ticker: 'NVDA', side: 'buy', qty: 1 })).statusCode).toBe(501);
    authState = 'ok';
    expect((await post({ ticker: 'NVDA', side: 'buy', qty: 1 }, { authorization: 'x' })).statusCode).toBe(401);
  });

  it('rejects bad ticker / side / qty', async () => {
    expect((await post({ ticker: '', side: 'buy', qty: 1 })).statusCode).toBe(400);
    expect((await post({ ticker: 'NVDA', side: 'short', qty: 1 })).statusCode).toBe(400);
    expect((await post({ ticker: 'NVDA', side: 'buy', qty: 0 })).statusCode).toBe(400);
  });

  it('409 needsConnect when Robinhood is not connected', async () => {
    rh.ensureToken.mockRejectedValue(new Error('Robinhood not connected'));
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 1 });
    expect(res.statusCode).toBe(409);
    expect(JSON.parse(res.body).needsConnect).toBe(true);
  });
});

describe('guardrails', () => {
  it('enforces the $500 per-order cap using the live quote', async () => {
    rh.getQuote.mockResolvedValue(100);
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 6 }); // 6 * 100 = 600 > 500
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/cap/);
    expect(rh.placeEquityOrder).not.toHaveBeenCalled();
  });

  it('rejects an untradable instrument', async () => {
    rh.getInstrument.mockResolvedValue({ instrumentUrl: 'i', tradable: false });
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 1 });
    expect(res.statusCode).toBe(400);
  });

  it('502 when there is no quote to price the order', async () => {
    rh.getQuote.mockResolvedValue(null);
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 1 });
    expect(res.statusCode).toBe(502);
  });
});

describe('placing orders', () => {
  it('places a market buy and journals it', async () => {
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 2, sourceBoard: 'vector' });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.order.id).toBe('ord_1');
    // Market order carries the quote as the collar price.
    expect(rh.placeEquityOrder).toHaveBeenCalledWith('AT', expect.objectContaining({ side: 'buy', quantity: 2, collarPrice: 100 }));
    const journal = [...store.entries()].find(([k]) => k.startsWith('tradeLog/'));
    expect(journal![1].via).toBe('broker-execute');
    expect(journal![1].brokerOrderId).toBe('ord_1');
    expect(journal![1].qty).toBe(2);
  });

  it('a buy with a stop-loss places a native sell-stop at pct below the quote', async () => {
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 2, stopLossPct: 0.1 });
    const body = JSON.parse(res.body);
    expect(body.stopOrder.stopPrice).toBe(90); // 10% below the 100 quote
    expect(rh.placeStopLoss).toHaveBeenCalledWith('AT', expect.objectContaining({ stopPrice: 90, quantity: 2 }));
  });

  it('a sell records negative qty in the journal', async () => {
    const res = await post({ ticker: 'AMD', side: 'sell', qty: 3 });
    expect(JSON.parse(res.body).ok).toBe(true);
    const journal = [...store.entries()].find(([k]) => k.startsWith('tradeLog/'));
    expect(journal![1].qty).toBe(-3);
    expect(rh.placeStopLoss).not.toHaveBeenCalled(); // no stop on sells
  });

  it('a failed stop does not fail the (already placed) buy', async () => {
    rh.placeStopLoss.mockRejectedValue(new Error('stop rejected'));
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 1, stopLossPct: 0.1 });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.order.id).toBe('ord_1');
    expect(body.stopOrder).toBeNull();
  });

  it('honors a limit price (limit order, no market collar)', async () => {
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 2, limitPrice: 90 });
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(rh.placeEquityOrder).toHaveBeenCalledWith('AT', expect.objectContaining({ limitPrice: 90 }));
  });
});

describe('order types', () => {
  it('places a stop (stop-market) order via placeStopOrder', async () => {
    const res = await post({ ticker: 'NVDA', side: 'sell', qty: 2, orderType: 'stop', stopPrice: 80 });
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(body.order.orderType).toBe('stop');
    expect(rh.placeStopOrder).toHaveBeenCalledWith('AT', expect.objectContaining({ side: 'sell', stopPrice: 80, limitPrice: undefined }));
    expect(rh.placeEquityOrder).not.toHaveBeenCalled();
  });

  it('places a stop-limit order (stop + limit)', async () => {
    const res = await post({ ticker: 'NVDA', side: 'buy', qty: 3, orderType: 'stop_limit', stopPrice: 110, limitPrice: 112 });
    expect(JSON.parse(res.body).ok).toBe(true);
    expect(rh.placeStopOrder).toHaveBeenCalledWith('AT', expect.objectContaining({ stopPrice: 110, limitPrice: 112 }));
  });

  it('rejects stop without a stopPrice, stop_limit without a limitPrice', async () => {
    expect((await post({ ticker: 'NVDA', side: 'sell', qty: 1, orderType: 'stop' })).statusCode).toBe(400);
    expect((await post({ ticker: 'NVDA', side: 'sell', qty: 1, orderType: 'stop_limit', stopPrice: 80 })).statusCode).toBe(400);
  });

  it('a standalone stop order carries no auto stop-loss', async () => {
    await post({ ticker: 'NVDA', side: 'buy', qty: 1, orderType: 'stop', stopPrice: 110, stopLossPct: 0.1 });
    expect(rh.placeStopLoss).not.toHaveBeenCalled();
  });

  it('caps a stop order off the stop price', async () => {
    // 6 * 100 stop = 600 > 500
    const res = await post({ ticker: 'NVDA', side: 'sell', qty: 6, orderType: 'stop', stopPrice: 100 });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toMatch(/cap/);
  });
});
