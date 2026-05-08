import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Health endpoint — meta status used by the Settings view's status panel.
// staleTime 30s per brief; no force-rescan path (just refetch).

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/health', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 30_000,
  });
}
