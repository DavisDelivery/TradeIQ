import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// useBacktestRun — fetch one backtest run + its subcollections from
// /api/backtest-runs/:runId.
//
// Historical runs are immutable. Once we have the data, we keep it
// forever (staleTime: Infinity). The hook is disabled when runId is
// falsy so we don't fire an HTTP request before the user selects one.
//
// Returns { data: { ok, run, dailyEquity, trades, tradesTruncated,
// attribution, mlTrainingCount }, isLoading, error }.

export function useBacktestRun(runId) {
  return useQuery({
    queryKey: queryKeys.backtestRun(runId),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs/${runId}`, { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) {
        throw new Error(json?.error || `HTTP ${r.status}`);
      }
      return json;
    },
    enabled: !!runId,
    staleTime: Infinity,
  });
}
