// Phase 4k W1 — useBreakpoint hook resolves mobile vs desktop around
// the 1280px boundary and re-resolves when matchMedia fires a change.
//
// JSDOM does not ship matchMedia, so we install a controllable mock that
// lets us flip the result and trigger the change listener the hook
// subscribes to. The test simulates the contract the real browser
// provides: matches reflects the current width; subscribers fire on
// transitions.

import React from 'react';
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useBreakpoint, DESKTOP_BREAKPOINT_PX } from '../useBreakpoint.js';

function installMatchMedia(initialMatches) {
  let listeners = [];
  let currentMatches = initialMatches;
  const mql = {
    get matches() { return currentMatches; },
    media: `(min-width: ${DESKTOP_BREAKPOINT_PX}px)`,
    onchange: null,
    addEventListener: (event, cb) => {
      if (event === 'change') listeners.push(cb);
    },
    removeEventListener: (event, cb) => {
      if (event === 'change') listeners = listeners.filter((l) => l !== cb);
    },
    addListener: (cb) => listeners.push(cb),
    removeListener: (cb) => { listeners = listeners.filter((l) => l !== cb); },
    dispatchEvent: () => true,
  };
  const fn = vi.fn().mockImplementation(() => mql);
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    configurable: true,
    value: fn,
  });
  return {
    setMatches(next) {
      currentMatches = next;
      listeners.forEach((l) => l({ matches: next }));
    },
  };
}

describe('useBreakpoint (Phase 4k W1)', () => {
  let originalMatchMedia;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
  });

  afterEach(() => {
    if (originalMatchMedia) {
      Object.defineProperty(window, 'matchMedia', {
        writable: true,
        configurable: true,
        value: originalMatchMedia,
      });
    } else {
      // @ts-ignore — clean up the mock so it doesn't leak across files
      delete window.matchMedia;
    }
  });

  it('resolves to mobile below 1280px', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.isDesktop).toBe(false);
    expect(result.current.isMobile).toBe(true);
  });

  it('resolves to desktop at/above 1280px', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.isDesktop).toBe(true);
    expect(result.current.isMobile).toBe(false);
  });

  it('re-resolves when matchMedia emits a change (mobile → desktop)', () => {
    const ctl = installMatchMedia(false);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.isDesktop).toBe(false);
    act(() => ctl.setMatches(true));
    expect(result.current.isDesktop).toBe(true);
  });

  it('re-resolves when matchMedia emits a change (desktop → mobile)', () => {
    const ctl = installMatchMedia(true);
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.isDesktop).toBe(true);
    act(() => ctl.setMatches(false));
    expect(result.current.isDesktop).toBe(false);
  });

  it('falls back to mobile when matchMedia is unavailable', () => {
    // @ts-ignore — simulate an environment without matchMedia
    delete window.matchMedia;
    const { result } = renderHook(() => useBreakpoint());
    expect(result.current.isDesktop).toBe(false);
    expect(result.current.isMobile).toBe(true);
  });

  it('queries on the 1280px breakpoint', () => {
    installMatchMedia(false);
    renderHook(() => useBreakpoint());
    expect(window.matchMedia).toHaveBeenCalledWith(`(min-width: ${DESKTOP_BREAKPOINT_PX}px)`);
  });
});
