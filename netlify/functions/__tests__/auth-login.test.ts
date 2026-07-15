import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { handler } from '../auth-login';
import { verifySession } from '../shared/session';

// /api/auth-login — password → signed session token. Fail-closed when the
// login isn't configured (501), 401 on a bad password, token on success.

const OLD = { ...process.env };
beforeEach(() => {
  process.env.SESSION_SECRET = 'test-secret-at-least-16-chars-long';
  process.env.OWNER_PASSWORD = 'let-me-in';
});
afterEach(() => {
  process.env = { ...OLD };
});

const post = (body?: any) =>
  handler({ httpMethod: 'POST', body: body ? JSON.stringify(body) : null } as any, {} as any, () => {}) as any;

describe('auth-login', () => {
  it('returns a verifiable session token for the correct password', async () => {
    const res = await post({ password: 'let-me-in' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
    expect(verifySession(body.token).ok).toBe(true);
  });

  it('401s on the wrong password (no token leaked)', async () => {
    const res = await post({ password: 'nope' });
    expect(res.statusCode).toBe(401);
    expect(JSON.parse(res.body).token).toBeUndefined();
  });

  it('501s when SESSION_SECRET is unset — never open', async () => {
    delete process.env.SESSION_SECRET;
    const res = await post({ password: 'let-me-in' });
    expect(res.statusCode).toBe(501);
  });

  it('501s when OWNER_PASSWORD is unset — never open', async () => {
    delete process.env.OWNER_PASSWORD;
    const res = await post({ password: 'let-me-in' });
    expect(res.statusCode).toBe(501);
  });

  it('rejects non-POST methods', async () => {
    const res = await handler({ httpMethod: 'GET' } as any, {} as any, () => {}) as any;
    expect(res.statusCode).toBe(405);
  });
});
