import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Analyst roster + last-run health for each scanner. staleTime 30s per
// brief — this drives the green/yellow/red dots in the TopBar so it
// should feel responsive.

export function useAnalystsStatus() {
  return useQuery({
    queryKey: queryKeys.analystsStatus(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/analysts-status', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.analystsStatus, 'analysts-status');
    },
    staleTime: 30_000,
  });
}
