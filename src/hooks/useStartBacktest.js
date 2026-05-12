// Phase 4b-2 — POST /api/backtest-runs mutation hook.
//
// Wraps the trigger endpoint in a TanStack useMutation so the launcher
// component can call mutate(config) and observe { isPending, isError,
// isSuccess, data, error } reactively. On success, invalidates the
// backtestRuns list query so the new pending run pops to the top of
// the runs list in the parent view.
//
// Error surfacing: a 409 (in-flight conflict) is reported as a normal
// mutation error, but the error object is annotated with .status = 409
// and .runId = <existing>, so the launcher UI can render a "view it"
// link to that existing run. A 400 (validation) is also a mutation
// error, but without a runId — pure-text surface.

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';

export function useStartBacktest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (config) => {
      // POST /api/backtest-runs/start (NOT /api/backtest-runs).
      // Netlify's method-conditioned redirects are unreliable, so the
      // trigger lives at a distinct literal path — see netlify.toml.
      const r = await fetch('/api/backtest-runs/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(config),
      });
      // Defend against an HTML 500 page or a 502 from the gateway. Read
      // text first, then try to parse JSON — non-JSON bodies surface as
      // a generic error message rather than a JSON.parse crash.
      const text = await r.text();
      let json = null;
      try {
        json = JSON.parse(text);
      } catch {
        // ignore — handled below
      }
      if (!r.ok || json?.ok === false) {
        const err = new Error(
          json?.error || `HTTP ${r.status}: ${text.slice(0, 120) || 'no response body'}`,
        );
        // Annotate so the launcher can render 409 specifically.
        err.status = r.status;
        err.runId = json?.runId;
        throw err;
      }
      return json; // { ok: true, runId }
    },
    onSuccess: () => {
      // The new run is now in Firestore with status='pending'. Invalidate
      // the list query so it appears at the top of the run-list pane;
      // the launcher's UI also calls setSelectedRunId(runId) directly to
      // skip the user-click for navigation.
      qc.invalidateQueries({ queryKey: queryKeys.backtestRuns(20) });
      // We intentionally don't invalidate the per-run detail query —
      // that key is keyed on runId and there's no prior cache entry for
      // the new runId to invalidate. The detail hook fires its own
      // fetch when selectedRunId is set.
    },
  });
}
