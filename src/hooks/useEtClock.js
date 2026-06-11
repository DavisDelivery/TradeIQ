// code-review-2026-06 m6 — the ET clock in the regime strip was computed
// inline at render time, so it only updated on unrelated re-renders. This
// hook re-renders its consumer on a 30s interval (cleaned up on unmount)
// so the clock actually ticks.

import { useState, useEffect } from 'react';

export function formatEtTime(date = new Date()) {
  return date.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'America/New_York',
  });
}

export function useEtClock(intervalMs = 30_000) {
  const [label, setLabel] = useState(() => formatEtTime());
  useEffect(() => {
    const id = setInterval(() => setLabel(formatEtTime()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return label;
}
