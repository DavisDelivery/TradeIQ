// Single shared QueryClient instance used by the app.
//
// Defaults reflect the ergonomics this app needs:
//   - retry: 1     network blips on the Netlify functions are common; one
//                  retry catches transient failures without making a slow
//                  endpoint feel even slower
//   - staleTime: 0 individual hooks override this with their own per-board
//                  staleTime; 0 here means "by default, every query is
//                  immediately stale" so a hook that forgets to set
//                  staleTime always refetches on mount (safe behavior)
//   - refetchOnWindowFocus: true  Chad keeps a tab open all day; this
//                  picks up market-data changes when he tabs back without
//                  forcing a manual refresh
//   - refetchOnReconnect: true    same idea for network blips
//
// These match the snapshot-freshness model from Phase 1: the cache exists
// to dedupe in-flight requests and to give views fresh-from-snapshot
// reads, NOT to long-cache stale data.

import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      retryDelay: (attempt) => Math.min(1000 * 2 ** attempt, 8000),
      staleTime: 0,
      refetchOnWindowFocus: true,
      refetchOnReconnect: true,
      // Treat a server-returned `{ error: ... }` JSON as a thrown error.
      // The hooks themselves do the throw; this just keeps Sentry from
      // double-reporting a recoverable retry as a hard failure.
      throwOnError: false,
    },
  },
});
