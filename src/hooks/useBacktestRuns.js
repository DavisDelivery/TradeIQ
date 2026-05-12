// Phase 4b — lists recent Phase 4a backtest runs from Firestore (via
// /api/backtest-runs). Used by BacktestView's run-list section.
//
// Separate from the legacy `useBacktest` hook (which talks to
// /api/backtest for the engine-test scanner). That one turns out to be
// unused by any view (EngineTestView uses useEngineTest), but Phase 4b
// leaves it in place — removal is a separate housekeeping pass.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useBacktestRuns(limit = 20) {
  return useQuery({
    queryKey: queryKeys.backtestRuns(limit),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs?limit=${limit}`, { signal });
      const ctype = r.headers.get('content-type') ?? '';
      if (!ctype.includes('json')) {
        const text = await r.text();
        throw new Error(`Server ${r.status}: ${text.slice(0, 120)}`);
      }
      const json = await r.json();
      if (!r.ok || json.error) {
        throw new Error(json.error || `HTTP ${r.status}`);
      }
      // Defensive: even if the endpoint omits `runs`, surface an empty
      // array so the view can render its empty state without crashing.
      return {
        runs: Array.isArray(json.runs) ? json.runs : [],
        generatedAt: json.generatedAt ?? null,
      };
    },
    // 30s — Phase 4a runs are slow-changing (one per CLI invocation),
    // but a user who just kicked off a CLI run and switches to the
    // viewer should see it within 30s rather than the React Query default.
    staleTime: 30 * 1000,
  });
}
