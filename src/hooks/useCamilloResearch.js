import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// CAMILLO-1 — the AI judgment pass, ON DEMAND ONLY.
//
// `enabled` defaults to false and the caller flips it on a click. This
// endpoint spends Anthropic budget on every call, so an auto-fire on panel
// open would burn the daily cap just by browsing a board. staleTime is long
// because the underlying evidence (a screener snapshot, a filing, a
// pageview series) does not move intraday.
export function useCamilloResearch(ticker, { universe = 'russell2k', enabled = false } = {}) {
  return useQuery({
    queryKey: queryKeys.camilloResearch(ticker, universe),
    enabled: Boolean(ticker) && enabled,
    queryFn: async ({ signal }) => {
      const url = `/api/camillo-research?ticker=${encodeURIComponent(ticker)}&universe=${universe}`;
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) {
        // 422 = deliberately refused for thin evidence. Surface the reason.
        throw new Error(json.message || json.error || `HTTP ${r.status}`);
      }
      return json;
    },
    staleTime: 60 * 60 * 1000,
    retry: false,   // an LLM call is expensive; never silently retry it
  });
}
