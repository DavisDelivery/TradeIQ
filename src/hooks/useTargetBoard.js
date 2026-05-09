import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Target board — staleTime 60s per brief (intraday board, refresh more
// often is wasteful).
//
// forceRescan uses setQueryData (NOT invalidateQueries) — the user just
// asked for a fresh scan; the response IS the new ground truth, so we
// drop it directly into the cache instead of bouncing through a refetch.
// invalidateQueries here would defeat the user's force action.

export function useTargetBoard(universe) {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/target-board?limit=50&universe=${universe}${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: queryKeys.targetBoard(universe),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.targetBoard, 'target-board');
    },
    staleTime: 60_000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.targetBoard, 'target-board');
    qc.setQueryData(queryKeys.targetBoard(universe), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
