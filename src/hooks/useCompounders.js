import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// COMP-1 — Compounders (quality-led, momentum-confirmed). The scan runs once
// a weekday at 21:40 UTC (netlify/functions/scan-compounders.ts) off month-end
// anchors and quarterly statements, so the payload changes at most once per
// market day and usually less: staleTime 10 min, same as quiet-strength,
// because polling harder cannot surface a number the scan has not recomputed.

export function useCompounders(limit = 40) {
  return useQuery({
    queryKey: queryKeys.compounders(limit),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/compounders-board?limit=${limit}`, { signal });
      const json = await r.json();
      // The endpoint attaches the evidence banner to its 500 as well, but a
      // thrown error is still the right outcome: `error` on the payload means
      // the rows are not a ranking, and rendering them under a banner would
      // present a failed read as a board.
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 10 * 60 * 1000,
  });
}
