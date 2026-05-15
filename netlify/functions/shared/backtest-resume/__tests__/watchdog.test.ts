import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createWatchdog } from '../watchdog';

describe('createWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('isExpired() is false before the budget elapses', () => {
    const w = createWatchdog(10_000, () => {});
    w.start();
    expect(w.isExpired()).toBe(false);
    vi.advanceTimersByTime(9_999);
    expect(w.isExpired()).toBe(false);
    w.stop();
  });

  it('flips to expired exactly when the budget elapses', () => {
    const onExpiry = vi.fn();
    const w = createWatchdog(10_000, onExpiry);
    w.start();
    vi.advanceTimersByTime(10_000);
    expect(w.isExpired()).toBe(true);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('isExpired() stays true after expiry (sticky for break-out checks)', () => {
    const w = createWatchdog(100, () => {});
    w.start();
    vi.advanceTimersByTime(100);
    expect(w.isExpired()).toBe(true);
    // Time marches on; the flag must not flip back.
    vi.advanceTimersByTime(5_000);
    expect(w.isExpired()).toBe(true);
  });

  it('onExpiry fires at most once even with extra time elapsed', () => {
    const onExpiry = vi.fn();
    const w = createWatchdog(100, onExpiry);
    w.start();
    vi.advanceTimersByTime(100);
    vi.advanceTimersByTime(1_000);
    vi.advanceTimersByTime(1_000);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('stop() before expiry suppresses the callback and isExpired stays false', () => {
    const onExpiry = vi.fn();
    const w = createWatchdog(10_000, onExpiry);
    w.start();
    vi.advanceTimersByTime(9_000);
    w.stop();
    vi.advanceTimersByTime(10_000);
    expect(w.isExpired()).toBe(false);
    expect(onExpiry).not.toHaveBeenCalled();
  });

  it('start() can be called multiple times — each reset restarts the budget', () => {
    const onExpiry = vi.fn();
    const w = createWatchdog(1_000, onExpiry);
    w.start();
    vi.advanceTimersByTime(500);
    w.start(); // reset
    vi.advanceTimersByTime(500);
    // Total 1s elapsed, but only 500ms since latest start — budget not yet up.
    expect(w.isExpired()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(w.isExpired()).toBe(true);
    expect(onExpiry).toHaveBeenCalledTimes(1);
  });

  it('callback errors do not prevent isExpired from flipping', () => {
    const w = createWatchdog(100, () => {
      throw new Error('boom');
    });
    w.start();
    vi.advanceTimersByTime(100);
    expect(w.isExpired()).toBe(true);
  });

  it('stop() after expiry is a no-op (safe)', () => {
    const w = createWatchdog(100, () => {});
    w.start();
    vi.advanceTimersByTime(100);
    expect(() => w.stop()).not.toThrow();
    expect(w.isExpired()).toBe(true);
  });
});
