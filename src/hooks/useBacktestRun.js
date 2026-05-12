// Phase 4b — fetches one Phase 4a backtest run + its subcollections
// (dailyEquity, trades, attribution, mlTrainingCount) via
// /api/backtest-runs/:runId.
//
// staleTime is Infinity because historical runs are immutable: the engine
// writes the run doc and subcollections once and never updates them.
// Caching forever per runId means switching between selected runs in the
// list is instantaneous after first fetch.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

export function useBacktestRun(runId) {
  return useQuery({
    queryKey: queryKeys.backtestRun(runId),
    queryFn: async ({ signal }) => {
      const r = await fetchWithRetry(`/api/backtest-runs/${encodeURIComponent(runId)}`, {
        signal,
      });
      const ctype = r.headers.get('content-type') ?? '';
      if (!ctype.includes('json')) {
        const text = await r.text();
        throw new Error(`Server ${r.status}: ${text.slice(0, 120)}`);
      }
      const json = await r.json();
      if (!r.ok || json.error) {
        throw new Error(json.error || `HTTP ${r.status}`);
      }
      return {
        run: json.run ?? null,
        dailyEquity: Array.isArray(json.dailyEquity) ? json.dailyEquity : [],
        trades: Array.isArray(json.trades) ? json.trades : [],
        attribution: Array.isArray(json.attribution) ? json.attribution : [],
        mlTrainingCount: typeof json.mlTrainingCount === 'number' ? json.mlTrainingCount : 0,
      };
    },
    // Only fire once a run is selected. The list view default-selects the
    // first run, so this typically fires immediately after the list resolves.
    enabled: !!runId,
    // Immutable historical record — cache forever (per session).
    staleTime: Infinity,
  });
}
