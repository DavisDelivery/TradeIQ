import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

// useLiveQuotes — batched live price + intraday %-change for a set of
// tickers, overlaid on top of the (older) scored board snapshot.
//
// Boards score price into a daily snapshot and then freeze it, so a card
// can read "16h ago" while the stock has moved. This hook polls
// /api/quotes (one Polygon market-snapshot call server-side) so the UI can
// always show a live price regardless of how old the scan is.
//
// Returns { quotesByTicker } — a map { TICKER: { price, changePct } }. A
// missing ticker means "no live quote"; callers fall back to the scored
// value, so this hook never blocks or breaks a render.
// DESK-1 — opts:
//   refetchIntervalMs — poll cadence override (the Desk tape runs 15s
//     vs the 30s board default). refetchIntervalInBackground stays false
//     so polling pauses whenever the tab is hidden/unfocused — this is
//     the Polygon-budget guard (visibilityState-driven via TanStack's
//     focusManager).
//   enabled — lets callers gate polling entirely (e.g. Desk unmount).
export function useLiveQuotes(tickers, opts = {}) {
  const { refetchIntervalMs = 30_000, enabled = true } = opts;
  const sorted = useMemo(
    () => [...new Set((tickers || []).map((t) => String(t || '').toUpperCase()).filter(Boolean))].sort(),
    [tickers],
  );
  const key = sorted.join(',');

  const query = useQuery({
    queryKey: queryKeys.liveQuotes(key),
    enabled: enabled && sorted.length > 0,
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/quotes?tickers=${encodeURIComponent(key)}`, { signal });
      const json = await r.json();
      if (!r.ok) throw new Error(json.error || `HTTP ${r.status}`);
      // Keep the server's asOf stamp — the Desk tape renders it so the
      // UI is honest about quote age (snapshot, not "real-time").
      return { quotes: json.quotes || {}, asOf: json.asOf ?? null };
    },
    // Quotes move; refresh while the board is open. Keep the previous
    // map during refetch so prices never flicker to the scored fallback
    // mid-poll.
    staleTime: Math.min(20_000, refetchIntervalMs),
    refetchInterval: refetchIntervalMs,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  return {
    quotesByTicker: query.data?.quotes || {},
    quotesAsOf: query.data?.asOf ?? null,
    dataUpdatedAt: query.dataUpdatedAt,
    isFetching: query.isFetching,
  };
}

// overlayQuotes — pure merge of a live-quote map onto a row list. Kept
// separate from the hook so it can be unit-tested without TanStack Query.
// The scored value is kept whenever a live quote is unavailable.
export function overlayQuotes(rows, quotesByTicker, opts = {}) {
  const { priceKey = 'price', pctKey = 'priceChangePct', tickerKey = 'ticker' } = opts;
  if (!rows || rows.length === 0) return rows || [];
  return rows.map((r) => {
    const q = quotesByTicker?.[String(r?.[tickerKey] || '').toUpperCase()];
    if (!q) return r;
    const next = { ...r };
    if (q.price != null) next[priceKey] = q.price;
    if (pctKey && q.changePct != null) next[pctKey] = q.changePct;
    return next;
  });
}

// useLiveRows — convenience wrapper: takes the board's rows, overlays live
// price/%-change onto each, and returns the merged list.
//
// opts.priceKey / opts.pctKey / opts.tickerKey let boards with different
// field names (e.g. underlyingPrice) reuse the same overlay.
export function useLiveRows(rows, opts = {}) {
  const { tickerKey = 'ticker' } = opts;
  const tickers = useMemo(
    () => (rows || []).map((r) => r?.[tickerKey]).filter(Boolean),
    [rows, tickerKey],
  );
  const { quotesByTicker } = useLiveQuotes(tickers);

  return useMemo(
    () => overlayQuotes(rows, quotesByTicker, opts),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, quotesByTicker, opts.priceKey, opts.pctKey, tickerKey],
  );
}
