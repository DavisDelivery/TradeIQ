import { describe, it, expect, vi, beforeEach } from 'vitest';

// Auth double — 'good' bearer = signed-in owner; unconfigured = 501.
let authState: 'ok' | 'unconfigured' = 'ok';
vi.mock('../shared/auth', () => ({
  verifyOwnerBearer: async (headers: Record<string, string | undefined>) => {
    if (authState === 'unconfigured') return { ok: false, status: 501, error: 'login not configured' };
    return (headers['authorization'] === 'Bearer good')
      ? { ok: true, email: 'owner' }
      : { ok: false, status: 401, error: 'sign in required' };
  },
}));

// Robinhood client double — scripted per test. vi.hoisted so the object
// exists when the (hoisted) vi.mock factory runs.
const rh = vi.hoisted(() => ({
  login: vi.fn(),
  respondChallenge: vi.fn(),
  ensureToken: vi.fn(),
  getAccount: vi.fn(),
  beginDeviceApproval: vi.fn(),
  pollPrompt: vi.fn(),
  finalizeWorkflow: vi.fn(async () => ({ approved: true })),
  saveCreds: vi.fn(async () => {}),
  loadCreds: vi.fn(),
  clearCreds: vi.fn(async () => {}),
  fingerprint: (_s: string) => 'fp',
}));
vi.mock('../shared/robinhood', () => rh);

import { handler } from '../broker-auth';

const post = (body: any, headers: Record<string, string> = { authorization: 'Bearer good' }) =>
  handler({ httpMethod: 'POST', headers, body: JSON.stringify(body) } as any, {} as any, () => {}) as any;

beforeEach(() => {
  authState = 'ok';
  Object.values(rh).forEach((f: any) => typeof f?.mockReset === 'function' && f.mockReset());
  rh.saveCreds.mockResolvedValue(undefined);
  rh.clearCreds.mockResolvedValue(undefined);
});

describe('broker-auth gating', () => {
  it('501 when the app login is unconfigured', async () => {
    authState = 'unconfigured';
    const res = await post({ action: 'status' });
    expect(res.statusCode).toBe(501);
  });

  it('401 without a valid app session', async () => {
    const res = await post({ action: 'status' }, { authorization: 'Bearer nope' });
    expect(res.statusCode).toBe(401);
  });

  it('rejects non-POST', async () => {
    const res = await handler({ httpMethod: 'GET', headers: {} } as any, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(405);
  });
});

describe('status', () => {
  it('reports not-connected when no creds are stored', async () => {
    rh.loadCreds.mockResolvedValue(null);
    const res = await post({ action: 'status' });
    expect(JSON.parse(res.body)).toMatchObject({ connected: false });
  });

  it('reads the account back when connected', async () => {
    rh.loadCreds.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: new Date(Date.now() + 1e6).toISOString(), deviceToken: 'DT', connectedAt: 'x' });
    rh.ensureToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 'y', deviceToken: 'DT' });
    rh.getAccount.mockResolvedValue({ accountUrl: 'u', accountNumber: '12346945', buyingPower: 500, cash: 10 });
    const res = await post({ action: 'status' });
    const body = JSON.parse(res.body);
    expect(body.connected).toBe(true);
    expect(body.account.accountMasked).toBe('••••6945');
  });

  it('marks stale when a stored token no longer reads the account', async () => {
    rh.loadCreds.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 'z', deviceToken: 'DT' });
    rh.ensureToken.mockRejectedValue(new Error('token refresh failed — reconnect Robinhood'));
    const res = await post({ action: 'status' });
    const body = JSON.parse(res.body);
    expect(body.connected).toBe(false);
    expect(body.stale).toBe(true);
  });
});

describe('connect', () => {
  it('requires username and password', async () => {
    const res = await post({ action: 'connect', username: '', password: '' });
    expect(res.statusCode).toBe(400);
  });

  it('returns mfaRequired for the client to satisfy', async () => {
    rh.login.mockResolvedValue({ ok: false, mfaRequired: true, mfaType: 'sms', deviceToken: 'DT', challengeId: 'ch1' });
    const res = await post({ action: 'connect', username: 'u', password: 'p' });
    const body = JSON.parse(res.body);
    expect(body.mfaRequired).toBe(true);
    expect(body.deviceToken).toBe('DT');
  });

  it('connects, then VERIFIES by reading the account back', async () => {
    rh.login.mockResolvedValue({ ok: true, creds: { accessToken: 'AT', refreshToken: 'RT', expiresAt: new Date(Date.now() + 1e6).toISOString(), deviceToken: 'DT' } });
    rh.ensureToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 'y', deviceToken: 'DT' });
    rh.getAccount.mockResolvedValue({ accountUrl: 'u', accountNumber: '00006945', buyingPower: 500, cash: 5 });
    const res = await post({ action: 'connect', username: 'u', password: 'p' });
    const body = JSON.parse(res.body);
    expect(body.connected).toBe(true);
    expect(body.account.accountMasked).toBe('••••6945');
    expect(rh.saveCreds).toHaveBeenCalled();
  });

  it('does NOT claim connected if the account read fails — clears the bad cred', async () => {
    rh.login.mockResolvedValue({ ok: true, creds: { accessToken: 'AT', refreshToken: 'RT', expiresAt: 'x', deviceToken: 'DT' } });
    rh.ensureToken.mockRejectedValue(new Error('unauthorized'));
    const res = await post({ action: 'connect', username: 'u', password: 'p' });
    expect(res.statusCode).toBe(502);
    expect(rh.clearCreds).toHaveBeenCalled();
  });

  it('401s on a failed login', async () => {
    rh.login.mockResolvedValue({ ok: false, error: 'unable to log in with provided credentials' });
    const res = await post({ action: 'connect', username: 'u', password: 'bad' });
    expect(res.statusCode).toBe(401);
  });

  it('starts the device-approval workflow and hands the client the machine + challenge', async () => {
    rh.login.mockResolvedValue({ ok: false, deviceApproval: true, workflowId: 'wf', deviceToken: 'DT' });
    rh.beginDeviceApproval.mockResolvedValue({ machineId: 'm1', challengeType: 'prompt', challengeId: 'ch', status: 'issued' });
    const res = await post({ action: 'connect', username: 'u', password: 'p' });
    const body = JSON.parse(res.body);
    expect(body.deviceApproval).toBe(true);
    expect(body.machineId).toBe('m1');
    expect(body.challengeId).toBe('ch');
    expect(body.deviceToken).toBe('DT');
  });
});

describe('poll (device approval)', () => {
  const base = { action: 'poll', username: 'u', password: 'p', deviceToken: 'DT', machineId: 'm1', challengeId: 'ch', challengeType: 'prompt' };

  it('returns pending while the phone approval has not validated', async () => {
    rh.pollPrompt.mockResolvedValue({ validated: false });
    const res = await post(base);
    expect(JSON.parse(res.body).pending).toBe(true);
    expect(rh.login).not.toHaveBeenCalled();
  });

  it('finalizes + re-logs in + connects once the approval validates', async () => {
    rh.pollPrompt.mockResolvedValue({ validated: true });
    rh.finalizeWorkflow.mockResolvedValue({ approved: true });
    rh.login.mockResolvedValue({ ok: true, creds: { accessToken: 'AT', refreshToken: 'RT', expiresAt: new Date(Date.now() + 1e6).toISOString(), deviceToken: 'DT' } });
    rh.ensureToken.mockResolvedValue({ accessToken: 'AT', refreshToken: 'RT', expiresAt: 'y', deviceToken: 'DT' });
    rh.getAccount.mockResolvedValue({ accountUrl: 'u', accountNumber: '00006945', buyingPower: 500, cash: 5 });
    const res = await post(base);
    const body = JSON.parse(res.body);
    expect(body.connected).toBe(true);
    expect(body.account.accountMasked).toBe('••••6945');
  });

  it('stays pending if the token is not ready right after approval', async () => {
    rh.pollPrompt.mockResolvedValue({ validated: true });
    rh.login.mockResolvedValue({ ok: false, deviceApproval: true, workflowId: 'wf', deviceToken: 'DT' });
    const res = await post(base);
    expect(JSON.parse(res.body).pending).toBe(true);
  });

  it('requires an mfaCode for sms/email challenges', async () => {
    const res = await post({ ...base, challengeType: 'sms', challengeId: 'ch', mfaCode: '' });
    expect(res.statusCode).toBe(400);
  });
});

describe('disconnect', () => {
  it('clears stored creds', async () => {
    const res = await post({ action: 'disconnect' });
    expect(JSON.parse(res.body).connected).toBe(false);
    expect(rh.clearCreds).toHaveBeenCalled();
  });
});
