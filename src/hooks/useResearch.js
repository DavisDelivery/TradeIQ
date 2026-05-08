import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// "Research" view — the cheap variant of chart-analysis (skipAi=1) used
// inside the Target detail modal, Prophet detail, and Journal pages.
// Skipping AI keeps the call latency low enough to lazy-load on hover.
//
// `enabled` lets callers gate the query (e.g., only fire when a ticker
// is actually selected). When ticker is falsy we leave the cache empty
// instead of issuing a request.

export function useResearch(ticker, lookback = 180) {
  return useQuery({
    queryKey: queryKeys.research(ticker),
    enabled: !!ticker,
    queryFn: async ({ signal }) => {
      const url = `/api/chart-analysis?ticker=${encodeURIComponent(ticker)}&lookback=${lookback}&skipAi=1`;
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.chartAnalysis, 'chart-analysis');
    },
    staleTime: 60_000,
  });
}
