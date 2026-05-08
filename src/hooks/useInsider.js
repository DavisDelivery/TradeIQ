import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// staleTime 10 min per brief — insider data refreshes far less often than
// intraday boards.

export function useInsider(universe, windowDays = 90) {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/insider-board?days=${windowDays}&index=${universe}&limit=120${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: queryKeys.insider(universe),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.insiderBoard, 'insider-board');
    },
    staleTime: 10 * 60 * 1000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.insiderBoard, 'insider-board');
    qc.setQueryData(queryKeys.insider(universe), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
