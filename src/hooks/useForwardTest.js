import { useQuery } from '@tanstack/react-query';
import { fetchWithRetry } from '../lib/validateResponse.js';

// Forward-test league (per-board track record) + per-board pick logs.
// The league is a precomputed single-doc read; 15-min staleTime matches its
// nightly refresh cadence.

export function useForwardLeague() {
  return useQuery({
    queryKey: ['tradeiq', 'forward-league'],
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/forward-test', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 15 * 60 * 1000,
  });
}

export function useForwardPicks(board) {
  return useQuery({
    queryKey: ['tradeiq', 'forward-picks', board],
    enabled: Boolean(board),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/forward-test?board=${encodeURIComponent(board)}&limit=200`, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 15 * 60 * 1000,
  });
}
