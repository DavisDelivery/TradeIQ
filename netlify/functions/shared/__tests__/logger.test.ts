// Logger smoke tests — confirms the JSON shape and the redaction behavior.
// We don't need to test every call site; the wrapping pattern is small enough
// that each function file will land its own log lines as it wires the logger.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createLogger } from '../logger';

let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
});

function lastLog(): any {
  const call = logSpy.mock.calls[logSpy.mock.calls.length - 1];
  return JSON.parse(call?.[0] as string);
}
function lastErr(): any {
  const call = errSpy.mock.calls[errSpy.mock.calls.length - 1];
  return JSON.parse(call?.[0] as string);
}

describe('createLogger', () => {
  it('emits a single-line JSON event with ts/level/fn/msg', () => {
    const log = createLogger('target-board');
    log.info('request', { universe: 'core' });
    const e = lastLog();
    expect(e.level).toBe('info');
    expect(e.fn).toBe('target-board');
    expect(e.msg).toBe('request');
    expect(e.universe).toBe('core');
    expect(typeof e.ts).toBe('string');
    expect(new Date(e.ts).toString()).not.toBe('Invalid Date');
  });

  it('routes errors to console.error', () => {
    const log = createLogger('target-board');
    log.error('boom', { code: 500 });
    expect(errSpy).toHaveBeenCalled();
    expect(lastErr().level).toBe('error');
    expect(lastErr().code).toBe(500);
  });

  it('redacts secret-shaped keys', () => {
    const log = createLogger('research');
    log.info('debug', { api_key: 'sk-...', token: 'abc', authorization: 'Bearer x' });
    const e = lastLog();
    expect(e.api_key).toBe('[redacted]');
    expect(e.token).toBe('[redacted]');
    expect(e.authorization).toBe('[redacted]');
  });

  it('serializes Error objects with name/message/stack', () => {
    const log = createLogger('research');
    const err = new Error('upstream failed');
    log.error('failed', { error: err });
    const e = lastErr();
    expect(e.error.name).toBe('Error');
    expect(e.error.message).toBe('upstream failed');
    expect(typeof e.error.stack).toBe('string');
  });

  it('child loggers inherit baseCtx and add their own', () => {
    const log = createLogger('catalyst-board').child({ requestId: 'r-1' });
    log.info('request', { universe: 'core' });
    const e = lastLog();
    expect(e.requestId).toBe('r-1');
    expect(e.universe).toBe('core');
    expect(e.fn).toBe('catalyst-board');
  });
});
