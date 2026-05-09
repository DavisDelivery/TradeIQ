// Centralized query-key factory for TanStack Query.
//
// Every query key is built from this factory so we have ONE place to look
// when invalidating, debugging, or grepping cache hits. Hierarchical keys
// (the array shape) make partial invalidation trivial, e.g.:
//   qc.invalidateQueries({ queryKey: queryKeys.all })  // wipe everything
//   qc.invalidateQueries({ queryKey: ['tradeiq', 'targetBoard'] })  // all universes
//
// Convention: the first segment is always 'tradeiq' (avoids collision in
// devtools when other keys leak in), the second is the noun, the rest are
// scoping params. Keys must be JSON-serializable.

export const queryKeys = {
  all: ['tradeiq'],

  // Board queries — keyed by universe so switching universes doesn't
  // pollute the previous universe's cache.
  targetBoard: (universe) => ['tradeiq', 'targetBoard', universe],
  prophet: (universe, conviction) =>
    ['tradeiq', 'prophet', universe, conviction ?? 'all'],
  catalyst: (universe) => ['tradeiq', 'catalyst', universe],
  insider: (universe) => ['tradeiq', 'insider', universe],
  williams: (universe) => ['tradeiq', 'williams', universe],
  lynch: (universe) => ['tradeiq', 'lynch', universe],
  earnings: (windowDays, universe) =>
    ['tradeiq', 'earnings', windowDays, universe ?? 'all'],

  // Non-board queries
  health: () => ['tradeiq', 'health'],
  regime: () => ['tradeiq', 'regime'],
  analystsStatus: () => ['tradeiq', 'analystsStatus'],
  research: (ticker) => ['tradeiq', 'research', ticker],
  chartAnalysis: (ticker) => ['tradeiq', 'chartAnalysis', ticker],
  snapshotHistory: (board) => ['tradeiq', 'snapshotHistory', board],
  optionsFlow: () => ['tradeiq', 'optionsFlow'],
  backtest: (lookback, tickers) => ['tradeiq', 'backtest', lookback, tickers],
  engineTest: (ticker) => ['tradeiq', 'engineTest', ticker],
};
