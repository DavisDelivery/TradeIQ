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
  // withAi is part of the key: the AI and no-AI responses are different
  // payloads from the same endpoint (chart-analysis.ts keys its own cache the
  // same way at :121). Sharing one key would make the "Generate AI read"
  // button a no-op — it would re-serve the cached AI-less result.
  chartAnalysis: (ticker, withAi) => ['tradeiq', 'chartAnalysis', ticker, withAi ? 'ai' : 'noai'],
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

  // SECTOR-1 — cross-sector strength table. NO parameter on purpose: the
  // table is identical for every ticker, so one cache entry serves the whole
  // app rather than one per profile open.
  sectorPerformance: () => ['tradeiq', 'sectorPerformance'],

  // STOP-1 — server-side stop watcher record. No parameters: it is the whole
  // set of currently-observed breaches across the journal.
  stopWatch: () => ['tradeiq', 'stopWatch'],

  // Phase 4b — backtest run viewer (reads from backtestRuns/{runId} in
  // Firestore via /api/backtest-runs endpoints; separate from the legacy
  // engine-test "backtest" key above which talks to /api/backtest).
  backtestRuns: (limit) => ['tradeiq', 'backtestRuns', limit ?? 20],
  backtestRun: (runId) => ['tradeiq', 'backtestRun', runId ?? null],

  // TREND-1 — EDGAR filing-mention attribution. Server-parameterised by
  // phrase + form set + lookback window, so all three must be in the key
  // or switching forms/window is a cache no-op within staleTime.
  // CAMILLO-1 — AI research pass, keyed by ticker + universe because the
  // evidence differs per universe snapshot.
  camilloResearch: (ticker, universe) =>
    ['tradeiq', 'camilloResearch', ticker ?? '', universe ?? 'russell2k'],

  // FVZ-3 — published screening strategies. The catalog is static; results
  // are parameterised by screen AND universe, so both belong in the key.
  screenCatalog: () => ['tradeiq', 'screenCatalog'],
  screen: (screenId, universe) => ['tradeiq', 'screen', screenId ?? '', universe ?? 'sp500'],
};
