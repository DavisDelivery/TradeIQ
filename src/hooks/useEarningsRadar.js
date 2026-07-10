// DESK-1 W2 — batched earnings proximity + honest beat history.
// Server caches per ticker with a daily TTL; client staleTime 10 min.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useEarningsRadar(tickers) {
  const sorted = useMemo(
    () => [...new Set((tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean))].sort(),
    [tickers],
  );
  const key = sorted.join(',');

  const query = useQuery({
    queryKey: queryKeys.earningsRadar(key),
    enabled: sorted.length > 0,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/earnings-radar?tickers=${encodeURIComponent(key)}`, { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 10 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  return {
    radarByTicker: query.data?.radar || {},
    isLoading: query.isLoading,
    error: query.error,
  };
}
