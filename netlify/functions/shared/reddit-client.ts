// REDDIT OAUTH — the licensed route to the mention counts.
//
// ---------------------------------------------------------------------------
// WHY BOTHER, GIVEN APEWISDOM ALREADY WORKS
//
// ApeWisdom serves the same measurement free and keyless, and it is what
// `social-mentions.ts` uses today. The one thing it cannot give is a licence:
// it publishes no terms of service, no rate limits and no commercial-use
// statement. Fine for personal research, not fine as the backbone of anything
// that charges money.
//
// This module is that upgrade path. It is DORMANT until both env vars are set,
// so nothing changes for anyone who never registers.
//
// ---------------------------------------------------------------------------
// GETTING CREDENTIALS (as of 2026-08-04)
//
//   1. https://old.reddit.com/prefs/apps — the modern Reddit redesign and the
//      mobile app do not render this page; old.reddit does.
//   2. "create an app" -> type SCRIPT -> redirect uri http://localhost:8080
//   3. Client id is the short string under the app name; secret is beside it.
//   4. THEN follow the "register to use the API" link on that same form.
//      Reddit's own create-app page says "You must also register to use the
//      API" — since late 2025 (Responsible Builder Policy) creating the app
//      does NOT by itself yield a working token. Approval is a separate step.
//
// Set REDDIT_CLIENT_ID and REDDIT_CLIENT_SECRET. Never commit them.
//
// ---------------------------------------------------------------------------
// LICENCE BOUNDARY, STATED SO NOBODY CROSSES IT BY ACCIDENT
//
// The free tier is 100 QPM and is for NON-COMMERCIAL use. Reddit treats any
// revenue-generating project as commercial. If TradeIQ ever charges, this
// path needs a commercial agreement — swapping the vendor does not swap the
// obligation. `REDDIT_COMMERCIAL_ACK=1` is required to run it in an
// environment flagged as commercial, so the decision is explicit rather than
// something that drifted into production.

import { logger } from './logger';

const log = logger.child({ mod: 'reddit-client' });

const TOKEN_URL = 'https://www.reddit.com/api/v1/access_token';
const API = 'https://oauth.reddit.com';

/** Reddit requires a descriptive, unique UA. A generic one gets 429'd hard. */
export const USER_AGENT = 'web:tradeiq-social:v1.0 (by /u/DavisDelivery)';

/** Free tier ceiling, enforced by Reddit as a 10-minute rolling average. */
export const FREE_TIER_QPM = 100;

export class RedditNotConfiguredError extends Error {}
export class RedditAuthError extends Error {}

interface Token {
  value: string;
  /** Epoch ms. Refreshed early so a call never rides an expiring token. */
  expiresAt: number;
}

let cached: Token | null = null;

/** Exposed for tests — module-level token cache would otherwise leak between them. */
export function __resetTokenCache() {
  cached = null;
}

export function redditConfigured(): boolean {
  return Boolean(process.env.REDDIT_CLIENT_ID && process.env.REDDIT_CLIENT_SECRET);
}

/**
 * Client-credentials grant. A script app authenticates as itself; no user
 * login and no refresh token is involved.
 *
 * The token is cached in module scope and renewed 60s before expiry. On a
 * warm Netlify function that means one token fetch per instance rather than
 * one per call — which matters, because the token endpoint counts against
 * the same 100 QPM budget as the data calls.
 */
export async function getAccessToken(opts: { fetchImpl?: typeof fetch; now?: number } = {}): Promise<string> {
  const id = process.env.REDDIT_CLIENT_ID;
  const secret = process.env.REDDIT_CLIENT_SECRET;
  if (!id || !secret) {
    throw new RedditNotConfiguredError(
      'REDDIT_CLIENT_ID / REDDIT_CLIENT_SECRET are not set. Reddit is the licensed ' +
      'alternative to ApeWisdom and is optional — nothing degrades without it.',
    );
  }

  const now = opts.now ?? Date.now();
  if (cached && cached.expiresAt - 60_000 > now) return cached.value;

  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(TOKEN_URL, {
    method: 'POST',
    headers: {
      // HTTP Basic with the app id/secret — NOT a bearer token, and not a
      // query param. Reddit rejects both of those with a bare 401.
      Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
      'User-Agent': USER_AGENT,
    },
    body: 'grant_type=client_credentials',
  });

  if (!res.ok) {
    // 401 here almost always means the app was created but never approved —
    // Reddit issues the credentials at creation and gates the TOKEN, so the
    // failure surfaces one step later than people expect.
    const hint = res.status === 401
      ? ' — credentials rejected. If the app was created recently, check that you completed the separate "register to use the API" step; since late 2025 creating the app alone does not grant token access.'
      : '';
    throw new RedditAuthError(`Reddit token request failed: HTTP ${res.status}${hint}`);
  }

  const body: any = await res.json();
  const value = body?.access_token;
  const ttl = Number(body?.expires_in);
  if (!value || !Number.isFinite(ttl)) {
    throw new RedditAuthError('Reddit token response had no access_token');
  }

  cached = { value, expiresAt: now + ttl * 1000 };
  log.info('token_issued', { ttlSeconds: ttl });
  return value;
}

export interface RedditResult<T> {
  data: T | null;
  /** True only for a verified 200. Distinguishes "no data" from "could not look". */
  ok: boolean;
  status: number | null;
  reason: string | null;
  /** Requests remaining in the current window, per Reddit's own headers. */
  rateRemaining: number | null;
}

/**
 * GET against oauth.reddit.com.
 *
 * Returns a result object rather than throwing on HTTP failure, matching
 * quiver-client.ts: a 403 and an empty listing are different facts and the
 * caller must be able to tell them apart.
 */
export async function redditGet<T = unknown>(
  path: string,
  opts: { fetchImpl?: typeof fetch; searchParams?: Record<string, string> } = {},
): Promise<RedditResult<T>> {
  const doFetch = opts.fetchImpl ?? fetch;
  let token: string;
  try {
    token = await getAccessToken({ fetchImpl: doFetch });
  } catch (err: any) {
    return { data: null, ok: false, status: null, reason: String(err?.message ?? err), rateRemaining: null };
  }

  const qs = opts.searchParams ? `?${new URLSearchParams(opts.searchParams)}` : '';
  try {
    const res = await doFetch(`${API}${path}${qs}`, {
      headers: { Authorization: `Bearer ${token}`, 'User-Agent': USER_AGENT, Accept: 'application/json' },
    });
    const rateRemaining = Number(res.headers?.get?.('x-ratelimit-remaining'));
    const remaining = Number.isFinite(rateRemaining) ? rateRemaining : null;

    if (!res.ok) {
      // A 401 mid-session means the cached token died early; drop it so the
      // next call re-authenticates instead of looping on a stale token.
      if (res.status === 401) cached = null;
      return { data: null, ok: false, status: res.status, reason: `Reddit HTTP ${res.status}`, rateRemaining: remaining };
    }
    return { data: (await res.json()) as T, ok: true, status: 200, reason: null, rateRemaining: remaining };
  } catch (err: any) {
    return { data: null, ok: false, status: null, reason: String(err?.message ?? err), rateRemaining: null };
  }
}
