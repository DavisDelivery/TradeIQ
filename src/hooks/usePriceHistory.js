// Phase 6 PR-C — session-memoized daily price bars hook.
//
// Calls /api/price-history?ticker=X&range=R. The endpoint is itself cached
// per-day in Firestore (Phase 4j), and this hook layers React Query on top
// so simultaneous consumers (the new detail-panel chart, the legacy
// PriceChart component, any future ticker-info view) share a single fetch
// per (ticker, range) for the QueryClient lifetime.
//
// staleTime is `Infinity` because the upstream is cached per-day and the
// SPA reloads page-to-page; if Chad opens a 6M chart twice in a session
// we re-render from cache, never re-hit the network.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function usePriceHistory(ticker, range, { enabled = true } = {}) {
  const tk = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  const rg = typeof range === 'string' ? range : '6M';
  return useQuery({
    queryKey: queryKeys.priceHistory(tk, rg),
    enabled: enabled && !!tk,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/price-history?ticker=${encodeURIComponent(tk)}&range=${encodeURIComponent(rg)}`,
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
