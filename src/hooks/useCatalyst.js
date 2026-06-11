import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

export function useCatalyst(universe, filter, minConviction) {
  const qc = useQueryClient();
  const url = (force = false) => {
    const qs = new URLSearchParams({ index: universe, limit: '40' });
    if (filter) qs.set('filter', filter);
    if (minConviction) qs.set('minConviction', minConviction);
    if (force) qs.set('force', '1');
    return `/api/catalyst-board?${qs.toString()}`;
  };

  const query = useQuery({
    // Key carries filter + minConviction: the server filters on both, so
    // every (universe, filter, minConviction) combination is a distinct
    // payload and must be a distinct cache entry (M1).
    queryKey: queryKeys.catalyst(universe, filter, minConviction),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.catalyst, 'catalyst');
    },
    staleTime: 60_000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.catalyst, 'catalyst');
    qc.setQueryData(queryKeys.catalyst(universe, filter, minConviction), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
