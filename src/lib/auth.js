// Auth facade — app-native login (NO Firebase, no third-party OAuth).
// You sign in to TradeIQ itself with a password: POST /api/auth-login
// returns a 30-day signed session token that lives in localStorage and
// rides trade-queue mutations as Authorization: Bearer. The server
// verifies the token's HMAC signature + expiry (shared/session.ts).
// Nothing to copy-paste, no console to touch — just a password.

const TOKEN_KEY = 'tradeiq-session';
const listeners = new Set();

function read() {
  try { return localStorage.getItem(TOKEN_KEY) || null; } catch { return null; }
}
function write(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch { /* private mode — session-only, held in memory below */ }
  mem = token;
  for (const cb of listeners) { try { cb(token); } catch { /* ignore */ } }
}
// In-memory mirror so private-mode / storage-blocked browsers still work
// within a session.
let mem = read();

/** Decode the exp claim without verifying (verification is server-side). */
function isExpired(token) {
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000);
  } catch {
    return true; // unparseable → treat as expired
  }
}

/** Log in with the app password. Resolves on success, throws on failure. */
export async function login(password) {
  const r = await fetch('/api/auth-login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok || !j.token) throw new Error(j.error || `login failed (HTTP ${r.status})`);
  write(j.token);
  return true;
}

/** Sign out — drop the local session token. */
export function logout() {
  write(null);
}

/** The current session token (or null when signed out / expired). */
export function getToken() {
  const t = mem ?? read();
  if (t && isExpired(t)) { write(null); return null; }
  return t;
}

/** True when a live (unexpired) session token is held. */
export function isSignedIn() {
  return !!getToken();
}

// ---- compatibility shims for existing callers -------------------------
// OrderButtons / TradeQueuePanel were written against the old Google
// facade's getIdToken(). Keep the name so nothing else has to change:
// it now returns the app session token.
export async function getIdToken() {
  return getToken();
}

/** Subscribe to sign-in/out; fires with the token (or null). Returns unsub. */
export function onAuthChange(cb) {
  listeners.add(cb);
  // Emit current state on the next tick (matches the old async contract).
  Promise.resolve().then(() => cb(getToken()));
  return () => listeners.delete(cb);
}
