// Phase 6 — session-memoized comprehensive stock-detail bundle.
//
// Calls /api/stock-detail?ticker=... — the on-demand bundle behind everything
// in the detail panel that ISN'T the strategy rationale: metrics, sector-
// median context, catalysts, quarterly fundamentals history, and relative-
// strength series. Aggregated server-side from the existing providers (no
// snapshot bloat — Phase 4u lesson).
//
// This is the SINGLE shared client path for per-ticker detail data: every
// surface that needs fundamentals consumes it through this hook so one ticker
// = one fetch, deduped and reused for the QueryClient lifetime (the eventual
// FundamentalsStrip in PR-F reuses this exact hook — never a per-tab fetch).
//
// Honest no-data: ratio metrics that can't be sourced from the currently-
// wired providers come back as `null` with a sibling `_reason`; consumers
// render them as explicit "no data", never a fabricated zero. They light up
// automatically once the Phase 4w fundamentals migration lands.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useStockDetail(ticker, { enabled = true } = {}) {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  return useQuery({
    queryKey: queryKeys.stockDetail(normalized),
    enabled: enabled && !!normalized,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/stock-detail?ticker=${encodeURIComponent(normalized)}`,
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
