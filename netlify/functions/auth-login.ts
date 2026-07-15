// POST /api/auth-login  { password }  ->  { ok, token }
//
// App-native login (no Firebase, no OAuth): checks the password against
// OWNER_PASSWORD and returns a 30-day signed session token the client
// stores and sends as Authorization: Bearer on trade-queue mutations.
// FAIL-CLOSED: if OWNER_PASSWORD/SESSION_SECRET are unset, login is
// disabled (501) rather than open.

import type { Handler } from '@netlify/functions';
import { checkPassword, signSession } from './shared/session';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'auth-login' });

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });
  let body: any = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return json(400, { ok: false, error: 'invalid json' }); }

  if (!process.env.SESSION_SECRET) {
    return json(501, { ok: false, error: 'login not configured (SESSION_SECRET unset)' });
  }
  const { ok, configured } = checkPassword(String(body.password ?? ''));
  if (!configured) return json(501, { ok: false, error: 'login not configured (OWNER_PASSWORD unset)' });
  if (!ok) {
    log.warn('bad_password');
    return json(401, { ok: false, error: 'incorrect password' });
  }
  return json(200, { ok: true, token: signSession('owner') });
};
