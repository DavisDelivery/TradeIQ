// Phase 6 PR-G — multi-ticker fan-out reading stock-detail for sortable
// board columns.
//
// Wraps TanStack Query's useQueries with the SAME query keys that
// useStockDetail uses, so:
//   - Two consumers of the same ticker (e.g. the FundamentalsStrip in a row
//     AND this hook's sortable column for the same row) share ONE network
//     call — no duplicate fetches across surfaces.
//   - Cache hits are instant; misses fan out in parallel.
//   - staleTime: Infinity → the QueryClient never refetches once data is
//     in, matching useStockDetail's session-memoized contract.
//
// The hook returns a `metricsByTicker` map keyed by uppercase ticker; each
// entry is the 5 metrics the FundamentalsStrip displays + the board
// sortable columns sort on. Tickers that haven't loaded yet are absent
// from the map; consumers fold them through the existing
// useSortable null-sorts-to-bottom behavior.

import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

/**
 * @typedef {Object} StockDetailMetrics
 * @property {number | null} marketCap
 * @property {number | null} pe
 * @property {number | null} ps
 * @property {number | null} roe
 * @property {number | null} debtEquity
 */

function extract(stockDetail) {
  const m = stockDetail?.metrics;
  if (!m) return { marketCap: null, pe: null, ps: null, roe: null, debtEquity: null };
  return {
    marketCap: m.valuation?.marketCap ?? null,
    pe: m.valuation?.pe ?? null,
    ps: m.valuation?.ps ?? null,
    roe: m.profitability?.roe ?? null,
    debtEquity: m.health?.debtEquity ?? null,
  };
}

export function useStockDetailsFanout(tickers, { enabled = true } = {}) {
  const normalized = Array.isArray(tickers)
    ? Array.from(new Set(tickers.filter((t) => typeof t === 'string' && t.trim()).map((t) => t.trim().toUpperCase())))
    : [];

  const queries = useQueries({
    queries: normalized.map((ticker) => ({
      queryKey: queryKeys.stockDetail(ticker),
      enabled: enabled && !!ticker,
      staleTime: Infinity,
      gcTime: Infinity,
      refetchOnWindowFocus: false,
      refetchOnReconnect: false,
      queryFn: async ({ signal }) => {
        const r = await fetchWithRetry(
          `/api/stock-detail?ticker=${encodeURIComponent(ticker)}`,
          { signal },
        );
        const json = await r.json();
        if (!r.ok || json?.ok === false || json?.error) {
          throw new Error(json?.error || `HTTP ${r.status}`);
        }
        return json;
      },
    })),
  });

  // Build a key-by-ticker map so callers don't need to know the input order.
  // Memoize on the array shape so the parent isn't re-rendering forever.
  const metricsByTicker = useMemo(() => {
    const map = {};
    for (let i = 0; i < normalized.length; i++) {
      const ticker = normalized[i];
      const q = queries[i];
      if (q?.data) map[ticker] = extract(q.data);
    }
    return map;
    // Re-derive whenever the data signature changes. We use the data
    // references rather than the queries array (which is a new array each
    // render) so the memo is meaningful.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [normalized.join('|'), ...queries.map((q) => q?.data)]);

  const isLoading = queries.some((q) => q.isLoading);
  const isFetching = queries.some((q) => q.isFetching);

  return { metricsByTicker, isLoading, isFetching };
}
