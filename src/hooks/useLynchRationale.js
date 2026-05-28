// Phase 6 — session-memoized per-ticker Lynch rationale.
//
// Backs the StockDetailPanel's hero + thesis when opened from the Lynch
// board. Calls /api/lynch-rationale?ticker=... — a live recompute that
// returns the decomposed GARP component breakdown, the synthesized thesis
// paragraph, and the falsifiable risk callouts.
//
// Memoization model mirrors useTargetRationale exactly: React-Query is the
// session memo (staleTime/gcTime Infinity), so opening the same ticker twice
// — from any surface — reuses the cached payload without re-fetching.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useLynchRationale(ticker, { enabled = true } = {}) {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  return useQuery({
    queryKey: queryKeys.lynchRationale(normalized),
    enabled: enabled && !!normalized,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/lynch-rationale?ticker=${encodeURIComponent(normalized)}`,
        { signal },
      );
      const json = await r.json();
      if (!r.ok || json?.ok === false || json?.error) {
        throw new Error(json?.error || `HTTP ${r.status}`);
      }
      return json;
    },
  });
}
