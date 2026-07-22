import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// News-sentiment board (Most Bullish / Most Bearish). Server-sorted by `sort`;
// staleTime 5 min — the snapshot refreshes on a daily-ish scan cadence, but a
// short client stale window keeps the bullish/bearish toggle snappy.
export function useSentiment(universe = 'sp500', sort = 'bullish') {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/sentiment-board?index=${universe}&sort=${sort}&limit=100${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: queryKeys.sentiment(universe, sort),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.sentimentBoard, 'sentiment-board');
    },
    staleTime: 5 * 60 * 1000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.sentimentBoard, 'sentiment-board');
    qc.setQueryData(queryKeys.sentiment(universe, sort), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
