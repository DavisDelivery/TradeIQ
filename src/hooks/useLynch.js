import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Peter Lynch GARP candidates. staleTime 10 min per brief — fundamentals
// don't change intraday, so longer cache is safe.

export function useLynch(universe) {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/lynch-board?index=${universe}&limit=30${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: queryKeys.lynch(universe),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.lynch, 'lynch');
    },
    staleTime: 10 * 60 * 1000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.lynch, 'lynch');
    qc.setQueryData(queryKeys.lynch(universe), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
