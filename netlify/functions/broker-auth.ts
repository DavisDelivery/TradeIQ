// Broker connect — links the owner's Robinhood account for server-side
// execution (Option B). Behind the app login (verifyOwnerBearer). We store
// OAuth tokens, NEVER the username/password.
//
//   POST /api/broker-auth  { action:'status' }
//     → { connected, account? }  (reads the account back to prove the token)
//   POST /api/broker-auth  { action:'connect', username, password,
//                            mfaCode?, deviceToken?, challengeId? }
//     → success: { connected:true, account }
//     → second factor: { mfaRequired:true, mfaType, deviceToken, challengeId? }
//       (owner re-submits 'connect' with mfaCode + the same deviceToken)
//   POST /api/broker-auth  { action:'disconnect' } → drops stored tokens
//
// VERIFY-FIRST: on a successful connect we immediately call getAccount with
// the fresh token and return the masked account + buying power. If that read
// fails, the token is useless and we don't claim success. No order is ever
// placed here — execution is a separate, later endpoint.

import type { Handler } from '@netlify/functions';
import { verifyOwnerBearer } from './shared/auth';
import {
  login, respondChallenge, ensureToken, getAccount,
  saveCreds, loadCreds, clearCreds, fingerprint,
} from './shared/robinhood';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'broker-auth' });

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

/** Read the account back and shape a safe, display-only summary. */
async function accountSummary(): Promise<{ accountMasked: string; buyingPower: number | null; cash: number | null } | null> {
  const creds = await ensureToken();
  const acct = await getAccount(creds.accessToken);
  // Persist the account url/number for the executor to reuse later.
  await saveCreds({ ...creds, accountUrl: acct.accountUrl, accountNumber: acct.accountNumber });
  const n = acct.accountNumber;
  return {
    accountMasked: n ? `••••${n.slice(-4)}` : '••••',
    buyingPower: acct.buyingPower,
    cash: acct.cash,
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const auth = await verifyOwnerBearer((event.headers ?? {}) as Record<string, string | undefined>);
  if (!auth.ok) return json(auth.status ?? 401, { ok: false, error: auth.error });

  let body: any = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return json(400, { ok: false, error: 'invalid json' }); }
  const action = String(body.action ?? '');

  try {
    if (action === 'status') {
      const creds = await loadCreds();
      if (!creds) return json(200, { ok: true, connected: false });
      try {
        const account = await accountSummary();
        return json(200, { ok: true, connected: true, account, connectedAt: creds.connectedAt ?? null });
      } catch (e: any) {
        // Token present but no longer valid (expired refresh / revoked).
        return json(200, { ok: true, connected: false, stale: true, error: String(e?.message ?? e) });
      }
    }

    if (action === 'disconnect') {
      await clearCreds();
      log.info('broker_disconnected');
      return json(200, { ok: true, connected: false });
    }

    if (action === 'connect') {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      if (!username || !password) return json(400, { ok: false, error: 'username and password required' });

      // Optional prior SMS/verification challenge: satisfy it first, then log in.
      if (body.challengeId && body.mfaCode) {
        const ch = await respondChallenge(String(body.challengeId), String(body.mfaCode));
        if (!ch.ok) return json(401, { ok: false, error: ch.error });
      }

      const res = await login(username, password, {
        mfaCode: body.mfaCode ? String(body.mfaCode) : undefined,
        deviceToken: body.deviceToken ? String(body.deviceToken) : undefined,
        challengeId: body.challengeId ? String(body.challengeId) : undefined,
      });

      log.info('broker_connect_attempt', { user: fingerprint(username), ok: res.ok, mfa: !!res.mfaRequired });

      if (res.mfaRequired) {
        return json(200, {
          ok: true, connected: false, mfaRequired: true,
          mfaType: res.mfaType, deviceToken: res.deviceToken, challengeId: res.challengeId ?? null,
        });
      }
      if (!res.ok || !res.creds) {
        return json(401, { ok: false, error: res.error || 'connect failed', deviceToken: res.deviceToken });
      }

      // Store tokens, then VERIFY by reading the account back.
      await saveCreds(res.creds);
      try {
        const account = await accountSummary();
        log.info('broker_connected');
        return json(200, { ok: true, connected: true, account });
      } catch (e: any) {
        // The token didn't actually work — don't leave a broken cred behind.
        await clearCreds();
        return json(502, { ok: false, error: `connected but account read failed: ${String(e?.message ?? e)}` });
      }
    }

    return json(400, { ok: false, error: "action must be 'status' | 'connect' | 'disconnect'" });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('broker_auth_failed', { err: msg, action });
    return json(500, { ok: false, error: msg });
  }
};
