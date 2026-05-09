import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// Macro regime — VIX/yields/risk-appetite. staleTime 30s per brief.
// Used by App's TopBar badge and the dedicated RegimeView, so a single
// shared cache entry deduplicates both consumers.

export function useRegime() {
  return useQuery({
    queryKey: queryKeys.regime(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/regime', { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.regime, 'regime');
    },
    staleTime: 30_000,
  });
}
