import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// QS-1 — Quiet Strength (residual momentum). Nightly snapshot written at
// 22:40 UTC, so staleTime 10 min: the payload changes once per market day
// and polling harder buys nothing.

export function useQuietStrength(limit = 40) {
  return useQuery({
    queryKey: queryKeys.quietStrength(limit),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/quiet-strength-board?limit=${limit}`, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 10 * 60 * 1000,
  });
}
