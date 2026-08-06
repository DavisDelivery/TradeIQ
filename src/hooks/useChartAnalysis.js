import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Chart analysis. AI narrative is OPT-IN.
//
// AI-1 (2026-08-06): this hook used to always request the Claude narrative,
// and ChartView calls it on mount with a default ticker of 'NVDA' — so simply
// opening the Chart tab spent tokens, which is exactly what the on-demand
// rule forbids. It survived the first pass because that pass only chased the
// Prophet paths. Default is now skipAi=1; the narrative is fetched only when
// the user presses "Generate AI read".

export function useChartAnalysis(ticker, lookback = 180, { withAi = false } = {}) {
  return useQuery({
    queryKey: queryKeys.chartAnalysis(ticker, withAi),
    enabled: !!ticker,
    queryFn: async ({ signal }) => {
      const url =
        `/api/chart-analysis?ticker=${encodeURIComponent(ticker)}&lookback=${lookback}` +
        (withAi ? '' : '&skipAi=1');
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.chartAnalysis, 'chart-analysis');
    },
    staleTime: 60_000,
  });
}
