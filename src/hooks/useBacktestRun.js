// Phase 4b — fetches one Phase 4a backtest run + its subcollections
// (dailyEquity, trades, attribution, mlTrainingCount) via
// /api/backtest-runs/:runId.
//
// staleTime is Infinity for terminal runs (complete/failed) because
// historical runs are immutable: the engine writes the run doc and
// subcollections once and never updates them. Caching forever per
// runId means switching between selected runs in the list is
// instantaneous after first fetch.
//
// Phase 4b-2: refetchInterval added so the UI polls every 5s while a
// run is still pending or running (status from the trigger endpoint /
// background function). Once the run flips to 'complete' or 'failed',
// the interval returns false and polling stops, which means the
// staleTime: Infinity guarantee kicks in unchanged for terminal runs.

import { useQuery } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';
import { fetchWithRetry } from '../lib/validateResponse.js';

const POLL_INTERVAL_MS = 5_000;

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
    // Immutable historical record — cache forever (per session). For
    // pending/running runs, refetchInterval (below) overrides this to
    // refetch every 5s; staleTime is irrelevant while polling.
    staleTime: Infinity,
    // Phase 4b-2: poll while the run is still in-flight. Once it's
    // 'complete' or 'failed', polling stops (returns false). The full
    // detail payload — including the now-final metrics + subcollections
    // — is delivered on the same fetch that observes the terminal state.
    refetchInterval: (query) => {
      const status = query?.state?.data?.run?.status;
      if (status === 'pending' || status === 'running') return POLL_INTERVAL_MS;
      return false;
    },
  });
}
