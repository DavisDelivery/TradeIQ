// Phase 6 — session-memoized per-ticker Williams rationale.
//
// Backs the StockDetailPanel's hero + thesis when opened from the Williams
// board. Calls /api/williams-rationale?ticker=... — a live recompute that
// returns the decomposed per-component score breakdown, the synthesized
// thesis paragraph, and the falsifiable risk callouts that the thin board
// row does not carry.
//
// Memoization model mirrors useTargetRationale exactly: React-Query is the
// session memo (staleTime/gcTime Infinity), so opening the same ticker twice
// — from any surface — reuses the cached payload without re-fetching.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useWilliamsRationale(ticker, { enabled = true } = {}) {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  return useQuery({
    queryKey: queryKeys.williamsRationale(normalized),
    enabled: enabled && !!normalized,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/williams-rationale?ticker=${encodeURIComponent(normalized)}`,
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
