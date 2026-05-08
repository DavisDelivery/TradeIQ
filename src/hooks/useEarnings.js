import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Earnings board — staleTime 5 min per brief (calendar updates infrequently).
// Endpoint takes `days` (the lookahead window) not a universe arg.

export function useEarnings(windowDays = 7) {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/earnings-board?days=${windowDays}${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: queryKeys.earnings(windowDays),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.earningsBoard, 'earnings-board');
    },
    staleTime: 5 * 60 * 1000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.earningsBoard, 'earnings-board');
    qc.setQueryData(queryKeys.earnings(windowDays), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
