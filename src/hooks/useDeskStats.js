// DESK-1 W2 — batched per-ticker derived stats for the watchlist table.
// One /api/desk-stats call per distinct ticker set; stats derive from
// daily bars so a 5-minute staleTime is generous without being wasteful.

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useDeskStats(tickers) {
  const sorted = useMemo(
    () => [...new Set((tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean))].sort(),
    [tickers],
  );
  const key = sorted.join(',');

  const query = useQuery({
    queryKey: queryKeys.deskStats(key),
    enabled: sorted.length > 0,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/desk-stats?tickers=${encodeURIComponent(key)}`, { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 5 * 60 * 1000,
    placeholderData: (prev) => prev,
  });

  return {
    statsByTicker: query.data?.stats || {},
    warnings: query.data?.warnings || [],
    isLoading: query.isLoading,
    error: query.error,
  };
}
