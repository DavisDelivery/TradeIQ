# Track 4 — Frontend (src/ vs netlify/functions handlers)

3 critical, 6 major, ~14 minor findings. Two views crash outright (Catalyst
on data load, History on prophet replay), one interaction is dead (Earnings
"+ Log Trade"), and two react-query cache keys silently serve wrong-filter
data. Tests are mostly meaningful but their fixtures mask the worst unit bug.

## CRITICAL

**C1.** `src/CatalystView.jsx:76` — `onClick={load}` references an identifier
that does not exist in scope (the data-fetch was migrated to useCatalyst; the
old `load` function was deleted). The expression is evaluated during render
of the `data && !loading` block, so the ENTIRE Catalyst view throws
ReferenceError and falls into the ErrorBoundary the moment the board loads.
Should be `() => forceRescan()` (or query refetch). No test renders
CatalystView with data, which is why this shipped.

**C2.** `src/EarningsView.jsx:242` — `logTrade({...})` is called in the row's
onLog handler, but line 7 only imports `readLog` from ./tradeLog.js. Clicking
"+ Log Trade" on any expanded earnings setup throws an uncaught
ReferenceError; the trade is never logged (event-handler errors don't hit the
ErrorBoundary, so it fails silently for the user).

**C3.** `src/HistoryView.jsx:328-332` — prophet snapshot replay crashes. The
"Layers" column does `const ls = r?.layerResults ?? r?.layers ?? [];
ls.filter(...)`. Prophet snapshot rows store `layers` as an OBJECT keyed by
layer name (prophet-layers.ts:17-25; prophet-snapshot-runner.ts writes
`results: scan.picks`). `ls.filter` is not a function → TypeError → History
view error-boundaries for every prophet snapshot selected.

## MAJOR

**M1.** `src/hooks/useCatalyst.js:128-136` + `src/lib/queryKeys.js:21` —
query key is `catalyst(universe)` but the URL (and the server:
catalyst-board.ts:80-81 reads `filter` and `minConviction` and filters
server-side) varies by filter + minConviction. Consequences: (a) changing the
Signal/Conviction filters in CatalystView does NOT refetch within the 60s
staleTime — the buttons are no-ops; (b) AlertsView (src/AlertsView.jsx:16)
populates the same key with `filter=all&minConviction=low` data, so
CatalystView (default minConviction=medium) can display low-conviction rows
and vice versa — wrong cache hits by design. Key must include
filter + minConviction.

**M2.** `src/hooks/useInsider.js:165-178` — URL carries `days=${windowDays}`
but the key is `insider(universe)` only. The 30/60/90/180d window selector in
InsiderBoardView changes the URL but not the key, so within the 10-minute
staleTime the view silently keeps showing the previous window's rows (header
says "30d", data is 90d). Key must include windowDays.

**M3.** Percent-vs-fraction unit bug, Gross/Op margin:
netlify/functions/stock-detail.ts:234-239 passes
`fund.profitability.grossMargin` / `.operatingMargin` through AS-IS when the
Phase-4w group exists — and data-provider.ts:482-496,541-543 computes those
as FRACTIONS (≈0.44) — while netMargin/roe/roa on the very next lines are
×100. KeyMetricsPanel.jsx formats all of them with pct1, so Gross Margin
renders "0.4%" instead of "44.0%". Worse, the sector medians ARE percent
(sector-medians.ts:103-106 does `*100`), so the favorability dot compares
0.44 vs 55 → permanently "unfavorable". KeyMetricsPanel.test.jsx:25 hides
this by mocking `grossMargin: 44` (percent) — the fixture doesn't match the
real handler output.

**M4.** Regime vol-regime enum mismatch: backend emits 'low'|'medium'|'high'
(shared/regime.ts:16,49). Frontend checks values that never occur:
src/RegimeView.jsx:41 (`'extreme'`/`'elevated'` for the VIX StatusDot → dot
is always green, even at VIX 35) and RegimeView.jsx:119-120 (earnings premium
multipliers keyed on 'elevated'/'low' → the 'elevated' branch is dead).

**M5.** `src/HistoryView.jsx:312-380` — replay columns read fields the
snapshots never contain (rendered '—' on every row):
- target-board: `r.score` / `r.side` — Target rows carry `composite` /
  `direction` (shared/types.ts:19-30).
- insider: `r.buyCount` / `r.mostRecentFiling` — rows carry `buyerCount` /
  `latestFilingDate` (shared/scan-insider.ts:278,283).
- williams: `r.reason` — no such field on scan-williams candidates.
- lynch: top-level `r.peg` / `r.pe` / `r.growth` — these live under
  `signals`/`signal` on lynch candidates.
Net effect: most History replay tables are em-dash wallpaper.

**M6.** Fan-out volume: useStockDetailsFanout
(src/hooks/useStockDetailsFanout.js:45-70) is always-enabled for every
visible row — desktop Target board fires up to 50 parallel /api/stock-detail
calls on load (each one fans out to ~10 providers server-side), completely
bypassing the IntersectionObserver lazy-fetch that FundamentalsStrip was
built around. The PR-F "only fetch rows scrolled into view" economy is
defeated on every board that uses the sortable columns (Target, Williams,
Lynch).

## MINOR

- m1. useStockDetailsFanout.js:86 — useMemo dependency array changes LENGTH
  between renders. React dev error; fragile though output is correct.
- m2. UniverseSelector.jsx:38-40 — UNIVERSE_AWARE_VIEWS includes 'earnings'
  and 'options' which ignore the prop (selector visibly does nothing);
  'insiders' is EXCLUDED though InsiderBoardView DOES send
  `index=${universe}` — silently filtered by a universe chosen on another
  tab.
- m3. useResearch.js / useChartAnalysis.js — `lookback` not in the query
  key; latent. ProphetView.jsx:349 raw-fetches lookback=120 outside
  react-query — inconsistent.
- m4. useGenerateNarrative.js onSuccess patches EVERY cached query under the
  'tradeiq' prefix that has a `picks` array — prophet narrative can be
  injected into catalyst cache rows of the same ticker.
- m5. useEngineTest.js — onSuccess cache write never read; "instant second
  click" comment false.
- m6. App.jsx:248 / layout/RegimeStrip.jsx — "ET clock" never ticks; updates
  only on unrelated re-renders.
- m7. RegimeView.jsx:7-10 — vixSeries is Math.random() data regenerated per
  render: fabricated "VIX" sparkline (violates the repo's own honest-no-data
  rule).
- m8. colSpan mismatches: TargetBoardView.jsx:243 colSpan={17} (14 cols);
  WilliamsView.jsx:217 and LynchView.jsx:202 colSpan={15} (14 cols).
- m9. HistoryView.jsx:248 — `(snapshot.scanDurationMs / 1000).toFixed(1)`
  renders "NaNs" when absent; formatAge() rounds hours so 20 min reads
  "0h ago".
- m10. HistoryView.jsx:81-95 — on board/universe switch the detail query
  fires once with the OLD selectedId under the new board key (wasted
  fetch/transient 404).
- m11. CatalystView.jsx:138-163 — FundamentalsStrip (role="button",
  tabIndex=0) rendered inside the row's <button>: invalid nested interactive
  elements.
- m12. KeyMetricsPanel.jsx 'pctRaw' assumes Massive's
  `ratios.dividend_yield` is a decimal fraction — unverified against the
  provider; if it ships percent this is 100x off.
- m13. App.jsx:273-274 — silent fallback to MOCK_REGIME / MOCK_ANALYSTS when
  the API fails presents fabricated "risk_on, VIX 13.8" as live with no
  indicator.
- m14. `target.priceChangePct >= 0` colors '—' (null) rose; fmt.pct handles
  null, the color logic doesn't.

## BOARD SORTING + FAN-OUT (focused check)

- useSortable comparator is correct: numeric compare for numbers, locale
  compare for strings, NaN/null/undefined always last. No
  string-compare-of-numbers bugs; new MCap/P-E/P-S/ROE/D-E columns receive
  real numbers from the fan-out extract().
- Fan-out field paths verified against stock-detail.ts:
  metrics.valuation.{marketCap,pe,ps}, metrics.profitability.roe
  (percent-scaled ✓), metrics.health.debtEquity — all exist.
- Cache-key sharing with useStockDetail is genuine (same
  queryKeys.stockDetail + uppercase normalization both sides) — the
  one-fetch-per-ticker dedupe contract holds and is pinned by tests.
- Real issues: eager 50-row fan-out (M6), variable-length memo deps (m1).
  Sorting "tier" desc puts C before A — first click shows worst-first; UX
  quirk.

## TESTS

- Mostly meaningful: useTargetBoard pins force-rescan semantics;
  usePriceHistory/useStockDetail/FundamentalsStrip pin the one-fetch dedupe
  with real fetch spies; InsiderBoardView pins filter/sort/re-anchor with
  DOM assertions; ScoreBreakdown pins sort + noData.
- Gaps/wrong fixtures: KeyMetricsPanel + FundamentalsStrip fixtures use
  PERCENT margins the real handler never produces (masks M3); fixtures
  internally inconsistent (fanout roe: 1.5 vs KeyMetrics roe: 153.5).
  queryKeys.test.js never exercises catalyst filter/minConviction or insider
  windowDays — exactly the two real key bugs. InsiderBoardView.test mocks
  useInsider wholesale (windowDays bug invisible). No render-with-data test
  for CatalystView or EarningsView's log path — the two ReferenceError
  crashes would be caught by a single smoke test each.

## VERIFIED-CLEAN

netlify.toml redirects cover every /api/* path hooks call; handler param
names match hook query strings everywhere else checked (target-board,
williams-board, lynch-board, earnings-board, prophet-picks,
snapshot-history, price-history, rationale endpoints, chart-analysis,
research, engine-test, backtest); live board response fields match what
views render; useBacktestRun's v5 refetchInterval-callback polling stops on
terminal status; ScoreBreakdown/AnalystContributions weight ×100 correct;
StockDetailPanel's enabled-gating is Rules-of-Hooks compliant and
test-pinned.

## OVERALL

Architecture is sound — centralized query keys, validated fetch layer, one
shared per-ticker detail path with a test-pinned dedupe contract,
disciplined enabled-gating. But the release as it stands has two user-facing
crashes and one dead interaction that any render-with-data smoke test would
catch, plus two cache-key omissions that make visible controls silently lie.
The percent-vs-fraction margin bug is the most insidious: backend and tests
disagree about units, and the tests codify the wrong side. Fix C1-C3 and
M1-M3 first, then add render-with-real-fixture smoke tests and re-derive the
KeyMetrics fixtures from an actual /api/stock-detail capture.
