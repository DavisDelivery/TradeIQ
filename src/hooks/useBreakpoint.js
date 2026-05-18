// Phase 4k W1 — viewport/breakpoint hook.
//
// Single source of truth for "are we at desktop width?" The whole desktop
// layout (sidebar nav, docked detail panel, dense tables) is gated behind
// this; below the breakpoint every consumer falls back to the existing
// mobile layout exactly as it was.
//
// Chad-locked breakpoint: 1280px (genuine desktop / large-laptop threshold;
// tablets and landscape phones stay on the mobile layout, which is the
// safer default for them).
//
// Implementation: matchMedia + a change listener. Defaults to mobile on
// the server / pre-mount so the first render never mis-claims desktop.

import { useEffect, useState } from 'react';

export const DESKTOP_BREAKPOINT_PX = 1280;
const DESKTOP_QUERY = `(min-width: ${DESKTOP_BREAKPOINT_PX}px)`;

function readDesktop() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
    return false;
  }
  return window.matchMedia(DESKTOP_QUERY).matches;
}

export function useBreakpoint() {
  const [isDesktop, setIsDesktop] = useState(readDesktop);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return undefined;
    }
    const mql = window.matchMedia(DESKTOP_QUERY);
    const handler = (e) => setIsDesktop(e.matches);
    // Re-sync once on mount so SSR / first-paint cases catch up to real width.
    setIsDesktop(mql.matches);
    // addEventListener is the modern API; Safari < 14 uses addListener.
    if (mql.addEventListener) {
      mql.addEventListener('change', handler);
      return () => mql.removeEventListener('change', handler);
    }
    mql.addListener(handler);
    return () => mql.removeListener(handler);
  }, []);

  return { isDesktop, isMobile: !isDesktop };
}
