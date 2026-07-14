import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Golden/death cross feed (nightly snapshot; see scan-crosses-sp500.ts).
// staleTime 10 min: the underlying snapshot only changes once per market
// day, so aggressive refetching buys nothing.

export function useCrosses(type = 'all', days = 365) {
  return useQuery({
    // Key carries type + days: the server filters on both, so each combo
    // is a distinct payload and must be a distinct cache entry.
    queryKey: queryKeys.crosses(type, days),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/crosses?type=${type}&days=${days}`, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 10 * 60 * 1000,
  });
}
