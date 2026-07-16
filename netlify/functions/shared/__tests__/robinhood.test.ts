import { describe, it, expect, vi, beforeEach } from 'vitest';

// Firestore double for the token store.
const store = new Map<string, any>();
vi.mock('../firebase-admin', () => ({
  getAdminDb: () => ({
    doc: (path: string) => ({
      get: async () => ({ exists: store.has(path), data: () => store.get(path) }),
      set: async (data: any, opts?: any) => {
        store.set(path, opts?.merge ? { ...(store.get(path) ?? {}), ...data } : data);
      },
      delete: async () => { store.delete(path); },
    }),
  }),
}));

import {
  login, refresh, ensureToken, getAccount, getInstrument, placeEquityOrder, placeStopLoss,
  saveCreds, loadCreds, clearCreds, newDeviceToken,
  beginDeviceApproval, readInquiry, pollPrompt, finalizeWorkflow,
  type HttpFn, type StoredCreds,
} from '../robinhood';

// A scripted http boundary: each call shifts the next queued response.
function scriptedHttp(responses: Array<{ status?: number; body: any; assert?: (url: string, init: any) => void }>): HttpFn {
  return async (url, init) => {
    const next = responses.shift();
    if (!next) throw new Error(`unexpected http call to ${url}`);
    next.assert?.(url, init);
    return { status: next.status ?? 200, json: async () => next.body };
  };
}

beforeEach(() => store.clear());

describe('robinhood login', () => {
  it('returns tokens on a clean password grant and never returns the password', async () => {
    const http = scriptedHttp([{
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 86400 },
      assert: (url, init) => {
        expect(url).toContain('/oauth2/token/');
        const payload = JSON.parse(init.body);
        expect(payload.grant_type).toBe('password');
        expect(payload.username).toBe('me@example.com');
      },
    }]);
    const res = await login('me@example.com', 'secret', { http });
    expect(res.ok).toBe(true);
    expect(res.creds?.accessToken).toBe('AT');
    expect(res.creds?.refreshToken).toBe('RT');
    expect(JSON.stringify(res)).not.toContain('secret');
  });

  it('surfaces an MFA requirement for the caller to satisfy', async () => {
    const http = scriptedHttp([{ body: { mfa_required: true, mfa_type: 'sms' } }]);
    const res = await login('me@example.com', 'secret', { http });
    expect(res.ok).toBe(false);
    expect(res.mfaRequired).toBe(true);
    expect(res.mfaType).toBe('sms');
    expect(res.deviceToken).toBeTruthy();
  });

  it('surfaces a verification "challenge" id (SMS challenge flow)', async () => {
    const http = scriptedHttp([{ body: { challenge: { id: 'ch_123', type: 'sms' } } }]);
    const res = await login('me@example.com', 'secret', { http });
    expect(res.mfaRequired).toBe(true);
    expect(res.challengeId).toBe('ch_123');
  });

  it('reuses the same device token across a retry when passed back', async () => {
    const dt = newDeviceToken();
    const http = scriptedHttp([{
      body: { access_token: 'AT', refresh_token: 'RT', expires_in: 86400 },
      assert: (_url, init) => expect(JSON.parse(init.body).device_token).toBe(dt),
    }]);
    const res = await login('me@example.com', 'secret', { mfaCode: '123456', deviceToken: dt, http });
    expect(res.ok).toBe(true);
  });

  it('flags the modern device-approval workflow with its id', async () => {
    const http = scriptedHttp([{ body: { verification_workflow: { id: 'wf_9' } } }]);
    const res = await login('me@example.com', 'secret', { http });
    expect(res.ok).toBe(false);
    expect(res.deviceApproval).toBe(true);
    expect(res.workflowId).toBe('wf_9');
    expect(res.deviceToken).toBeTruthy();
  });
});

describe('device-approval (Pathfinder workflow)', () => {
  it('beginDeviceApproval creates the machine and reads the prompt challenge', async () => {
    const http = scriptedHttp([
      {
        body: { id: 'machine_1' },
        assert: (url, init) => {
          expect(url).toContain('/pathfinder/user_machine/');
          const p = JSON.parse(init.body);
          expect(p.flow).toBe('suv');
          expect(p.input.workflow_id).toBe('wf_9');
          expect(p.device_id).toBe('DT');
        },
      },
      {
        body: { context: { sheriff_challenge: { type: 'prompt', id: 'ch_p', status: 'issued' } } },
        assert: (url) => expect(url).toContain('/pathfinder/inquiries/machine_1/user_view/'),
      },
    ]);
    const start = await beginDeviceApproval('wf_9', 'DT', http);
    expect(start.machineId).toBe('machine_1');
    expect(start.challengeType).toBe('prompt');
    expect(start.challengeId).toBe('ch_p');
  });

  it('pollPrompt reports validated only when the phone tap lands', async () => {
    const notYet = scriptedHttp([{ body: { challenge_status: 'issued' } }]);
    expect((await pollPrompt('ch_p', notYet)).validated).toBe(false);
    const done = scriptedHttp([{ body: { challenge_status: 'validated' } }]);
    expect((await pollPrompt('ch_p', done)).validated).toBe(true);
  });

  it('finalizeWorkflow posts continue and detects approval', async () => {
    const http = scriptedHttp([{
      body: { type_context: { result: 'workflow_status_approved' } },
      assert: (url, init) => {
        expect(url).toContain('/pathfinder/inquiries/machine_1/user_view/');
        const p = JSON.parse(init.body);
        expect(p.user_input.status).toBe('continue');
      },
    }]);
    expect((await finalizeWorkflow('machine_1', http)).approved).toBe(true);
  });

  it('readInquiry defaults to a prompt challenge when the shape is sparse', async () => {
    const http = scriptedHttp([{ body: {} }]);
    const inq = await readInquiry('machine_1', http);
    expect(inq.challengeType).toBe('prompt');
    expect(inq.challengeId).toBeNull();
  });
});

describe('token lifecycle', () => {
  it('refresh swaps in a new access token, keeps the device token', async () => {
    const creds: StoredCreds = { accessToken: 'old', refreshToken: 'RT', expiresAt: new Date(0).toISOString(), deviceToken: 'DT' };
    const http = scriptedHttp([{
      body: { access_token: 'NEW', refresh_token: 'RT2', expires_in: 86400 },
      assert: (_u, init) => expect(JSON.parse(init.body).grant_type).toBe('refresh_token'),
    }]);
    const out = await refresh(creds, http);
    expect(out.accessToken).toBe('NEW');
    expect(out.refreshToken).toBe('RT2');
    expect(out.deviceToken).toBe('DT');
  });

  it('ensureToken refreshes + persists when the token is near expiry', async () => {
    await saveCreds({ accessToken: 'old', refreshToken: 'RT', expiresAt: new Date(Date.now() + 60_000).toISOString(), deviceToken: 'DT' });
    const http = scriptedHttp([{ body: { access_token: 'FRESH', refresh_token: 'RT', expires_in: 86400 } }]);
    const out = await ensureToken(http);
    expect(out.accessToken).toBe('FRESH');
    expect((await loadCreds())!.accessToken).toBe('FRESH'); // persisted
  });

  it('ensureToken returns the stored token untouched when still valid', async () => {
    await saveCreds({ accessToken: 'GOOD', refreshToken: 'RT', expiresAt: new Date(Date.now() + 3600_000).toISOString(), deviceToken: 'DT' });
    // No http responses queued — a refresh call would throw "unexpected http".
    const out = await ensureToken(scriptedHttp([]));
    expect(out.accessToken).toBe('GOOD');
  });

  it('ensureToken throws when not connected', async () => {
    await clearCreds();
    await expect(ensureToken(scriptedHttp([]))).rejects.toThrow(/not connected/i);
  });
});

describe('account + orders', () => {
  it('reads the account url + masks the number', async () => {
    const http = scriptedHttp([{ body: { results: [{ url: 'https://api/acct/1/', account_number: '12346945', buying_power: '512.34', cash: '10' }] } }]);
    const acct = await getAccount('AT', http);
    expect(acct.accountUrl).toBe('https://api/acct/1/');
    expect(acct.accountNumber).toBe('12346945');
    expect(acct.buyingPower).toBe(512.34);
  });

  it('places a market buy (no price) and returns the order id', async () => {
    const http = scriptedHttp([{
      body: { id: 'ord_1', state: 'confirmed' },
      assert: (url, init) => {
        expect(url).toContain('/orders/');
        const p = JSON.parse(init.body);
        expect(p.type).toBe('market');
        expect(p.side).toBe('buy');
        expect(p.trigger).toBe('immediate');
      },
    }]);
    const res = await placeEquityOrder('AT', { accountUrl: 'a', instrumentUrl: 'i', symbol: 'NVDA', side: 'buy', quantity: 2 }, http);
    expect(res.id).toBe('ord_1');
  });

  it('places a limit order with the price set', async () => {
    const http = scriptedHttp([{
      body: { id: 'ord_2', state: 'confirmed' },
      assert: (_u, init) => { const p = JSON.parse(init.body); expect(p.type).toBe('limit'); expect(p.price).toBe('100'); },
    }]);
    const res = await placeEquityOrder('AT', { accountUrl: 'a', instrumentUrl: 'i', symbol: 'AMD', side: 'sell', quantity: 1, limitPrice: 100 }, http);
    expect(res.id).toBe('ord_2');
  });

  it('places a native stop-loss (sell, trigger=stop, gtc)', async () => {
    const http = scriptedHttp([{
      body: { id: 'ord_3', state: 'confirmed' },
      assert: (_u, init) => {
        const p = JSON.parse(init.body);
        expect(p.trigger).toBe('stop'); expect(p.side).toBe('sell');
        expect(p.stop_price).toBe('90'); expect(p.time_in_force).toBe('gtc');
      },
    }]);
    const res = await placeStopLoss('AT', { accountUrl: 'a', instrumentUrl: 'i', symbol: 'NVDA', quantity: 2, stopPrice: 90 }, http);
    expect(res.id).toBe('ord_3');
  });

  it('throws a useful error when Robinhood rejects the order', async () => {
    const http = scriptedHttp([{ body: { detail: 'insufficient buying power' } }]);
    await expect(
      placeEquityOrder('AT', { accountUrl: 'a', instrumentUrl: 'i', symbol: 'NVDA', side: 'buy', quantity: 999 }, http),
    ).rejects.toThrow(/insufficient buying power/);
  });

  it('getInstrument reports tradability', async () => {
    const http = scriptedHttp([{ body: { results: [{ url: 'https://api/instr/1/', tradability: 'tradable', state: 'active' }] } }]);
    const i = await getInstrument('AT', 'NVDA', http);
    expect(i.instrumentUrl).toBe('https://api/instr/1/');
    expect(i.tradable).toBe(true);
  });
});
