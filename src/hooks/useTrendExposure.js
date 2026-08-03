import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { validate, SHAPES, fetchWithRetry } from '../lib/validateResponse.js';

// TREND-1 — EDGAR filing-mention attribution.
//
// Query is disabled until the user actually submits a phrase: this endpoint
// hits SEC on our shared User-Agent budget, so it must never fire on every
// keystroke. staleTime is long (30 min, matching the function's public
// cache-control) because filing text only changes on filing cadence.
export function useTrendExposure(phrase, { forms = '10-K', days = 730, enabled = true } = {}) {
  const q = (phrase ?? '').trim();

  return useQuery({
    queryKey: queryKeys.trendExposure(q, forms, days),
    enabled: Boolean(q) && enabled,
    queryFn: async ({ signal }) => {
      const url =
        `/api/trend-exposure?q=${encodeURIComponent(q)}` +
        `&forms=${encodeURIComponent(forms)}&days=${days}`;
      const r = await fetchWithRetry(url, { signal });
      const json = await r.json();
      if (!r.ok || json.error) throw new Error(json.error || `HTTP ${r.status}`);
      return validate(json, SHAPES.trendExposure, 'trend-exposure');
    },
    // No `retry` here on purpose: fetchWithRetry already makes 3 attempts,
    // and a query-level retry on top of it turns one SEC throttle into six
    // requests against a shared 10 req/sec budget.
    staleTime: 30 * 60 * 1000,
  });
}
