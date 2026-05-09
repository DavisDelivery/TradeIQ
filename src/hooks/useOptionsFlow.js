import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Options-flow board — unusual options activity scanner. Endpoint takes
// no params; result is the same for everyone, so we share one cache slot
// across the whole app. staleTime 5 min — flow changes throughout the
// session but not minute-by-minute.

export function useOptionsFlow() {
  return useQuery({
    queryKey: queryKeys.optionsFlow(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/options-flow', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.optionsFlow, 'options-flow');
    },
    staleTime: 5 * 60 * 1000,
  });
}
