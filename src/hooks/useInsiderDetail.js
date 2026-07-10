// DESK-1 W3 — per-ticker 90d insider detail for the dossier INSIDER tab.
// Session-memoized like the other dossier fetches (server caches daily;
// re-opening the same ticker within the session must not re-fetch).

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useInsiderDetail(ticker, { enabled = true } = {}) {
  const normalized = typeof ticker === 'string' ? ticker.trim().toUpperCase() : '';
  return useQuery({
    queryKey: queryKeys.insiderDetail(normalized),
    enabled: enabled && !!normalized,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/insider-detail?ticker=${encodeURIComponent(normalized)}`,
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
