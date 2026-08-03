import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// FVZ-3 — published screening strategies over the Finviz universe.
//
// Two queries because they have very different lifetimes: the CATALOG is
// static build-time data (screen names, evidence grades, citations) while the
// RESULTS depend on live quote data cached upstream for 15 minutes.
//
// staleTime 5 min for results — the server-side universe cache is 15 min, so
// refetching faster than that just re-serves the same rows. No `retry` here:
// the global default is retry:1 and fetchWithRetry already handles 502/503/504.

export function useScreenCatalog() {
  return useQuery({
    queryKey: queryKeys.screenCatalog(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/screens-board', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 60 * 60 * 1000,
  });
}

export function useScreen(screenId, universe = 'sp500') {
  return useQuery({
    // Both params drive the server response, so both must be in the key —
    // otherwise switching screen or universe is a cache no-op within staleTime.
    queryKey: queryKeys.screen(screenId, universe),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/screens-board?screen=${encodeURIComponent(screenId)}&universe=${encodeURIComponent(universe)}`,
        { signal },
      );
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    enabled: Boolean(screenId),
    staleTime: 5 * 60 * 1000,
  });
}
