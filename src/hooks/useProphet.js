import { useQuery, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Prophet board — staleTime 60s per brief.
// Optional conviction param filters server-side; cache key includes it so
// switching conviction doesn't blow the previous filter's cache.

export function useProphet(universe, minConviction) {
  const qc = useQueryClient();
  const url = (force = false) => {
    const qs = new URLSearchParams({ universe, limit: '30' });
    if (minConviction) qs.set('minConviction', minConviction);
    if (force) qs.set('force', '1');
    return `/api/prophet-picks?${qs.toString()}`;
  };

  const query = useQuery({
    queryKey: queryKeys.prophet(universe, minConviction),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(url(false), { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.prophet, 'prophet');
    },
    staleTime: 60_000,
  });

  const forceRescan = async () => {
    const r = await fetchWithRetry(url(true));
    const json = await r.json();
    if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
    const validated = validate(json, SHAPES.prophet, 'prophet');
    qc.setQueryData(queryKeys.prophet(universe, minConviction), validated);
    return validated;
  };

  return { ...query, forceRescan };
}
