// Single source of truth for the analyst weight table. Lives in its own
// module (rather than analyst-runner.ts) so lightweight consumers like
// analysts-status.ts can import the real weights without dragging the
// runner's provider/Firestore dependency graph into their bundle.
//
// Weights sum to 1.0 over the analysts that produce real signal.
// Political analyst (Quiver: congress + lobbying + contracts) gets a
// meaningful slice because it captures academic-backed alpha
// (Ziobrowski senate studies) plus sector-specific signals (defense
// contract flow, regulatory-win lobbying) that the other analysts miss.
//
// Phase 4f-finish — macro-regime and patent-analyst are pinned to 0
// (permanent removal) per `reports/phase-4f/audit.md` § 2:
//   - macro-regime: `no_upstream` — the analyst computes
//     `score = 50 + macroBias * 20` but macroBias defaults to 0 and is
//     never set by any caller (the regime-classifier upstream was
//     never wired in). Score is literally constant 50 across all 3600
//     observations in the W1 audit.
//   - patent-analyst: `no_upstream` for russell2k (1 unique value
//     across 3600 obs); kept conservatively at 0 globally since the
//     audit had 0 largecap target snapshots and `composeWeights`
//     absorbs the 6% redistribution cleanly. Phase 4g can re-introduce
//     a per-universe weight if largecap patent signal is recovered.
//
// Live weights (8 analysts): tech 0.15 + sector 0.08 + fund 0.13 +
//   flow 0.10 + news 0.10 + earnings 0.07 + insider 0.14 + political 0.10
//   = 0.87. composeWeights rescales the surviving 8 to sum to 1.0 on
//   the actual scored set per ticker.
export const ANALYST_WEIGHTS: Record<string, number> = {
  'technical-analyst': 0.15,
  'sector-rotation': 0.08,
  'fundamental-analyst': 0.13,
  'flow-analyst': 0.10,
  'news-sentiment': 0.10,
  'earnings-analyst': 0.07,
  'macro-regime': 0,        // REMOVED — no_upstream (see audit § 2)
  'insider-analyst': 0.14,
  'patent-analyst': 0,      // REMOVED — no_upstream (see audit § 2)
  'political-analyst': 0.10,
};
