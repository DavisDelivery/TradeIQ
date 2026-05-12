import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// useBacktestRuns — list recent backtest runs from /api/backtest-runs.
//
// Runs are immutable historical records, so we'd normally cache forever.
// But we still want list to refetch periodically so newly-completed runs
// show up — 30s staleTime is the right tradeoff.
//
// Returns { data: { ok, runs, count }, isLoading, error, refetch }.

export function useBacktestRuns(limit = 20) {
  return useQuery({
    queryKey: queryKeys.backtestRuns(limit),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs?limit=${limit}`, { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${r.status}`);
      }
      return json;
    },
    staleTime: 30_000,
  });
}
