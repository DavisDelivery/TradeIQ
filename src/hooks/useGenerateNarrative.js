// useGenerateNarrative — on-demand narration mutation for a Prophet pick.
//
// Lifecycle:
//   1. ProphetDetail renders the W1 placeholder for picks without a narrative.
//   2. User taps "Generate AI thesis" → calls mutation.mutate(pick).
//   3. POST /api/prophet-narrate with pick context (ticker, composite, layers...).
//   4. On success, patch every prophet query in the cache (across all
//      [universe, conviction] combinations) so a re-render shows the narrative
//      inline without a refetch.
//
// Errors annotate the message so the UI can distinguish rate-limit (429)
// from "narration_unavailable" (500 / circuit / budget).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';

export function useGenerateNarrative() {
  const qc = useQueryClient();

  return useMutation({
    mutationFn: async (pick) => {
      const body = {
        ticker: pick.ticker,
        composite: pick.composite,
        layers: pick.layers,
        conviction: pick.conviction,
        flags: pick.flags,
        entry: pick.entry,
        stop: pick.stop,
        targets: pick.targets,
        invalidation: pick.invalidation,
        price: pick.price,
        priceChangePct: pick.priceChangePct,
        name: pick.name,
        sector: pick.sector,
        layersPassed: pick.layersPassed,
      };
      const r = await fetch('/api/prophet-narrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      let json;
      try {
        json = await r.json();
      } catch {
        throw new Error(`HTTP ${r.status}`);
      }
      if (!r.ok || !json.ok) {
        const code = json?.error || `http_${r.status}`;
        if (r.status === 429) {
          throw new Error('rate_limit');
        }
        throw new Error(code);
      }
      return { ticker: pick.ticker, narrative: json.narrative, cached: !!json.cached };
    },

    onSuccess: ({ ticker, narrative }) => {
      // Patch every prophet query — there are multiple [universe, conviction]
      // entries in the cache and the user might switch tabs after generating.
      // The partial-key prefix matches them all.
      qc.setQueriesData({ queryKey: queryKeys.all }, (old) => {
        if (!old || !Array.isArray(old.picks)) return old;
        let touched = false;
        const nextPicks = old.picks.map((p) => {
          if (p.ticker === ticker) {
            touched = true;
            return { ...p, narrative };
          }
          return p;
        });
        return touched ? { ...old, picks: nextPicks } : old;
      });
    },
  });
}
