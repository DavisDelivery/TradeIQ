// Robinhood REST client — server-side execution path (Option B).
//
// WHY THIS EXISTS: the owner wants to click Buy/Sell in TradeIQ and have the
// order actually placed, with no agent/chat session in the loop. TradeIQ's
// backend therefore needs its own path to Robinhood. Robinhood has no
// official retail API, so this talks to the same private endpoints the
// mobile app uses (the well-known public client_id). The owner has
// explicitly accepted the tradeoffs: the token is a money-moving credential
// held in our infra, and using the private client leans against Robinhood's
// terms (accounts can be flagged for unofficial API use).
//
// SECURITY POSTURE:
//   - We store OAuth tokens (access + refresh), NEVER the username/password.
//   - Tokens live in Firestore (brokerAuth/robinhood), refreshed on demand.
//   - Every caller is behind the app login (verifyOwnerBearer).
//   - Execution enforces guardrails at the call site (per-order cap,
//     long-only) — see broker-execute.ts.
//
// TESTABILITY: the network boundary is a single injectable `httpFn` so unit
// tests exercise the flow without touching Robinhood. The live auth flow is
// validated on first real connect (it cannot be tested from CI).

import { randomUUID, createHash } from 'node:crypto';
import { getAdminDb } from './firebase-admin';

const API = 'https://api.robinhood.com';
// Robinhood's mobile-app public OAuth client id (same one robin_stocks and
// the official app use). Not a secret — it identifies the client, not the user.
const CLIENT_ID = 'c82SH0WZOsabOXGP2sxqcj34FxkvfnWRZBKlBjFS';
const CREDS_DOC = 'brokerAuth/robinhood';

export interface StoredCreds {
  accessToken: string;
  refreshToken: string;
  expiresAt: string; // ISO
  deviceToken: string;
  accountUrl?: string;
  accountNumber?: string;
  connectedAt?: string;
}

export type HttpFn = (
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string },
) => Promise<{ status: number; json: () => Promise<any> }>;

const defaultHttp: HttpFn = async (url, init) => {
  const res = await fetch(url, init as any);
  return { status: res.status, json: () => res.json().catch(() => ({})) };
};

function authHeaders(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json',
    // The mobile app sends these; some endpoints 400 without a UA.
    'user-agent': 'TradeIQ/1.0 (RobinhoodClient)',
  };
  if (token) h['authorization'] = `Bearer ${token}`;
  return h;
}

// ---------------- token store (Firestore) ----------------

export async function loadCreds(): Promise<StoredCreds | null> {
  const snap = await getAdminDb().doc(CREDS_DOC).get();
  return snap.exists ? (snap.data() as StoredCreds) : null;
}

export async function saveCreds(c: StoredCreds): Promise<void> {
  await getAdminDb().doc(CREDS_DOC).set(c, { merge: true });
}

export async function clearCreds(): Promise<void> {
  await getAdminDb().doc(CREDS_DOC).delete();
}

// ---------------- auth ----------------

export interface LoginResult {
  ok: boolean;
  /** MFA/challenge is required — the caller must re-submit with a code. */
  mfaRequired?: boolean;
  mfaType?: string;
  /** verification "challenge" id (older SMS challenge flow). */
  challengeId?: string;
  /** Modern device-approval path: Robinhood wants the user to approve the
   *  login in their phone app, driven through the Pathfinder workflow. */
  deviceApproval?: boolean;
  workflowId?: string;
  deviceToken?: string;
  creds?: StoredCreds;
  error?: string;
}

/** A device token is stable per "device"; reuse it across a connect attempt
 *  so Robinhood ties the MFA approval to the same device. */
export function newDeviceToken(seed?: string): string {
  if (seed) {
    // Deterministic device token from a seed (keeps retries stable in tests).
    return [
      seed.slice(0, 8), seed.slice(8, 12), seed.slice(12, 16), seed.slice(16, 20), seed.slice(20, 32),
    ].join('-');
  }
  return randomUUID();
}

/**
 * Password-grant login. On success returns tokens; if Robinhood demands a
 * second factor it returns mfaRequired/challengeId for the caller to satisfy
 * and then call again with `mfaCode` (+ same deviceToken/challengeId).
 */
export async function login(
  username: string,
  password: string,
  opts: { mfaCode?: string; deviceToken?: string; challengeId?: string; http?: HttpFn } = {},
): Promise<LoginResult> {
  const http = opts.http ?? defaultHttp;
  const deviceToken = opts.deviceToken ?? newDeviceToken();
  const payload: Record<string, unknown> = {
    client_id: CLIENT_ID,
    expires_in: 86400,
    grant_type: 'password',
    password,
    scope: 'internal',
    username,
    challenge_type: 'sms',
    device_token: deviceToken,
    try_passkeys: false,
    token_request_path: '/login',
    create_read_only_secondary_token: true,
  };
  if (opts.mfaCode) payload.mfa_code = opts.mfaCode;

  const headers = authHeaders();
  // Older SMS-challenge flow: echo the approved challenge id back as a header.
  if (opts.challengeId) headers['x-robinhood-challenge-response-id'] = opts.challengeId;

  const res = await http(`${API}/oauth2/token/`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  const data = await res.json();

  if (data?.access_token && data?.refresh_token) {
    const creds: StoredCreds = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: new Date(Date.now() + (Number(data.expires_in) || 86400) * 1000).toISOString(),
      deviceToken,
      connectedAt: new Date().toISOString(),
    };
    return { ok: true, creds, deviceToken };
  }
  if (data?.mfa_required) {
    return { ok: false, mfaRequired: true, mfaType: String(data.mfa_type ?? 'app'), deviceToken };
  }
  // Verification-workflow / SMS challenge shape.
  if (data?.challenge?.id) {
    return { ok: false, mfaRequired: true, mfaType: String(data.challenge.type ?? 'sms'), challengeId: String(data.challenge.id), deviceToken };
  }
  if (data?.verification_workflow?.id) {
    // Modern flow: the caller must drive the Pathfinder verification workflow
    // (beginDeviceApproval → pollPrompt/respondChallenge → finalizeWorkflow)
    // and then call login() again with the same deviceToken.
    return { ok: false, deviceApproval: true, workflowId: String(data.verification_workflow.id), deviceToken };
  }
  return { ok: false, error: String(data?.detail || data?.error_description || data?.error || 'login failed'), deviceToken };
}

/** Respond to the SMS/verification challenge, then the caller retries login. */
export async function respondChallenge(
  challengeId: string,
  code: string,
  http: HttpFn = defaultHttp,
): Promise<{ ok: boolean; error?: string }> {
  const res = await http(`${API}/challenge/${challengeId}/respond/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ response: code }),
  });
  const data = await res.json();
  if (data?.status === 'validated') return { ok: true };
  return { ok: false, error: String(data?.detail || 'challenge not validated') };
}

// ---------------- device-approval (Pathfinder verification workflow) ----------------
//
// Robinhood's current login for a new device returns a `verification_workflow`
// instead of tokens. Approving the push on the phone is NOT enough on its own —
// the client must create a Pathfinder "user machine", read the challenge, wait
// for the approval to validate, then POST "continue" to finalize the workflow.
// Only then does re-requesting the token succeed. (This is why simply
// re-submitting the login after tapping Approve does nothing.)

export interface DeviceApprovalStart {
  machineId: string;
  challengeType: string;    // 'prompt' | 'sms' | 'email'
  challengeId: string | null;
  status: string;           // 'issued' | 'validated' | ...
}

/** Step 2–3: create the verification machine and read the sheriff challenge.
 *  Retries the inquiry read a few times since the challenge can lag the POST. */
export async function beginDeviceApproval(
  workflowId: string,
  deviceToken: string,
  http: HttpFn = defaultHttp,
): Promise<DeviceApprovalStart> {
  const mk = await http(`${API}/pathfinder/user_machine/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ device_id: deviceToken, flow: 'suv', input: { workflow_id: workflowId } }),
  });
  const machine = await mk.json();
  const machineId = machine?.id;
  if (!machineId) throw new Error('could not start Robinhood device approval');

  // Read the inquiry to discover the challenge (type/id/status).
  const inq = await readInquiry(String(machineId), http);
  return { machineId: String(machineId), ...inq };
}

/** GET the inquiry user_view and extract the sheriff challenge. */
export async function readInquiry(
  machineId: string,
  http: HttpFn = defaultHttp,
): Promise<{ challengeType: string; challengeId: string | null; status: string }> {
  const res = await http(`${API}/pathfinder/inquiries/${machineId}/user_view/`, {
    method: 'GET',
    headers: authHeaders(),
  });
  const data = await res.json();
  const ch = data?.context?.sheriff_challenge ?? {};
  return {
    challengeType: String(ch.type ?? 'prompt'),
    challengeId: ch.id != null ? String(ch.id) : null,
    status: String(ch.status ?? 'issued'),
  };
}

/** Step 4 (prompt): has the phone-app approval validated yet? */
export async function pollPrompt(
  challengeId: string,
  http: HttpFn = defaultHttp,
): Promise<{ validated: boolean }> {
  const res = await http(`${API}/push/${challengeId}/get_prompts_status/`, {
    method: 'GET',
    headers: authHeaders(),
  });
  const data = await res.json();
  return { validated: String(data?.challenge_status ?? '') === 'validated' };
}

/** Step 5: finalize the workflow — tell Robinhood to continue past the
 *  now-validated challenge. Returns whether the workflow is approved. */
export async function finalizeWorkflow(
  machineId: string,
  http: HttpFn = defaultHttp,
): Promise<{ approved: boolean }> {
  const res = await http(`${API}/pathfinder/inquiries/${machineId}/user_view/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({ sequence: 0, user_input: { status: 'continue' } }),
  });
  const data = await res.json();
  const result = data?.type_context?.result ?? data?.verification_workflow?.workflow_status;
  return { approved: String(result ?? '') === 'workflow_status_approved' };
}

/** Refresh an access token from the stored refresh token. */
export async function refresh(creds: StoredCreds, http: HttpFn = defaultHttp): Promise<StoredCreds> {
  const res = await http(`${API}/oauth2/token/`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify({
      client_id: CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: creds.refreshToken,
      scope: 'internal',
      device_token: creds.deviceToken,
    }),
  });
  const data = await res.json();
  if (!data?.access_token) {
    throw new Error(String(data?.detail || data?.error_description || 'token refresh failed — reconnect Robinhood'));
  }
  return {
    ...creds,
    accessToken: data.access_token,
    refreshToken: data.refresh_token || creds.refreshToken,
    expiresAt: new Date(Date.now() + (Number(data.expires_in) || 86400) * 1000).toISOString(),
  };
}

/** Load stored creds, refreshing (and persisting) if the access token is
 *  within 5 minutes of expiry. Throws if not connected. */
export async function ensureToken(http: HttpFn = defaultHttp): Promise<StoredCreds> {
  const creds = await loadCreds();
  if (!creds) throw new Error('Robinhood not connected');
  const soon = Date.now() + 5 * 60 * 1000;
  if (new Date(creds.expiresAt).getTime() <= soon) {
    const refreshed = await refresh(creds, http);
    await saveCreds(refreshed);
    return refreshed;
  }
  return creds;
}

// ---------------- account + instruments ----------------

export interface AccountInfo {
  accountUrl: string;
  accountNumber: string;
  buyingPower: number | null;
  cash: number | null;
}

export async function getAccount(token: string, http: HttpFn = defaultHttp): Promise<AccountInfo> {
  const res = await http(`${API}/accounts/`, { method: 'GET', headers: authHeaders(token) });
  const data = await res.json();
  const a = data?.results?.[0];
  if (!a?.url) throw new Error('could not read Robinhood account');
  return {
    accountUrl: a.url,
    accountNumber: String(a.account_number ?? ''),
    buyingPower: a.buying_power != null ? Number(a.buying_power) : null,
    cash: a.cash != null ? Number(a.cash) : null,
  };
}

export async function getInstrument(
  token: string,
  symbol: string,
  http: HttpFn = defaultHttp,
): Promise<{ instrumentUrl: string; tradable: boolean }> {
  const res = await http(`${API}/instruments/?symbol=${encodeURIComponent(symbol)}`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const data = await res.json();
  const i = data?.results?.[0];
  if (!i?.url) throw new Error(`no Robinhood instrument for ${symbol}`);
  return { instrumentUrl: i.url, tradable: i.tradability === 'tradable' && i.state === 'active' };
}

/** Latest trade price for a symbol (for market-order cap checks). */
export async function getQuote(token: string, symbol: string, http: HttpFn = defaultHttp): Promise<number | null> {
  const res = await http(`${API}/quotes/${encodeURIComponent(symbol)}/`, {
    method: 'GET',
    headers: authHeaders(token),
  });
  const data = await res.json();
  const px = data?.last_trade_price ?? data?.last_extended_hours_trade_price;
  return px != null ? Number(px) : null;
}

// ---------------- orders ----------------

export interface OrderRequest {
  accountUrl: string;
  instrumentUrl: string;
  symbol: string;
  side: 'buy' | 'sell';
  quantity: number;
  /** omit for a market order */
  limitPrice?: number;
}

export interface OrderResult {
  id: string;
  state: string;
  raw: any;
}

export async function placeEquityOrder(
  token: string,
  req: OrderRequest,
  http: HttpFn = defaultHttp,
): Promise<OrderResult> {
  const isLimit = Number.isFinite(req.limitPrice) && (req.limitPrice as number) > 0;
  const payload: Record<string, unknown> = {
    account: req.accountUrl,
    instrument: req.instrumentUrl,
    symbol: req.symbol,
    type: isLimit ? 'limit' : 'market',
    time_in_force: 'gfd',
    trigger: 'immediate',
    quantity: String(req.quantity),
    side: req.side,
    extended_hours: false,
    ref_id: randomUUID(),
  };
  if (isLimit) payload.price = String(req.limitPrice);
  // Market orders on Robinhood require a collared price; the app sends
  // last_trade_price as `price` on market buys. Callers pass limitPrice for
  // that collar when they have a quote.

  const res = await http(`${API}/orders/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data?.id) {
    throw new Error(String(data?.detail || data?.non_field_errors?.[0] || 'order rejected by Robinhood'));
  }
  return { id: String(data.id), state: String(data.state ?? 'confirmed'), raw: data };
}

/** Native stop-loss (sell-stop) order — protection that lives at the broker. */
export async function placeStopLoss(
  token: string,
  req: { accountUrl: string; instrumentUrl: string; symbol: string; quantity: number; stopPrice: number },
  http: HttpFn = defaultHttp,
): Promise<OrderResult> {
  const payload: Record<string, unknown> = {
    account: req.accountUrl,
    instrument: req.instrumentUrl,
    symbol: req.symbol,
    type: 'market',
    time_in_force: 'gtc',
    trigger: 'stop',
    stop_price: String(req.stopPrice),
    quantity: String(req.quantity),
    side: 'sell',
    extended_hours: false,
    ref_id: randomUUID(),
  };
  const res = await http(`${API}/orders/`, {
    method: 'POST',
    headers: authHeaders(token),
    body: JSON.stringify(payload),
  });
  const data = await res.json();
  if (!data?.id) {
    throw new Error(String(data?.detail || data?.non_field_errors?.[0] || 'stop order rejected by Robinhood'));
  }
  return { id: String(data.id), state: String(data.state ?? 'confirmed'), raw: data };
}

/** Non-reversible check used in logs — never store the raw password. */
export function fingerprint(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 8);
}
