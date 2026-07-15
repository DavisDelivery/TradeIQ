// Login-gated endpoint auth — app-native session token (no Firebase Auth,
// no third-party OAuth). The client logs in with a password at
// /api/auth-login and sends Authorization: Bearer <session token>; we
// verify its HMAC signature + expiry here. FAIL-CLOSED: unset
// SESSION_SECRET disables mutations rather than opening them.

import { verifySession } from './session';

export interface AuthResult {
  ok: boolean;
  email?: string; // 'owner' — kept as the field name for callers
  status?: number;
  error?: string;
}

export async function verifyOwnerBearer(
  headers: Record<string, string | undefined>,
): Promise<AuthResult> {
  if (!process.env.SESSION_SECRET) {
    return { ok: false, status: 501, error: 'login not configured (SESSION_SECRET unset) — mutations disabled' };
  }
  const raw = headers['authorization'] ?? headers['Authorization'] ?? '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'sign in required' };
  const res = verifySession(token);
  if (!res.ok) return { ok: false, status: 401, error: `sign in again (${res.reason})` };
  return { ok: true, email: res.subject };
}
