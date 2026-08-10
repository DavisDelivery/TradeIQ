import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// PROFILE-1 W3 — one metric's peer distribution, fetched only when its
// drawer opens. `enabled` is the whole point: a closed drawer costs nothing,
// which is what makes reading the sharded universe affordable at all.

export function usePeerStat(ticker, metric, { enabled = false } = {}) {
  return useQuery({
    queryKey: queryKeys.peerStat(ticker, metric),
    enabled: Boolean(enabled && ticker && metric),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(
        `/api/peer-stats?ticker=${encodeURIComponent(ticker)}&metric=${encodeURIComponent(metric)}`,
        { signal },
      );
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    // The universe snapshot behind this refreshes every 15 min; a peer
    // distribution does not move faster than that.
    staleTime: 15 * 60 * 1000,
  });
}
