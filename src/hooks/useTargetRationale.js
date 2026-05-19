// Phase 4q — session-memoized per-ticker analyst rationale.
//
// Backs the inline accordion in AnalystContributions.jsx. Opening a row
// fires this hook (enabled-gated on ticker) which calls
// /api/target-rationale?ticker=... — a live recompute that returns the
// full per-analyst rationale + signals payload that the thin
// AnalystContribution[] on the board snapshot does not carry.
//
// Memoization model — React-Query is the session memo. We set
// `staleTime: Infinity` and `gcTime: Infinity` so a ticker fetched once
// is reused for the lifetime of the QueryClient (the tab session — no
// localStorage), and opening the same stock twice does not re-fetch.
// Re-opening across tab refresh re-fetches by design; the recompute is
// cheap relative to the value of showing the user a fresh score.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useTargetRationale(ticker, { enabled = true } = {}) {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  return useQuery({
    queryKey: queryKeys.targetRationale(normalized),
    enabled: enabled && !!normalized,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/target-rationale?ticker=${encodeURIComponent(normalized)}`,
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
