import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Full chart-analysis with AI narrative (no skipAi flag). This is the
// expensive variant — only fired when the user explicitly asks for it
// (e.g., opens the Chart tab for a ticker).

export function useChartAnalysis(ticker, lookback = 180) {
  return useQuery({
    queryKey: queryKeys.chartAnalysis(ticker),
    enabled: !!ticker,
    queryFn: async ({ signal }) => {
      const url = `/api/chart-analysis?ticker=${encodeURIComponent(ticker)}&lookback=${lookback}`;
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.chartAnalysis, 'chart-analysis');
    },
    staleTime: 60_000,
  });
}
