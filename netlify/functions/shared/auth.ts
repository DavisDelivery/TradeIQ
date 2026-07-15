// Login-gated endpoint auth — Firebase ID token verification (no shared
// secrets). The client signs in with Google (src/lib/auth.js) and sends
// `Authorization: Bearer <idToken>`; we verify the token cryptographically
// via the Admin SDK and require the email to be on the OWNER_EMAILS
// allowlist (comma-separated env var — an identifier, not a secret).
// FAIL-CLOSED: unset allowlist disables mutations rather than opening them.

import { getAdminAuth } from './firebase-admin';

export interface AuthResult {
  ok: boolean;
  email?: string;
  status?: number;
  error?: string;
}

export async function verifyOwnerBearer(
  headers: Record<string, string | undefined>,
): Promise<AuthResult> {
  const allow = (process.env.OWNER_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (!allow.length) {
    return { ok: false, status: 501, error: 'OWNER_EMAILS not configured — login-gated mutations disabled' };
  }
  const raw = headers['authorization'] ?? headers['Authorization'] ?? '';
  const token = raw.startsWith('Bearer ') ? raw.slice(7) : null;
  if (!token) return { ok: false, status: 401, error: 'sign in required (missing bearer token)' };
  try {
    const decoded = await getAdminAuth().verifyIdToken(token);
    const email = (decoded.email ?? '').toLowerCase();
    if (!email || !allow.includes(email)) {
      return { ok: false, status: 403, error: 'this account is not authorized for trading actions' };
    }
    return { ok: true, email };
  } catch {
    return { ok: false, status: 401, error: 'invalid or expired sign-in — sign in again' };
  }
}
