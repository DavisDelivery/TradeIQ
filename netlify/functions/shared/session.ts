// App-native session tokens — no Firebase Auth, no third-party OAuth.
// A compact HMAC-SHA256 signed token (JWT-shaped) minted by /api/auth-login
// after a password check, verified on trade-queue mutations. Stateless:
// the signature + expiry ARE the session; nothing stored server-side.
//
// Env:
//   OWNER_PASSWORD  — the app login password (the one thing you set once)
//   SESSION_SECRET  — HMAC key for signing tokens (random; rotating it
//                     signs everyone out). Both set via the Netlify env.

import { createHmac, timingSafeEqual } from 'node:crypto';

const b64url = (buf: Buffer) =>
  buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlJson = (obj: unknown) => b64url(Buffer.from(JSON.stringify(obj)));

function secret(): string {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 16) throw new Error('SESSION_SECRET unset or too short');
  return s;
}

const SESSION_DAYS = 30;

/** Mint a signed session token for the owner. */
export function signSession(subject = 'owner'): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64urlJson({ alg: 'HS256', typ: 'JWT' });
  const payload = b64urlJson({ sub: subject, iat: now, exp: now + SESSION_DAYS * 86400 });
  const sig = b64url(createHmac('sha256', secret()).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

export interface SessionCheck { ok: boolean; subject?: string; reason?: string }

/** Verify a session token's signature and expiry. */
export function verifySession(token: string): SessionCheck {
  const parts = token.split('.');
  if (parts.length !== 3) return { ok: false, reason: 'malformed' };
  const [header, payload, sig] = parts;
  const expected = b64url(createHmac('sha256', secret()).update(`${header}.${payload}`).digest());
  // Constant-time compare.
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return { ok: false, reason: 'bad signature' };
  try {
    const claims = JSON.parse(Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (typeof claims.exp === 'number' && claims.exp < Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: 'expired' };
    }
    return { ok: true, subject: String(claims.sub ?? 'owner') };
  } catch {
    return { ok: false, reason: 'unparseable' };
  }
}

/** Constant-time password check against OWNER_PASSWORD. */
export function checkPassword(supplied: string): { ok: boolean; configured: boolean } {
  const pw = process.env.OWNER_PASSWORD;
  if (!pw) return { ok: false, configured: false };
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(pw);
  const ok = a.length === b.length && timingSafeEqual(a, b);
  return { ok, configured: true };
}
