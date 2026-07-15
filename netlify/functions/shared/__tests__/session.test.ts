import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { signSession, verifySession, checkPassword } from '../session';

// App-native session tokens (no Firebase): sign with SESSION_SECRET,
// verify signature + expiry, password-check against OWNER_PASSWORD.

const OLD = { ...process.env };
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.OWNER_PASSWORD = 'hunter2-correct';
});
afterEach(() => {
  process.env = { ...OLD };
});

describe('session tokens', () => {
  it('round-trips: a freshly signed token verifies with the owner subject', () => {
    const token = signSession('owner');
    expect(token.split('.')).toHaveLength(3);
    const res = verifySession(token);
    expect(res.ok).toBe(true);
    expect(res.subject).toBe('owner');
  });

  it('rejects a tampered payload (signature no longer matches)', () => {
    const token = signSession('owner');
    const [h, , s] = token.split('.');
    // Swap in a forged payload claiming a longer expiry; sig won't match.
    const forged = Buffer.from(JSON.stringify({ sub: 'owner', iat: 0, exp: 9999999999 }))
      .toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = verifySession(`${h}.${forged}.${s}`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad signature');
  });

  it('rejects a token signed with a different secret', () => {
    const token = signSession('owner');
    process.env.SESSION_SECRET = 'a-totally-different-secret-key!!';
    const res = verifySession(token);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('bad signature');
  });

  it('rejects an expired token', () => {
    // Mint a token whose exp is in the past by faking the clock via a
    // hand-built token signed with the real secret.
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const header = b64({ alg: 'HS256', typ: 'JWT' });
    const payload = b64({ sub: 'owner', iat: now - 100, exp: now - 10 });
    // Reuse verifySession's own signing by importing crypto inline.
    const { createHmac } = require('node:crypto');
    const sig = createHmac('sha256', process.env.SESSION_SECRET).update(`${header}.${payload}`).digest('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const res = verifySession(`${header}.${payload}.${sig}`);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('expired');
  });

  it('rejects a malformed token', () => {
    expect(verifySession('not-a-token').ok).toBe(false);
    expect(verifySession('a.b').ok).toBe(false);
  });

  it('throws when SESSION_SECRET is unset or too short (fail-closed)', () => {
    delete process.env.SESSION_SECRET;
    expect(() => signSession()).toThrow();
    process.env.SESSION_SECRET = 'short';
    expect(() => signSession()).toThrow();
  });
});

describe('password check', () => {
  it('accepts the exact password, rejects a wrong one', () => {
    expect(checkPassword('hunter2-correct')).toEqual({ ok: true, configured: true });
    expect(checkPassword('wrong')).toEqual({ ok: false, configured: true });
  });

  it('reports unconfigured when OWNER_PASSWORD is unset (fail-closed)', () => {
    delete process.env.OWNER_PASSWORD;
    expect(checkPassword('anything')).toEqual({ ok: false, configured: false });
  });
});
