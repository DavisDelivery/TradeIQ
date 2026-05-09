import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Larry Williams candidates board. staleTime 60s per brief (intraday).
// Side defaults to 'long' to match the existing view's default.

export function useWilliams(universe, side = 'long') {
  const qc = useQueryClient();
  const url = (force = false) =>
    `/api/williams-board?index=${universe}&side=${side}&limit=30${force ? '&force=1' : ''}`;

  const query = useQuery({
    queryKey: [...queryKeys.williams(universe), side],
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.williams, 'williams');
    },
    staleTime: 60_000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.williams, 'williams');
    qc.setQueryData([...queryKeys.williams(universe), side], validated);
    return validated;
  };

  return { ...query, forceRescan };
}
