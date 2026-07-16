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
  beginDeviceApproval, pollPrompt, finalizeWorkflow,
  saveCreds, loadCreds, clearCreds, fingerprint,
  type StoredCreds,
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

/** Store fresh creds, then VERIFY by reading the account back. Clears the
 *  credential and returns a 502 body if the token doesn't actually work. */
async function storeAndVerify(creds: StoredCreds) {
  await saveCreds(creds);
  try {
    const account = await accountSummary();
    log.info('broker_connected');
    return json(200, { ok: true, connected: true, account });
  } catch (e: any) {
    await clearCreds();
    return json(502, { ok: false, error: `connected but account read failed: ${String(e?.message ?? e)}` });
  }
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

      const res = await login(username, password, {
        mfaCode: body.mfaCode ? String(body.mfaCode) : undefined,
        deviceToken: body.deviceToken ? String(body.deviceToken) : undefined,
      });

      log.info('broker_connect_attempt', { user: fingerprint(username), ok: res.ok, mfa: !!res.mfaRequired, deviceApproval: !!res.deviceApproval });

      // Modern device-approval path: start the Pathfinder workflow and hand
      // the client what it needs to wait for the phone-app approval.
      if (res.deviceApproval && res.workflowId && res.deviceToken) {
        const start = await beginDeviceApproval(res.workflowId, res.deviceToken);
        return json(200, {
          ok: true, connected: false, deviceApproval: true,
          mfaType: start.challengeType, deviceToken: res.deviceToken,
          machineId: start.machineId, challengeId: start.challengeId,
        });
      }
      // Legacy code path (SMS/app code, no device workflow).
      if (res.mfaRequired) {
        return json(200, {
          ok: true, connected: false, mfaRequired: true,
          mfaType: res.mfaType, deviceToken: res.deviceToken, challengeId: res.challengeId ?? null,
        });
      }
      if (!res.ok || !res.creds) {
        return json(401, { ok: false, error: res.error || 'connect failed', deviceToken: res.deviceToken });
      }
      return await storeAndVerify(res.creds);
    }

    // Async device-approval wait: the client polls this while the owner taps
    // Approve in the Robinhood app. One quick check per call (no long hold in
    // the function). Once the challenge validates we finalize the workflow and
    // re-request the token.
    if (action === 'poll') {
      const username = String(body.username ?? '').trim();
      const password = String(body.password ?? '');
      const deviceToken = String(body.deviceToken ?? '');
      const machineId = String(body.machineId ?? '');
      const challengeId = body.challengeId ? String(body.challengeId) : '';
      const challengeType = String(body.challengeType ?? body.mfaType ?? 'prompt');
      if (!username || !password || !deviceToken || !machineId) {
        return json(400, { ok: false, error: 'username, password, deviceToken, machineId required' });
      }

      // Validate the challenge: a phone-tap "prompt" polls; sms/email needs a code.
      if (challengeType === 'prompt') {
        if (!challengeId) return json(400, { ok: false, error: 'challengeId required' });
        const { validated } = await pollPrompt(challengeId);
        if (!validated) return json(200, { ok: true, connected: false, pending: true });
      } else {
        const code = body.mfaCode ? String(body.mfaCode) : '';
        if (!code) return json(400, { ok: false, error: 'mfaCode required' });
        if (challengeId) {
          const ch = await respondChallenge(challengeId, code);
          if (!ch.ok) return json(401, { ok: false, error: ch.error });
        }
      }

      // Finalize the workflow, then re-request the token with the same device.
      await finalizeWorkflow(machineId).catch(() => ({ approved: false }));
      const res = await login(username, password, { deviceToken });
      if (!res.ok || !res.creds) {
        // Not ready yet (approval still propagating) — let the client poll again.
        if (res.deviceApproval || res.mfaRequired) return json(200, { ok: true, connected: false, pending: true });
        return json(401, { ok: false, error: res.error || 'device approval failed' });
      }
      return await storeAndVerify(res.creds);
    }

    return json(400, { ok: false, error: "action must be 'status' | 'connect' | 'poll' | 'disconnect'" });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('broker_auth_failed', { err: msg, action });
    return json(500, { ok: false, error: msg });
  }
};
