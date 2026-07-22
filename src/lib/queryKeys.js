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

  // Live price/%-change overlay (useLiveQuotes). Keyed by the sorted,
  // comma-joined ticker set so distinct board views share a cache when
  // they request the same symbols.
  liveQuotes: (key) => ['tradeiq', 'liveQuotes', key],

  // Board queries — keyed by universe so switching universes doesn't
  // pollute the previous universe's cache.
  targetBoard: (universe) => ['tradeiq', 'targetBoard', universe],
  prophet: (universe, conviction) =>
    ['tradeiq', 'prophet', universe, conviction ?? 'all'],
  // Catalyst is server-filtered (catalyst-board.ts reads `filter` +
  // `minConviction`), so the key MUST carry both — otherwise switching
  // filters is a cache no-op within staleTime and AlertsView's
  // filter=all/minConviction=low payload cross-pollutes CatalystView
  // (code-review-2026-06 M1).
  catalyst: (universe, filter, minConviction) =>
    ['tradeiq', 'catalyst', universe, filter ?? 'all', minConviction ?? 'all'],
  // Insider is server-windowed (`days=`), so the key carries windowDays —
  // otherwise the 30/60/90/180d selector silently serves the previous
  // window's rows within staleTime (code-review-2026-06 M2).
  insider: (universe, windowDays) =>
    ['tradeiq', 'insider', universe, windowDays ?? 90],
  // Sentiment is server-sorted (bullish|bearish); each sort is a distinct
  // payload, so it must be a distinct cache entry.
  sentiment: (universe, sort) =>
    ['tradeiq', 'sentiment', universe ?? 'sp500', sort ?? 'bullish'],
  williams: (universe) => ['tradeiq', 'williams', universe],
  // Crosses is server-filtered by type + window, so the key carries both
  // (same lesson as catalyst M1 / insider M2 — a key that omits a queryFn
  // input silently serves the previous filter's rows within staleTime).
  crosses: (type, days) => ['tradeiq', 'crosses', type ?? 'all', days ?? 365],
  lynch: (universe) => ['tradeiq', 'lynch', universe],
  earnings: (windowDays, universe) =>
    ['tradeiq', 'earnings', windowDays, universe ?? 'all'],

  // Non-board queries
  health: () => ['tradeiq', 'health'],
  regime: () => ['tradeiq', 'regime'],
  analystsStatus: () => ['tradeiq', 'analystsStatus'],
  research: (ticker) => ['tradeiq', 'research', ticker],
  chartAnalysis: (ticker) => ['tradeiq', 'chartAnalysis', ticker],
  // Phase 4q — per-ticker analyst rationale (live recompute, session-
  // memoized: opening the same stock twice returns the cached payload
  // without re-fetching).
  targetRationale: (ticker) => ['tradeiq', 'targetRationale', ticker],
  // Phase 6 — per-ticker strategy rationale + comprehensive detail bundle
  // backing the StockDetailPanel. Same session-memoization model as
  // targetRationale (staleTime/gcTime Infinity): one fetch per ticker per
  // QueryClient lifetime, shared across every surface that opens the panel.
  williamsRationale: (ticker) => ['tradeiq', 'williamsRationale', ticker],
  lynchRationale: (ticker) => ['tradeiq', 'lynchRationale', ticker],
  stockDetail: (ticker) => ['tradeiq', 'stockDetail', ticker],
  // Phase 6 PR-C — per-(ticker,range) daily price bars. Cached together
  // with the older Phase-4j 6M default, so the legacy PriceChart and the
  // new detail-panel toggle share fetches when ranges overlap.
  priceHistory: (ticker, range) => ['tradeiq', 'priceHistory', ticker, range],
  snapshotHistory: (board) => ['tradeiq', 'snapshotHistory', board],
  optionsFlow: () => ['tradeiq', 'optionsFlow'],
  backtest: (lookback, tickers) => ['tradeiq', 'backtest', lookback, tickers],
  engineTest: (ticker) => ['tradeiq', 'engineTest', ticker],

  // DESK-1 — Desk workstation queries. deskStats/earningsRadar are keyed
  // by the sorted comma-joined ticker set (same convention as liveQuotes)
  // so the watchlist table shares one cache entry per ticker set.
  deskStats: (key) => ['tradeiq', 'deskStats', key],
  earningsRadar: (key) => ['tradeiq', 'earningsRadar', key],
  insiderDetail: (ticker) => ['tradeiq', 'insiderDetail', ticker],

  // Phase 4b — backtest run viewer (reads from backtestRuns/{runId} in
  // Firestore via /api/backtest-runs endpoints; separate from the legacy
  // engine-test "backtest" key above which talks to /api/backtest).
  backtestRuns: (limit) => ['tradeiq', 'backtestRuns', limit ?? 20],
  backtestRun: (runId) => ['tradeiq', 'backtestRun', runId ?? null],
};
