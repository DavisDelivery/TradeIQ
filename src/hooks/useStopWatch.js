// STOP-1 — what the scheduled stop watcher has observed.
//
// This is a READ of a server-side record, not a client-side check. The
// distinction is the whole feature: the panel can only compare price to stop
// while it is on screen, and iOS Safari suspends a backgrounded tab, so a
// purely client-side rule cannot see a move through the stop that happened
// while the app was closed. The watcher runs on a schedule and remembers.
//
// Polls slowly (2 min) and never in the background — the record it reads is
// only refreshed every 15 minutes anyway, so a faster poll would buy nothing
// but function invocations.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useStopWatch() {
  const query = useQuery({
    queryKey: queryKeys.stopWatch(),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry('/api/stop-watch', { signal });
      const json = await r.json();
      if (!r.ok || json?.ok === false) throw new Error(json?.error || `HTTP ${r.status}`);
      return json;
    },
    staleTime: 60 * 1000,
    refetchInterval: 2 * 60 * 1000,
    refetchIntervalInBackground: false,
    placeholderData: (prev) => prev,
  });

  const breaches = query.data?.breaches || [];
  return {
    breaches,
    // Keyed by trade id so a row can look itself up. The stored key carries
    // the stop too (it re-arms when the stop moves) — the row only needs the
    // event that is live right now.
    breachByTradeId: Object.fromEntries(breaches.map((b) => [b.tradeId, b])),
    lastObserved: query.data?.lastObserved ?? null,
    // True only when the watcher SHOULD have run recently and did not. Outside
    // market hours this is false, because silence is expected then.
    stale: query.data?.stale === true,
    watching: query.data?.watching === true,
    // An outright fetch failure is not "all clear" either — callers that show
    // a green state must check this.
    error: query.error,
    isLoading: query.isLoading,
  };
}
