// 4c-2 sieve budgets. Default values tuned for the russell universe
// (~2000 tickers) within the 15-min Netlify background-function timeout.
// W6 of the brief calls for empirical tuning after the first live run;
// adjust here, not in the stage modules.

export const SIEVE_BUDGETS = {
  // Stage 1: bars-only, all 2037 names. Aggressive bar cache makes this
  // mostly I/O-bound on cold misses.
  stage1: {
    budgetMs: 120_000,
    concurrency: 20,
    /** Survival: top N by composite, clamped to [min, max]. */
    survivors: { topPct: 0.20, min: 300, max: 600 },
    /** Optional minimum composite to survive on top of the percentile cut. */
    minComposite: 50,
  },
  // Stage 2: bars + fundamentals + earnings intel + RS-vs-SPY. Higher
  // per-ticker cost; gated to Stage 1 survivors.
  stage2: {
    budgetMs: 240_000,
    concurrency: 8,
    survivors: { topPct: 0.25, min: 60, max: 120 },
    minComposite: 60,
  },
  // Stage 3: full 7-layer scoring (existing scan-prophet logic).
  // Survivor count drops further; concurrency limited by Quiver tier.
  stage3: {
    budgetMs: 480_000,
    concurrency: 4,
  },
} as const;

/** Total budget across all stages — must stay under the 15-min container limit. */
export const SIEVE_TOTAL_BUDGET_MS =
  SIEVE_BUDGETS.stage1.budgetMs +
  SIEVE_BUDGETS.stage2.budgetMs +
  SIEVE_BUDGETS.stage3.budgetMs; // 840_000 = 14 min
