# TradeIQ — Orchestrator

**Purpose.** Sequence every fix and capability gap identified in the v0.7.25 review into a phased build plan. One doc, persistent in repo, updated each session. Each phase is a shippable unit ending in a green deploy and a status update at the bottom of this doc.

**Rule of the road.** This is a personal tool, but every commit goes through CI gates established in Phase 0 once that phase ships. No manual prod pushes after Phase 0 lands. Status table at the bottom is the single source of truth on what's done.

---

## Standing rules (apply to every phase)

- ALWAYS bump `APP_VERSION` in `src/App.jsx` on any user-visible change.
- Every data table column is sortable via the `useSortable` hook + `SortableTh` component. No exceptions.
- Anything to be copied into another tool/conversation goes in a markdown doc or code block. Never plain prose.
- Critical data ingest preserves four layers: original bytes (gzipped), `{source}_rows_raw` with all columns, parsed/normalized rows, aggregations. Never drop fields.
- Brand blue: `#1e5b92`. Davis Delivery contexts only — TradeIQ uses its own neutral dark palette.
- Each phase ships its own `vX.Y.Z-alpha` version bump. No combining unrelated phases into one bump.
- Every phase that touches scoring or alpha logic must add a regression test before merge.
- Every phase ends by updating the Status table at the bottom of this doc.

---

## Phase 0 — Engineering foundation + safety nets

**Goal.** Stop bleeding before doing anything else: tests, CI, spend cap, error tracking, backups, dead code purge.

**Why.** Cache-poisoning regressions hit three times (v0.7.18, 19, 21). Opus 4.7 on every AI surface means a runaway loop costs real money. Trade log lives only in Firestore with no backup. None of these need code to write — they need infrastructure that's missing.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Test harness | `vitest.config.ts`, `src/**/*.test.jsx`, `netlify/functions/**/*.test.ts` | New. Vitest for both frontend + functions. |
| Regression tests for known bug families | `netlify/functions/__tests__/cache-poisoning.test.ts` | New. Test that empty results never poison `resultCache`. One test per affected endpoint (target-board, prophet, earnings-board, insider-board). |
| Layer scorer unit tests | `netlify/functions/shared/__tests__/prophet-layers.test.ts` | New. Fixture-based unit tests for all 7 layers in `prophet-layers.ts`. |
| CI gates | `.github/workflows/ci.yml`, `.github/workflows/deploy.yml` | New. Run lint + tsc + vitest on every PR. Block merge to main on red. |
| Anthropic spend cap | `netlify/functions/shared/anthropic-budget.ts` | New. Daily spend ceiling stored in Netlify Blobs or Firestore. Every Claude call checks remaining budget; over cap → 503 with friendly message. |
| Anthropic circuit breaker | same file | New. Open circuit on 5 errors/min for 5 min. |
| Error tracking | `src/lib/sentry.js`, function wrapper | New. Sentry free tier or Logtail. Wrap all functions with capture, frontend ErrorBoundary calls Sentry. |
| Structured logging | `netlify/functions/shared/logger.ts` | New. Replace `console.log` with structured JSON logger. Every function logs request, duration, cache-hit, error. |
| Firestore backup | `.github/workflows/backup-firestore.yml` | New. Cron weekly. Uses `firestore-export-import` or `gcloud firestore export` to GCS bucket. |
| Dead code purge | `app/` directory | Delete. Recovery artifact from v1, not built, confusing. |
| README hygiene | `README.md` | Update. Reflect current state, link to this doc. |

**Dependencies.** None. This is the bedrock.

**Success criteria.**
- `npm run test` runs ≥ 30 tests, all green.
- A PR that breaks a layer scorer is blocked by CI.
- An empty-result response never gets cached (regression test passes).
- `/api/research?ticker=NVDA` while over daily Anthropic budget returns 503 with `{error: 'budget_exhausted'}`.
- An exception in `/api/prophet-picks` shows up in Sentry within 30s.
- Firestore tradeLog is in GCS bucket `tradeiq-backups` with daily snapshots ≥ 7 days retained.
- `app/` directory is gone, repo size drops noticeably.

**Estimate.** 1–2 sessions. Heaviest piece is the test harness — once Vitest is wired, subsequent test work is fast.

---

## Phase 1 — Universe coverage + snapshot infrastructure

**Goal.** Every board scans the FULL configured universe (all 1,930 Russell 2000, all S&P 500, all NDX, all Dow), not the first 80–200 alphabetical. Comprehensive results delivered instantly to the UI by reading from a shared store populated by scheduled background jobs. Snapshots are model-version stamped and double as the historical archive that downstream phases (backtest, calibration, replay) read from.

**Why this is in Phase 1 and not later.** Every current board caps at 80–200 tickers and slices alphabetically (`tickers.slice(0, 80)`). When the user selects Russell 2000 (1,930 tickers), only A-G ever get scanned. Tickers from H-Z are invisible to the model. This is the worst possible failure mode for small-cap discovery — exactly where insider, political, patent, and short-interest signals have the most edge. It's a silent product gap that makes the app's small-cap claims structurally false. Fix this immediately after the engineering foundation lands.

**Architectural shape.**

The fix is not "raise the limits" — Netlify functions cap at 26s sync, which is nowhere near enough for a deep 1,930-ticker scan. The fix is decoupling scan time from request time:

1. Scheduled background functions (Netlify scheduled functions, up to 15-minute background timeout) scan the full universe across all boards, multiple times daily.
2. Each run writes results to Firestore as `boardSnapshots/{board}/{date}/{snapshotId}` with full ticker results, model version, scan duration, freshness timestamp.
3. Live API endpoints (`/api/target-board?universe=russell2k` etc.) read from the most recent snapshot first. Fall back to a live partial scan only if the snapshot is older than the freshness budget for that board.
4. UI shows a freshness pill: "Live · 8 min ago" or "Refreshing…" or "Fallback (partial scan)".
5. Manual "Force rescan" button triggers a synchronous capped scan (current behavior, kept as an escape hatch).

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Firebase Admin in functions | `netlify/functions/shared/firebase-admin.ts` | New. Service-account-backed Firestore writer for use from scheduled functions. Distinct from frontend `firebase.js`. Reads `FIREBASE_SERVICE_ACCOUNT` env var (JSON). |
| Snapshot store abstraction | `netlify/functions/shared/snapshot-store.ts` | New. Read/write API for all snapshot data: `writeSnapshot(board, universe, snapshot)`, `latestSnapshot(board, universe)`, `snapshotAge(board, universe)`. Backed by Firestore. |
| Model version stamp | `netlify/functions/shared/model-version.ts` | New. Single `MODEL_VERSION` constant bumped on any scoring change. Stamped on every snapshot. |
| Scheduled scan: target-board | `netlify/functions/scheduled/scan-target-board.ts` | New. Runs at 06:00, 09:30, 12:00, 15:30, 17:00 ET. Scans full universe per index (sp500, ndx, russell2k, dow). Writes per-universe snapshots. |
| Scheduled scan: prophet | `netlify/functions/scheduled/scan-prophet.ts` | New. Same cadence. Full 7-layer ensemble across full universe. |
| Scheduled scan: catalyst | `netlify/functions/scheduled/scan-catalyst.ts` | New. Same cadence. |
| Scheduled scan: insider | `netlify/functions/scheduled/scan-insider.ts` | New. Daily at 17:30 ET (insider data updates after close). |
| Scheduled scan: williams | `netlify/functions/scheduled/scan-williams.ts` | New. Same cadence as catalyst. |
| Scheduled scan: lynch | `netlify/functions/scheduled/scan-lynch.ts` | New. Daily after close (fundamentals don't move intraday). |
| Scheduled scan: earnings | `netlify/functions/scheduled/scan-earnings.ts` | New. 06:00 and 17:00 ET. |
| Live API rewire — target-board | `netlify/functions/target-board.ts` | Modify. Query path: snapshot-first, fallback partial. Remove the alphabetical 80-cap when serving from snapshot. |
| Live API rewire — prophet | `netlify/functions/prophet-picks.ts` | Modify. Same pattern. |
| Live API rewire — catalyst, insider, williams, lynch, earnings | each `*-board.ts` / `*-picks.ts` | Modify. Same pattern. |
| Snapshot freshness budget | `shared/snapshot-store.ts` | New. Per-board: target-board 30min, prophet 30min, catalyst 1hr, insider 12hr, williams 1hr, lynch 24hr, earnings 12hr. |
| Universe iteration utility | `shared/full-scan-iterator.ts` | New. Concurrency-controlled async generator that yields ticker batches across full universe. Respects rate limits per provider. |
| Health endpoint surfaces snapshot age | `netlify/functions/health.ts` | Modify. Return last snapshot age for every board+universe. |
| Frontend freshness pill | every view component | Modify. Show data age + "force rescan" affordance. |
| HistoryView | `src/views/HistoryView.jsx` | New. Pick a past date, see exact board snapshot. Tab in nav. |
| Backfill from journal | `scripts/backfill-snapshots.ts` | New (one-shot). Reconstruct partial historical snapshots from existing journal entries' loggedAt timestamps. |
| netlify.toml schedule config | `netlify.toml` | Modify. Add `[[scheduled.functions]]` blocks for each scheduled scan with cron expression and timeout=900s (background). |

**One-time setup the user must do (document in PR):**
1. Create a Firebase service account JSON for `tradeiq-alpha` project (separate from the one created for backups in Phase 0 if needed; can reuse).
2. Set the JSON as Netlify env var `FIREBASE_SERVICE_ACCOUNT`.
3. Verify Firestore rules allow service-account writes to `boardSnapshots/**` (default Firestore rules with service account work fine — service accounts bypass security rules).

**Dependencies.** Phase 0 (structured logging, Sentry, Anthropic budget cap — without these, scheduled scans are a black box and could burn budget silently).

**Success criteria.**
- A request to `/api/target-board?universe=russell2k` returns results covering tickers across the entire alphabet (smoke check: confirm at least one ticker starting with "Z" appears in some board's results, given current Russell composition).
- Snapshot for each board exists for current day, age < freshness budget during market hours.
- A scheduled function failure (e.g., Polygon outage) is surfaced via Sentry within 5 minutes.
- The "force rescan" button still works and explicitly tells the user the result is partial.
- Anthropic / Polygon / Finnhub API spend per day is within budget (verify via dashboards from Phase 0).
- HistoryView displays a snapshot from yesterday accurately.

**Estimate.** 2–3 sessions. Heaviest piece is wiring Firebase Admin + service account + the seven scheduled scans + rewiring seven live endpoints. The scheduled scan logic itself is mostly factoring-out of existing in-handler code.

---

## Phase 2 — Refactor foundation: schemas + monolith split + server state

**Goal.** Make the codebase reviewable on a phone and protect every external API boundary with Zod.

**Why.** App.jsx at 2,927 lines is the same anti-pattern that took MarginIQ.jsx to 10,500 lines before it became unmaintainable. TanStack Query gives free dedup, retry, focus revalidation. Zod at the boundary catches Polygon/Finnhub schema drift at one log line instead of three calls deep when something is `undefined`.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Zod inbound schemas | `netlify/functions/shared/schemas/polygon.ts`, `finnhub.ts`, `quiver.ts`, `fred.ts`, `anthropic.ts` | New. One Zod schema per external API endpoint actually called. Wrap fetches with `.parse()`. |
| Schema-fail logging | `netlify/functions/shared/data-provider.ts` | Modify. On parse fail, log structured event + return safe default. |
| Split App.jsx | `src/views/TargetBoardView.jsx`, `EarningsView.jsx`, `OptionsFlowView.jsx`, `BacktestView.jsx`, `ResearchView.jsx`, `EngineTestView.jsx` | New. Move each view out of App.jsx into its own file, matching the existing `WilliamsView.jsx` / `LynchView.jsx` / etc. pattern. |
| Mock data extraction | `src/lib/mockData.js` | New. All `MOCK_*` constants out of App.jsx. |
| TanStack Query | `package.json`, `src/main.jsx`, every view | Add `@tanstack/react-query`. Wrap app in `QueryClientProvider`. Replace every `useEffect + fetch` with `useQuery`. |
| Server-state cache invalidation | `src/lib/queryKeys.js` | New. Centralized query keys so invalidations are explicit. |
| Frontend Zod (optional, low priority) | `src/lib/zodFrontend.js` | New. Validate API responses on the frontend too. Backstop for the existing `validateResponse.js` shapes. |

**Dependencies.** Phase 0 (CI catches refactor regressions). Phase 1 (frontend changes need to play nice with snapshot-backed endpoints).

**Success criteria.**
- App.jsx is under 800 lines and contains only routing/shell.
- Tab switches no longer refetch already-fresh data.
- Bundle size is the same or smaller (verify via Vite build output).
- A Polygon schema change in a fixture test fails at the schema layer, not in JSX.
- All 7 view files exist and pass their own ErrorBoundary.

**Estimate.** 2 sessions. Split App.jsx is mostly mechanical; TanStack Query wiring is the careful part.

---

## Phase 3 — Point-in-time data layer

**Goal.** Audit every external data source for "as-of" semantics. Wrap each provider call with explicit point-in-time guarantees or document where PIT is impossible.

**Why.** A backtest that uses today's restated fundamentals to "predict" 2024 outcomes is overstating edge. Polygon revises financials. Finnhub recommendations get backfilled. Quiver sometimes amends. The look-ahead bias risk is real and pervasive.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| PIT audit doc | `docs/POINT_IN_TIME_AUDIT.md` | New. Per data class (bars, fundamentals, news, earnings, insider, political, patent, recommendations): does the API support as-of? If yes, how? If no, what's the workaround? |
| Bars (Polygon) | `data-provider.ts` | Confirm. Daily bars are PIT-safe (historical OHLCV doesn't revise). Add comment. |
| Fundamentals (Polygon) | `data-provider.ts:getFundamentals` | Modify. Add `asOfDate` param. Filter results to only those filed before asOfDate. |
| News (Polygon) | `data-provider.ts:getNews` | Modify. Filter by `published_utc` ≤ asOf. |
| Insider (QuiverQuant/Finnhub) | `insider-provider.ts` | Modify. Filter by transaction date or filing date ≤ asOf, whichever is appropriate. |
| Recommendations (Finnhub) | `data-provider.ts` | Audit. Likely no PIT support. Document and use snapshot from Phase 2 when backtesting. |
| Politcal/patents/contracts (Quiver) | `political-provider.ts` etc. | Audit + filter by date. |
| Universe history | `netlify/functions/shared/universe-history.ts` | New. Snapshot of S&P 500 / Russell 2000 constituents at month-ends going back ≥ 5 years. Source: a one-shot scrape from Wikipedia history or buy from a vendor. Critical for survivorship-bias correction. |

**Dependencies.** Phase 2 (snapshot infrastructure provides one source of truth for "what was scoreable on date X").

**Success criteria.**
- `docs/POINT_IN_TIME_AUDIT.md` covers every provider with a Yes/No/Workaround per data class.
- `getFundamentals('NVDA', { asOfDate: '2023-06-01' })` returns only filings dated before 2023-06-01.
- Universe-history can answer "was AAPL in S&P 500 on 2018-03-15?" deterministically.

**Estimate.** 1–2 sessions. The universe-history backfill is the heaviest piece; everything else is mechanical filtering.

---

## Phase 4 — Real backtest v2 (the alpha proof)

**Goal.** Replace the current technical-only backtest with a full-stack walk-forward backtest covering all 10 analysts, with transaction costs, survivorship correction, and proper statistics.

**Why.** Current backtest is the single biggest credibility hole. Without it, all analyst weights are priors and every recommendation is faith-based.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Backtest engine v2 | `netlify/functions/backtest-v2.ts`, `netlify/functions/shared/backtest/engine.ts` | New. Replays historical snapshots (Phase 2) against PIT data (Phase 3). |
| Walk-forward harness | `backtest/walk-forward.ts` | New. Train/test split by quarter. OOS-only stats reported. |
| Transaction costs | `backtest/costs.ts` | New. Bps per round-trip + ADV-relative slippage. Configurable. |
| Performance stats | `backtest/stats.ts` | New. Sharpe (annualized), Sortino, max DD, Calmar, win rate, avg win / avg loss, profit factor, recovery time. |
| Per-analyst attribution | `backtest/attribution.ts` | New. For each trade, compute marginal contribution of each analyst score. Output: per-analyst alpha, hit rate, info ratio. |
| Monte Carlo | `backtest/monte-carlo.ts` | New. Resample trade sequence ≥ 1000 times. Output: 95% CI on alpha, P(drawdown > X). |
| Universe selection (PIT) | uses `universe-history.ts` | Wire. Backtest universe at date T = constituents on date T, not today. |
| Frontend backtest view | `src/views/BacktestView.jsx` | Rewrite. Show: equity curve, OOS vs IS alpha, per-tier stats, per-analyst attribution, Monte Carlo distribution, drawdown chart. |
| Backtest persistence | Firestore `backtestRuns/{runId}` | New. Every backtest run is saved with config + results so you can compare runs. |

**Dependencies.** Phase 2 (snapshots), Phase 3 (PIT data + universe-history).

**Success criteria.**
- A backtest of `2022-01-01 → 2025-06-30` runs end-to-end in under 5 minutes (cached PIT data).
- OOS alpha is reported separately from IS alpha. If IS >> OOS, UI flags overfitting.
- Per-analyst attribution shows which analysts are pulling weight and which are noise.
- Monte Carlo CI is shown on the equity curve.
- A regression test runs a known fixture and asserts deterministic Sharpe.

**Estimate.** 2–3 sessions. The biggest single unit of work in this whole orchestrator.

---

## Phase 5 — Calibration loop + ML refinement

**Goal.** Close the loop: backtest tells you which analysts have edge, which weights are wrong, which regimes invert signal. Use that to retune the production model. Layer real machine learning on top of the rule-based composite — meta-ranker, similarity search, online weight updates, anomaly detection — so picks improve continuously as more outcome data accumulates.

**Why.** Right now the composite weights (15/8/13/10/10/7/7/14/6/10) are priors. After Phase 4, you have OOS alpha per analyst — that should drive the weights, not gut. Beyond weight tuning, the rule-based composite is a deterministic ranker. ML adds: a learned re-ranker that catches patterns the rules don't, a "this looks like X past cases" reality check on every candidate, gradual weight adaptation as the world changes, and outlier flags for unusual setups. None of this is hype — these are standard, interpretable techniques used across systematic trading desks.

**ML scope is gated on Phase 3 + Phase 4.** No labeled training data without point-in-time history (Phase 3) and forward returns from the backtest (Phase 4). Don't try to shortcut.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Weight optimizer | `backtest/optimize-weights.ts` | New. Grid search over weight space (or Bayesian opt) maximizing OOS Sharpe. Hard cap weight changes per cycle to avoid overfit-to-recent. |
| Regime-conditional weights | `analyst-runner.ts` | Modify. Weights become a function of `Regime`, not a constant. Optimizer outputs one weight vector per regime (risk_on / neutral / risk_off). |
| Post-trade AI review | `netlify/functions/scheduled/post-trade-review.ts` | New. Daily scheduled function. For each closed trade ≥ 10 days old, call Opus with: original thesis (analyst contributions, top signals), actual price path, news that hit during the trade. Opus classifies: thesis-confirmed / thesis-invalidated-but-profitable / thesis-failed / externally-driven. Result stored on the trade entry. |
| Calibration dashboard | `src/views/CalibrationView.jsx` | New. Per-analyst hit rate, alpha, info ratio rolling 30/90/180 days. Chart of weight evolution over time. |
| Weight version control | `modelVersions/{version}` collection | Use existing from Phase 1. Every weight change is a new version with full diff. Boards record which version generated them. |
| **Meta-ranker (gradient boosting)** | `ml/meta-ranker.ts`, `scripts/train-meta-ranker.ts` | **New.** Train XGBoost/LightGBM on `(composite, layer_scores, regime, sector, marketCap, liquidity) → forward_5d_return / forward_20d_return / forward_60d_return`. Train weekly via scheduled function from `boardSnapshots` + `tradeLog` outcomes. Production inference re-ranks candidates on top of composite. Highest-leverage real ML application — interpretable (SHAP values per feature), computationally cheap (sub-100ms inference), industry-proven. |
| **Case-based reasoning / similarity search** | `ml/similarity.ts`, `src/components/SimilarCasesPanel.jsx` | **New.** k-NN over historical signal vectors. For each new candidate, find the K most-similar past setups in `boardSnapshots` and surface "matches 14 prior cases — avg +X% over 20d, hit rate Z%, drawdown -Y%". Reality check on the composite without forcing the user to trust a black box. Stored as ANN index in Firestore or in-memory FAISS depending on snapshot count. |
| **Bayesian online weight updates** | `ml/bayes-weights.ts` | **New.** Replace quarterly grid-search with Beta posteriors per analyst, updated continuously as outcomes land. Faster adaptation when an analyst stops working. Coexists with the optimizer — optimizer for big rebalances, Bayesian update for slow drift. |
| **Anomaly flag** | `ml/anomaly.ts`, frontend pill | **New.** Train an isolation forest on historical signal vectors. Flag any candidate whose vector is far from training distribution as either unusual opportunity or data error. Reduces false positives during data outages or vendor schema changes. Surface as a small icon on the candidate card. |
| **Regime classifier upgrade** | `ml/regime.ts` (replaces existing rule-based regime) | **New.** Current regime is rule-based on VIX + 10Y + 2Y10Y. Train a classifier (logistic regression or gradient boosting) on a wider macro feature set: HY/IG credit spreads, breadth (NH/NL, % above 50dma, McClellan), DXY, gold/oil, sector momentum dispersion, AAII/NAAIM sentiment. Output: continuous regime score plus discrete 3- or 5-state classification. Drives Phase 5's regime-conditional weights with richer signal than 3 fixed yield curves can provide. |

**Dependencies.** Phase 3 (point-in-time data — required for honest training labels), Phase 4 (real backtest — generates the forward-return labels). Hard dependency. No earlier.

**Success criteria.**
- Running the optimizer outputs a new weight vector that beats current weights OOS by ≥ 10% in Sharpe on a held-out window.
- Regime-conditional weights show meaningfully different vectors across regimes.
- Post-trade review has classified ≥ 50 closed trades.
- Calibration view shows per-analyst hit rate / alpha / info ratio over rolling windows.
- Meta-ranker beats composite-alone OOS by ≥ 5% in IC (information coefficient) over the held-out window.
- Similarity panel renders for every candidate with at least 5 historical matches.
- Anomaly flag fires on test fixtures (e.g., a deliberately corrupted signal vector).
- Regime classifier produces a more granular regime label than the rule-based version (verifiable by showing different weight vectors fired for the same VIX level on different breadth conditions).

**Estimate.** 3–4 sessions (was 2; ML workstreams add a session worth). Train once, ship many times — meta-ranker training is a weekly scheduled job, not request-time.

**Honest caveat.** ML on stock picking is hype-prone. Most ML overfits to backtest. Three guardrails baked in: (1) all ML is interpretable — gradient boosting + SHAP, k-NN explanations, isolation forest scores, no deep nets; (2) all ML re-ranks on top of the rule-based composite, never replaces it (composite stays the floor); (3) every ML output ships with a fallback so a model failure degrades to the existing rule-based behavior, not zero results. If meta-ranker IC drops below composite-alone for two consecutive weeks, it auto-disables.

---

## Phase 6 — Real options data

**Goal.** Replace the volume-and-realized-vol proxy in `options-flow.ts` with actual OPRA chain data. Every "long straddle / iron condor" recommendation references real IV percentile, term structure, and skew.

**Why.** The earnings-board hands out specific strike geometry. Without IV data, the strikes are guesses. Either get real or pull back the specificity.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Provider selection | `docs/OPTIONS_PROVIDER.md` | New. Compare Tradier (free for OPRA delayed), Polygon Options (paid), TradeStation (account-gated), Alpaca. Pick one, document why. |
| Options data provider | `netlify/functions/shared/options-provider.ts` | New. Wraps chosen vendor. Functions: `getChain(ticker, expiration)`, `getIV30(ticker)`, `getIVRank(ticker, lookback)`, `getSkew(ticker)`. |
| IV percentile + IV rank | same | New. 252-trading-day rolling. Cached daily. |
| Term structure | same | New. Front-month vs back-month IV. |
| Skew | same | New. 25-delta call IV vs 25-delta put IV. |
| Options-flow rewrite | `netlify/functions/options-flow.ts` | Rewrite. Real chain volume, OI changes, unusual flow detection (volume > 3x OI, etc.). |
| Earnings board IV plumbing | `earnings-board.ts` | Modify. Vol plays now use real IV percentile (not proxy). Strike selection uses real chain data. |
| Strike picker | `shared/options-strike-picker.ts` | New. Given setup type + bias + expiration, pick actual strikes from chain that match the strategy parameters. |

**Dependencies.** Phase 0 (spend cap, since options chain calls can balloon).

**Success criteria.**
- An earnings setup for NVDA shows IV percentile derived from a 252-day true IV history.
- Strike picks for a straddle are real chain strikes within the bid/ask, not synthetic.
- Options-flow surfaces unusual activity that would actually appear on a Bloomberg or LiveVol screen.

**Estimate.** 1–2 sessions. Tradier free tier is the fastest path; paid Polygon gives more.

---

## Phase 7 — Portfolio layer

**Goal.** Stop scoring tickers in isolation. Every recommendation respects portfolio-level constraints: correlation, sector caps, exposure bands, beta-adjusted sizing.

**Why.** Right now nothing prevents the user from holding 10 longs that are all the same trade dressed up. Pro discipline starts at the portfolio level.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Correlation matrix | `netlify/functions/shared/correlation.ts` | New. Rolling 60-day correlation between all currently held tickers + watchlist. Updated daily, cached. |
| Sector exposure caps | `portfolio/exposure.ts` | New. Hard caps per sector (configurable, default 25%). Soft caps per sub-industry (15%). |
| Factor exposure | `portfolio/factors.ts` | New. Estimate book exposure to: momentum, value, quality, size, vol. Display in dashboard. |
| Gross / net by regime | `portfolio/exposure.ts` | New. Risk_on: 100/100 gross/long. Neutral: 70/70. Risk_off: 40/30 (gross can stay if net comes down via shorts). |
| Beta-adjusted sizing | `portfolio/beta-size.ts` | New. Position size in $ adjusted for beta — so 1% account risk on a 1.5-beta name uses smaller dollar size than on a 0.7-beta name. |
| Portfolio VaR | `portfolio/var.ts` | New. 1-day 95% historical VaR computed daily from current holdings. |
| Portfolio dashboard | `src/views/PortfolioView.jsx` | New. Tab in nav. Shows current exposure, factor tilts, correlation heat-map, VaR, drawdown vs peak. |
| Recommendation filter | `runAnalystsForTicker` | Modify. Before surfacing a target, check it against current portfolio: if it would breach sector cap or correlation > 0.8 with existing position, flag the conflict in the rationale. |

**Dependencies.** Trade journal must reflect actual sizes (Phase 8 enforces this; this phase can ship with manual size entry first).

**Success criteria.**
- Portfolio view shows current sector breakdown summing to 100%.
- Adding a 7th tech long when book is already 28% tech surfaces a "would breach 25% cap" warning.
- VaR is computed and tracked daily.

**Estimate.** 1–2 sessions.

---

## Phase 8 — Position sizing engine

**Goal.** Three sizing modes, properly enforced: equal-weight, vol-target, fractional Kelly. Trade journal captures intended vs actual size.

**Why.** SPEC.md describes these but they're stubs. Pros size differently for high-vol vs low-vol, high-conviction vs low-conviction. Equal-weight is the lazy default that costs alpha.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Realized vol per ticker | `shared/realized-vol.ts` | New. Rolling 30-day annualized realized vol from daily bars. Cached. |
| Sizing modes | `portfolio/sizing.ts` | New. Three pure functions: `equalWeight(targets)`, `volTarget(targets, targetPortfolioVol)`, `fractionalKelly(targets, kellyFraction=0.25)`. |
| Per-setup sizing rules | `earnings-board.ts`, `prophet-picks.ts` | Modify. Each setup type has a sizing recommendation: vol plays 0.5%, directional 1%, PEAD 1.5%, etc. Now sourced from a config not magic numbers. |
| Hit-rate-aware Kelly | `portfolio/sizing.ts` | New. Fractional Kelly uses realized hit rate from journal (Phase 5 attribution), not a flat assumption. |
| Sizing enforcer in journal | `src/JournalView.jsx`, `tradeLog.js` | Modify. logTrade captures `recommendedSize` and `actualSize`. UI warns when actual > recommended × 1.5. |
| Portfolio rebalancer | `portfolio/rebalance.ts` | New. Given current book + new targets + chosen mode, output the trade list to get to target weights. |

**Dependencies.** Phase 5 (Kelly needs hit rates), Phase 7 (sizing is portfolio-aware).

**Success criteria.**
- A vol-target backtest produces lower realized vol than equal-weight at same gross exposure.
- Journal flags a 5%-of-account trade as oversize for a setup with a 1% recommendation.
- Rebalancer produces a coherent trade list in $ terms given current and target weights.

**Estimate.** 1–2 sessions.

---

## Phase 9 — Exit / trade management system

**Goal.** Trades have a lifecycle, not just an entry. Trailing stops, scale-out ladders, news-event triggers, correlation-break alerts, time-based exits.

**Why.** Stops and targets are computed at entry then the app stops thinking. PnL is decided at exit, not entry.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Trade state machine | `shared/trade-lifecycle.ts` | New. States: open, T1-hit, T2-hit, stopped, time-exited, manually-closed. Transitions logged. |
| Trailing stop logic | `lifecycle/trailing-stop.ts` | New. ATR-based trailing stop that activates after T1. |
| Scale-out ladders | `lifecycle/scale-out.ts` | New. Default: take 1/3 at T1, 1/3 at T2, let 1/3 ride with trailing stop. Configurable per setup type. |
| News-event triggers | `netlify/functions/scheduled/news-watch.ts` | New. Scheduled. For every open position, scan news daily. Material events (earnings revision, downgrade, lawsuit, M&A) trigger an alert in the journal. |
| Correlation-break trigger | `lifecycle/correlation-break.ts` | New. If SPY breaks below 50-day on volume, every position with > 0.7 correlation to SPY gets flagged. |
| Time-based exits | `lifecycle/time-exit.ts` | New. Vol plays close 1 day post-earnings regardless. PEAD trades close at 30 or 60 days. Pre-earnings directional closes day before. |
| Open positions view | `src/views/OpenPositionsView.jsx` | New. Tab in nav. Live state of every open trade — current PnL, alerts firing, T1/T2 status, days remaining if time-bound. |
| Notifications | `src/lib/notifications.js` | New. Browser push (when supported) for alerts. Phone-first for Chad. |

**Dependencies.** Phase 0 (Sentry-class for the scheduled functions).

**Success criteria.**
- An open NVDA long with T1 hit shows "scaled out 1/3 at $1,050 — trailing stop now active at $987".
- An earnings revision on a held name triggers an alert visible in the journal within an hour of the news hitting.
- A SPY break-below-50dma flags every correlated long.

**Estimate.** 1–2 sessions.

---

## Phase 10 — Missing data classes

**Goal.** Plug the data gaps a serious desk would never trade without.

**Why.** Short interest dynamics, dark pool prints, options skew, breadth, sentiment — these are all signals that move alpha and the app currently ignores or proxies.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Short interest + days-to-cover | `shared/short-interest-provider.ts` | New. Source: FINRA biweekly + Finra-vendor for daily where available. |
| Borrow rate | same | New. Source: IBKR if account access, otherwise Quiver borrow data. |
| Dark pool prints | `shared/darkpool-provider.ts` | New. Source: Quiver dark pool or FINRA ATS. |
| Options skew | `options-provider.ts:getSkew` | Already in Phase 6. Surface in catalyst layer. |
| Block trade tape | `shared/block-trade-provider.ts` | New. Polygon trades with size > 10000 shares + cross-exchange flag. |
| Breadth indicators | `shared/breadth-provider.ts` | New. NH/NL ratio, % stocks above 50dma, McClellan oscillator. Daily, cached. |
| Sentiment indicators | `shared/sentiment-provider.ts` | New. AAII bull/bear, NAAIM exposure index. Weekly. |
| Credit spread layer | `shared/regime.ts` | Modify. Add HY OAS and IG OAS to regime computation, not just 2y10y. |
| New analysts | `analysts/short-pressure.ts`, `breadth.ts`, `sentiment.ts` | New. Each gets a layer in the composite. |
| Weight rebalance | `analyst-runner.ts` | Modify. Rebalance weights to include new analysts. Re-run optimizer (Phase 5) to set values. |

**Dependencies.** Phase 5 (so new analyst weights are calibrated, not guessed), Phase 6 (skew).

**Success criteria.**
- Each new data class has a provider, a unit test, and is consumed by at least one analyst or board.
- Composite score now reflects ≥ 13 inputs instead of 10.

**Estimate.** 2 sessions.

---

## Phase 11 — Analyst depth

**Goal.** Lynch view becomes actually Lynch. Fundamental analyst becomes actually fundamental. Build the dedicated short-side analyst SPEC.md flagged.

**Why.** Lynch view is shallow — no PEG with analyst growth, no debt comp vs sector median, no insider-vs-buyback signal. Fundamental analyst is two growth metrics with a name on it. Short side is disabled because shorts in v1 were -3% alpha, but the fix isn't disabling — it's a dedicated short analyst with different signals.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Lynch depth | `analysts/lynch.ts`, `src/LynchView.jsx` | Rewrite. PEG vs analyst LT growth. Debt/equity vs sector median. Earnings stability score (5y std dev of EPS growth). Insider transactions vs buyback ratio. Classify as: fast-grower, stalwart, slow-grower, cyclical, turnaround, asset-play. |
| Fundamental depth | `analysts/core.ts:runFundamental` | Rewrite. Add ROIC, FCF yield, share count drift (1y / 3y), debt structure (short-term vs long-term, fixed vs floating). |
| Dedicated short analyst | `analysts/short-side.ts` | New. Different signals than long-side: insider selling clusters, debt covenant stress, declining estimates, channel checks, rising days-payable, options put/call inversion, short interest acceleration with no squeeze setup. |
| Earnings interpreter | `netlify/functions/shared/earnings-interpreter.ts` | New. SPEC.md B3. Reads transcript via Opus, returns structured signals. |
| Arbitrator | `netlify/functions/shared/arbitrator.ts` | New. SPEC.md B2. Resolves analyst conflicts via Opus when conflictLevel is moderate or severe. |
| Claude-as-PM | `netlify/functions/scheduled/pm-decision.ts` | New. SPEC.md B1. Daily scheduled. Reads top targets, regime, current portfolio, correlation matrix. Outputs structured PM decision (additions, trims, holds) for review. |

**Dependencies.** Phase 6 (skew for short signals), Phase 10 (short interest data).

**Success criteria.**
- Lynch view shows a Lynch classification per ticker.
- Short-side analyst running on a known stress fixture (e.g., a name pre-blowup) flags it with a high score.
- Earnings interpreter on a real transcript fixture produces structured output with sentiment, themes, red flags.
- Arbitrator on a high-conflict ticker produces a different score than the naive weighted-average.

**Estimate.** 2 sessions.

---

## Phase 12 — Auth + DR

**Goal.** Firebase Auth on the app, per-user Firestore rules, daily backups verified by a restore drill.

**Why.** Firestore rules are open until 2026-10-01. App is on a public URL. Anyone who finds it can read/write your trade log. Even though it's a personal tool, this is the kind of thing you should never carry into the next year of usage.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Firebase Auth wiring | `src/firebase.js`, `src/lib/auth.js`, `src/components/AuthGate.jsx` | New. Google sign-in. App-wide AuthGate component blocks unauthenticated UI. |
| Per-user Firestore rules | `FIRESTORE_RULES.md` + Firebase console | Update. `request.auth.uid == resource.data.ownerUid` on every write. Read same. |
| ownerUid on every record | `tradeLog.js`, all snapshot writers | Modify. Every write includes `ownerUid`. Migration script for existing records. |
| Auth-aware functions | `netlify/functions/shared/auth.ts` | New. Verify Firebase ID token on inbound. Reject if invalid. |
| Frontend auth state | `src/lib/useAuth.js` | New. Hook that surfaces current user across components. |
| Backup verification | `scripts/restore-drill.ts` | New. Quarterly: restore last week's backup to a sandbox project, verify count + spot-check 10 trades. |
| Multi-device handling | covered by Auth | The user can now log in from phone, truck laptop, desktop and see same data. |

**Dependencies.** Phase 0 (backups must already exist before requiring auth — don't lock yourself out).

**Success criteria.**
- An incognito tab with no auth sees a sign-in screen, not data.
- Firestore rules deny reads/writes without `auth.uid == ownerUid`.
- A restore drill succeeds against a sandbox project.

**Estimate.** 1 session.

---

## Phase 13 — Scale + caching + staging

**Goal.** Caches survive cold starts. Functions don't get hammered by anyone. There's a staging URL so prod isn't dev.

**Why.** In-memory `resultCache` is per-Lambda-instance. Two warm instances → inconsistent caches. No rate limiting → anyone can blow your Polygon quota. Single-site means one bad commit kills prod.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Shared cache | `netlify/functions/shared/cache.ts` | New. Wraps Netlify Blobs (free, durable) or Upstash Redis. Replaces every `Map`-based resultCache. |
| Edge rate limiting | `netlify/edge-functions/rate-limit.ts` | New. Per-IP rate limit (e.g., 60 requests/min) with bucket in Netlify Blobs. |
| Staging environment | new Netlify site `tradeiq-staging.netlify.app` | New. Branch deploy from `develop` branch. Same env vars except a separate Firebase project so staging writes don't pollute prod. |
| Promotion workflow | `.github/workflows/promote-to-prod.yml` | New. Manual trigger. Promotes a tested staging deploy to prod. |
| Bundle splitting | `vite.config.js` | Modify. Code-split each view route. |
| Service worker for offline | `src/sw.js` | New. PWA installability for phone-first usage. Offline read of last snapshot. |

**Dependencies.** Phase 1 (smaller bundles depend on view splits), Phase 0 (CI gates promotion).

**Success criteria.**
- Two simultaneous requests to `/api/target-board` use the same cached value (verified via response timing).
- 100 requests/min from one IP get 429ed.
- Staging URL exists and points to a separate Firebase project.
- Lighthouse mobile score on TradeIQ ≥ 90.

**Estimate.** 1–2 sessions.

---

## Phase 14 — Audit trail + compliance hooks

**Goal.** Every recommendation surfaced is logged with model version, inputs, time, user. Disclaimers per recommendation. Exportable audit log.

**Why.** TradeIQ is "personal" today, but if it ever becomes shared or commercialized, this is mandatory. Building the audit log now is cheap; retrofitting later is expensive. Also: it's a useful reflection tool — "what was the app showing me on the day I made this trade".

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Recommendation log | Firestore `recommendationLog/{date}/{eventId}` | New. Every time a board surfaces a recommendation to the user, write event: ticker, board, score, rationale, model version, inputs hash, user, time. |
| Per-recommendation disclaimer | UI components | Modify. Each card shows a small "v{model}/{date}" stamp. Tap to see exact inputs that produced it. |
| Audit export | `src/views/AuditView.jsx`, `scripts/export-audit.ts` | New. Export to CSV / JSON for any date range. |
| Compliance disclaimer surfacing | global footer + per-action | Modify. "Not financial advice" is currently in footer only. Add to: every "Add to journal" action confirmation, every recommendation card, every backtest result. |
| Inputs hash | `shared/inputs-hash.ts` | New. Deterministic hash of all inputs that fed a score so audit log entries are reproducible. |

**Dependencies.** Phase 2 (model versioning), Phase 12 (auth so user is identified).

**Success criteria.**
- Every recommendation card shows a model version and timestamp.
- Audit log can answer "what did the app recommend for NVDA on 2025-12-04 and what data drove it" deterministically.
- Export produces a CSV that survives a spot-audit by you, the user.

**Estimate.** 1 session.

---

## Cross-cutting concerns (track as the project grows)

- **Anthropic spend monitoring.** Phase 0 sets a daily cap. Once the calibration loop (Phase 5) adds Claude-as-PM and post-trade review, daily spend grows. Budget alerts should land in your inbox at 50% / 75% / 100% of cap.
- **Polygon / Finnhub / Quiver quota tracking.** Same shape — alert before hitting a wall.
- **Test coverage drift.** After Phase 0, coverage report on every PR. Gate at 50% for shared/ files; aspire to 80% on scoring math.
- **Documentation drift.** SPEC.md and this doc should be kept honest. Each phase's PR updates both.

---

## Session-start protocol

When resuming work in a new conversation:

1. Read this doc end-to-end before doing anything.
2. Check the Status table — find the next phase marked `pending`.
3. Read the phase's "Files" + "Success criteria" + "Dependencies".
4. Verify dependencies are `done`. If not, surface that — don't skip.
5. Set up the working tree:
   ```bash
   cd /home/claude
   if [ ! -d tradeiq ]; then
     git clone https://<token>@github.com/DavisDelivery/TradeIQ.git tradeiq
   fi
   cd tradeiq
   git pull --rebase
   git checkout -b phase-N-<short-topic>
   ```
6. Build. Test. Commit. Push. Open PR (or merge to main directly for personal-tool speed once CI is green).
7. Update the Status table at the bottom of this doc with: phase number, version shipped, date, summary of changes, regressions noted.
8. Bump `APP_VERSION`.
9. Verify deploy is live and version matches in the bundle.

---

## Status

Updated each session. `pending` → `in-progress` → `done` (with version + date). One row per phase.

| # | Phase | Status | Version | Date | Notes |
|---|---|---|---|---|---|
| 0 | Engineering foundation + safety nets | done | 0.10.0-alpha | 2026-05-08 | Tests + CI + spend cap + circuit breaker + structured logger + Sentry hooks + weekly Firestore backups; reconciled with Phase 1 + temperature hotfix |
| 1 | Universe coverage + snapshot infrastructure | done | 0.9.1-alpha | 2026-05-07 | All 7 boards snapshot-first end-to-end; FreshnessPill on all 7 views; HistoryView replay surface; backfill script for tradeLog reconstruction. Phase 0 still pending — see PR notes. |
| 2 | Refactor foundation (schemas + monolith split + TanStack Query) | done | 0.11.0-alpha | 2026-05-08 | Zod at 5 provider boundaries (10 fetch sites + 5 Quiver datasets); App.jsx 2965 -> 331 lines; 16 hooks + provider wrap; all 13 views wired to hooks (zero remaining useState+useEffect+fetch patterns for server data); fixed pre-existing W2 bug in EarningsView (missing imports); 127 tests (62 baseline + 54 schema + 11 hook); +12kB gzipped under 820kB budget. |
| 3 | Point-in-time data layer | done | 0.12.0-alpha | 2026-05-10 | All 5 providers as-of capable; FRED vintage_dates (gold-standard PIT for macro), Polygon fundamentals/news, Finnhub recommendations (hybrid: live filter + snapshot fallback), Quiver political/patents/contracts; universe history covers Dow 2018-01-31..2026-04-30 monthly (full coverage), sp500/ndx/russell current seed only (Wikipedia/iShares hostname-blocked at egress in this env — runbook documents how to extend); PIT audit doc enumerates every data class with workarounds for non-PIT vendors; 55 new PIT correctness tests. |
| 4a | Real backtest v2 — engine + correctness | done | 0.13.0-alpha | 2026-05-11 | Walk-forward engine; hot PIT cache (Firestore-backed); portfolio + costs + slippage; per-analyst attribution; ML hook data (forward 5d/20d/60d/252d returns persisted to backtestRuns/{runId}/mlTraining/); STOCK Act 45-day forward-shift; walk-forward integrity tests (11 P0); Dow + Russell fully backtest-able with survivorship correction stamp; SP500/NDX uncorrected (current seed only) with required disclosure; CLI script + 3 sample configs; BACKTEST_LIMITATIONS.md. Prophet board only — other boards return null and emit warning. 279 tests green (up from 182 baseline; +97 new). UI in 4b. Two follow-up hotfixes required (see 4a-fix-1, 4a-fix-2 below). |
| 4a-fix-1 | Phase 4a hotfix: cache undef-rejection + silent catch + missing happy-path test (PR #8) | done | 0.13.1-alpha | 2026-05-11 | Smoke test against Dow 2018-2024 monthly produced all-zeros result on first run (NAV held at $100K for 7 years, 0 trades). Root cause: Firestore Admin SDK rejects `undefined` field values by default; `getEarningsIntel` returned objects whose optional fields stay undefined; cache writes threw; engine's silent `catch{}` dropped every ticker. Three-layer fix: (1) `firebase-admin.ts` `settings({ ignoreUndefinedProperties: true })`; (2) `engine.ts` replaced silent catch with structured `TickerFailure` tracking + HIGH FAILURE RATE warning on >50% rate; (3) new happy-path integrity test that empirically catches the original bug at PR time (verified by reverting the engine fix). 281 tests green (+2). Re-run smoke test confirmed honest numbers: Sharpe 0.224, CAGR 1.03%, win rate 56.8%, 350 trades, 0% failure rate, NAV $95k–$113k over the window. |
| 4a-fix-2 | Phase 4a hotfix #2: ML-row bar window (PR #9) | done | 0.13.3-alpha | 2026-05-11 | Smoke test (post 4a-fix-1) confirmed engine produces honest numbers but ML training rows had `entryPrice: null` and all forward-return horizons null on every one of 206 rows; IC came back 0.000. Brief diagnosed wrong field — actual root cause was the caller's bar window math. `getCachedBarsThrough(ticker, asOfDate + 400d)` computed `(asOfDate + 100d, asOfDate + 400d)`, starting 100 days AFTER the rebalance; `lastCloseAtOrBefore(longBars, asOfDate)` had no entry bar to find. Fix: new `getCachedBars(ticker, from, to)` helper with explicit window; ML-row site uses `getCachedBars(asOfDate - 30d, asOfDate + 400d)`. Sibling audit found no other Bar field-name bugs. 9 new unit tests on `lastCloseAtOrBefore` (exported for testability). 290 tests green. Re-run smoke test: 100% of ML rows have non-null entryPrice + all 4 forward-return horizons; IC = -0.0951 (small honest signal, below leak threshold). Originally targeted 0.13.2-alpha; rebased to 0.13.3-alpha after PR #10 landed at 0.13.2 first. |
| 4a-fix-3 | Hotfix: ProphetDetail useEffect ReferenceError (PR #10) | done | 0.13.2-alpha | 2026-05-11 | Sentry production alert: `ReferenceError: Can't find variable: useEffect` at `ProphetDetail` (src/ProphetView.jsx:303). Fired every time a user expanded a prophet pick row. Root cause: line-1 React destructure imported `useState` only; the row-expansion component added a `useEffect` to fetch chart data but the hook was never added to the import. One-line fix. Sibling audit across all `src/*.jsx`: `App.jsx` uses `React.useRef(...)` via the React namespace (not a bug). No other view file has a missing-hook import. 281 tests green. Landed first (prod-crash priority); PR #9 rebased to 0.13.3 after this merged. |
| 4a-fix-4 | Production hotfix: seed-snapshots layout (no code PR yet) | diagnosed, code-fix pending | — | — | User report: "Earnings tab is not working at all." Live diagnosis: 0 of 7 boards have any snapshot doc in Firestore. Health endpoint shows every board on `fallback-partial`. Earnings stands out because its fallback (Finnhub calendar + per-ticker scoring) exceeds the 26s function timeout — other boards return small partial counts that mask the same root cause. Root cause: Netlify's function bundler silently drops files in `netlify/functions/scheduled/` subdirectory because the path matches neither auto-detect pattern (top-level file or per-function folder). Confirmed via Netlify API: `function_schedules: []` on every deploy back through Phase 1; the 7 `scan-*` functions don't appear in `available_functions` for any deploy. Cron registrations in `netlify.toml` point to functions that don't exist in build output, so the scheduler has never fired any board scan, ever. Fix is structural (move files up one level + rewrite `netlify.toml` schedule keys) — written up in `briefs/seed-snapshots-brief.md`. No code PR yet. After the layout fix lands and the first scheduled invocation completes, all 7 boards should flip from `fallback-partial` to `snapshot`. |
| 4b-1 | Backtest run viewer UI (read-only) | done | 0.14.0-alpha | 2026-05-12 | Phase 4a engine writes auditable run records to `backtestRuns/{runId}` with subcollections (`dailyEquity`, `trades`, `attribution`, `mlTraining`); 4b-1 makes them visible. Two new endpoints (`/api/backtest-runs`, `/api/backtest-runs/:runId`) proxy Firestore reads from the browser. Two new hooks (`useBacktestRuns`, `useBacktestRun`) with TanStack Query — list staleTime 30s, detail staleTime Infinity (historical runs are immutable). `BacktestView.jsx` fully rewritten: header + launcher placeholder (Phase 4b-2) + run list grid + run detail. Seven new run-detail subcomponents: `SurvivorshipBanner` (renders only when `corrected: false`, with link to BACKTEST_LIMITATIONS.md — non-negotiable since Phase 4a's whole honesty argument depends on it surfacing on every SP500/NDX run), `RunMetricsTiles` (8 KpiCards + optional benchmark; engine writes Pct fields pre-multiplied by 100 so no client-side *100), `EquityCurveChart` (Recharts line with auto-benchmark overlay; stride-downsamples above 5000 points), `DrawdownChart` (computes underwater % client-side from dailyEquity peaks), `AttributionChart` (per-analyst bar; bucketing = attribute each row's contribution to the layer with highest score at entry — Phase 5 will refine), `RegimeBreakdownTable` and `TopTradesTable` (both sortable via `useSortable` + `SortableTh` per standing rule). Mobile-first single-column layout tested at 375px. Legacy `useBacktest` hook + `/api/backtest` endpoint + old BacktestView are now orphaned (zero consumers — EngineTestView actually uses `useEngineTest`, brief assumption was wrong); left in tree as dead code, removal is a separate housekeeping pass. Bundle 256kB gzipped (budget 820kB). 331 tests green (was 290 baseline; +41 new across 4 test files: 10 endpoint, 8 hook, 7 banner, 10 metrics, 6 attribution aggregation). Caveat: only Dow runs exist in Firestore at landing time (all `corrected: true`), so the survivorship banner is verified via tests rather than a live SP500 screenshot. |
| 4b-2 | Backtest run launcher | done | 0.15.0-alpha | 2026-05-12 | UI launch via Netlify background function. The 15-minute background-function cap is leveraged via the `-background.ts` filename suffix (same trick `seed-scan-background.ts` uses); Netlify's bundler treats any function with that suffix as a background container regardless of how invoked, and the gateway returns 202 immediately while the engine works for up to 15 minutes. Architecture: trigger endpoint `POST /api/backtest-runs` (synchronous, <1s) validates the config via the engine's exported `validateConfig`, enforces prophet-only (other boards' PIT scoring is incomplete per BACKTEST_LIMITATIONS.md), runs a single-flight check (30-minute window, `status in ('pending','running')` single-field query so no composite index needed, time filter in code), allocates the runId, writes `backtestRuns/{runId}` with new `status: 'pending'`, then fires-and-forgets `POST /.netlify/functions/run-backtest-background` with `{runId, config}`. Background function flips `pending → running` via new `persistRunRunning(runId)` helper, then awaits `runBacktest(config, { resumeRunId })` — engine's `resumeRunId` option (new) skips the duplicate `generateRunId` + `persistRunStart` writes. Background URL built from the request's `x-forwarded-host` so deploy previews invoke their own background function rather than production's. Frontend: `useStartBacktest` mutation hook returns annotated errors (status, runId) so the launcher can deeplink 409 conflicts to the existing in-flight run; `useBacktestRun` patched with `refetchInterval` that returns 5000 while `status` is `pending|running` and `false` otherwise, so the run-detail view polls live until completion and stops the moment the terminal state lands. `BacktestLauncher` form (replaces 4b-1's `LauncherPlaceholder`): mobile-first single-column form with universe/board/dates/rebalance/topN/capital + collapsible Advanced section (minComposite, maxPositionPct, maxSectorPct, cashSleeve, weighting). Inline `SurvivorshipBanner` (reused, not forked) when sp500/ndx selected; amber Clock-icon pre-warning when russell2k selected. Non-prophet boards rendered but disabled with tooltip + BACKTEST_LIMITATIONS link. 202 → green CheckCircle2 banner + auto-select new runId in parent view; 409 → red banner with "View existing run" deeplink that calls `setSelectedRunId(error.runId)`. Bundle 259.68 kB gzipped (was 256.18 after 4b-1; +3.5 kB, brief budget was +5 kB). 367 tests green (+36 across 4 files: 7 background, 9 trigger, 4 mutation, 14 launcher + 2 polling). Persistence schema docstring updated to document the four-state lifecycle: `pending → running → complete\|failed`. |
| 4b-3 | Run cancellation + config presets + saved templates | pending | — | — | Three closely-related improvements deferred from 4b-2. (1) Run cancellation: Firestore-backed cancellation token the engine polls between rebalances; without this, a regretted russell2k launch just sits until the 15-min cap kills it. (2) Config presets: a few hand-curated configs (e.g. "Dow 2018-2024 monthly top-20" used by Phase 4a tests) saved as one-click templates. (3) Saved templates: user-saved configs persisted to Firestore, listable in the launcher. Also folds in the granular progress signal ("Rebalance 6 of 84") which requires the engine to write per-rebalance progress events to Firestore — non-trivial engine touch. |
| 5 | Calibration loop + ML refinement | pending | — | — | — |
| 6 | Real options data | pending | — | — | — |
| 7 | Portfolio layer | pending | — | — | — |
| 8 | Position sizing engine | pending | — | — | — |
| 9 | Exit / trade management | pending | — | — | — |
| 10 | Missing data classes | pending | — | — | — |
| 11 | Analyst depth | pending | — | — | — |
| 12 | Auth + DR | pending | — | — | — |
| 13 | Scale + caching + staging | pending | — | — | — |
| 14 | Audit trail + compliance hooks | pending | — | — | — |

---

## Estimate roll-up

|  | Sessions |
|---|---|
| Phase 0 | 1–2 |
| Phase 1 | 2–3 |
| Phase 2 | 2 |
| Phase 3 | 1–2 |
| Phase 4 | 2–3 |
| Phase 5 | 3–4 |
| Phase 6 | 1–2 |
| Phase 7 | 1–2 |
| Phase 8 | 1–2 |
| Phase 9 | 1–2 |
| Phase 10 | 2 |
| Phase 11 | 2 |
| Phase 12 | 1 |
| Phase 13 | 1–2 |
| Phase 14 | 1 |
| **Total** | **22–32 sessions** |

At a session a week, this is ~5–7 months of evening/weekend work. At a couple sessions a week, ~3 months. Phases 0 and 1 are sequential and high-leverage. After Phase 1 several phases parallelize (e.g., 6 and 7 are independent; 10 and 11 are independent).

---

## Highest-leverage path if time gets compressed

If you only have time for the top three: **Phase 0, Phase 1, Phase 4.** That gets you tests + CI + spend cap + Sentry, comprehensive universe coverage with snapshots, and a real backtest. Everything else compounds off those.

Phase 1 is the user-visible win — small caps suddenly become discoverable. Phase 4 is the credibility win — analyst weights stop being guesses. Phase 0 is the protection — neither of the above can be trusted without the engineering foundation underneath.

Worst path: skipping Phase 0 to chase features. Cache poisoning recurs, Anthropic spend gets weird, a bad commit silently breaks prod. Done that movie three times already.

---

## Live operational state (post Phase 4a)

Snapshot of what's open / in flight / blocked as of 2026-05-11. The status table above is the formal record; this section is the working-memory checklist.

### Open PRs awaiting your merge call

None. Hotfix queue cleared 2026-05-11:
- PR #10 (useEffect import) merged at `4ca9a18` as `0.13.2-alpha`. Prod crash on prophet-row expansion: resolved.
- PR #9 (ML-row bar window) rebased to `0.13.3-alpha` after #10 took the 0.13.2 slot; merged at `1b63427`. ML rows now populate `entryPrice` + forward returns; IC reports honest signal (-0.0951 on Dow 2018-2024).
- PR #11 (this doc update) — merging now alongside the live-state refresh.

Next code work (largest-first): seed-snapshots layout (diagnosed below), Phase 4b backtest viewer (brief at `briefs/phase-4b-brief.md`).

### Diagnosed-but-no-PR-yet

- **Seed-snapshots layout fix.** Root cause known: 7 scheduled scan functions in `netlify/functions/scheduled/` aren't deployed by Netlify because the subdirectory pattern isn't auto-detected. Brief written: `briefs/seed-snapshots-brief.md`. Needs an agent session to do the file-move + `netlify.toml` rewrite + verify schedules register. After the layout fix lands, first scheduled invocation will populate the cold cache and all 7 boards should flip from `fallback-partial` to `snapshot`. Earnings tab is the user-visible payoff.

### Outstanding remediation items

- 🚨 **Rotate the leaked Firebase service account key.** `private_key_id: c52711f114...` on `firebase-adminsdk-fbsvc@tradeiq-alpha.iam.gserviceaccount.com`. Every Netlify build of TradeIQ continues to use it. Action: Google Cloud Console → IAM → Service accounts → Keys → generate new + delete old → paste new JSON into Netlify env var `FIREBASE_SERVICE_ACCOUNT`. ~5 min from your phone.
- **Health endpoint reports hardcoded `version: 0.10.0-alpha`.** Cosmetic, but worth syncing to the real `APP_VERSION` whenever a hotfix touches `netlify/functions/health.ts`.

### Known second-tier issues surfaced by the Phase 4a smoke tests

These aren't urgent — none is blocking, and the engine produces honest numbers without addressing them. File when ready:

1. **Composite scores cluster at the `minComposite: 50` floor on early picks.** Attribution rows show `layers.fundamental: 0` consistently. The fundamental layer is probably returning a default-zero when Polygon fundamentals are thin for the older end of the 2018-2024 window. Separate scorer issue.
2. **`recovery_days: null` on runs where the equity curve clearly does recover** intermediate drawdowns. Likely a bug in the recovery-days computation when the curve dips + rebounds multiple times. Separate metrics bug.
3. **Quiver lobbying schema noise.** ~2,300 `schema_mismatch` warns per full Dow scan (`Issue: expected string, received null`). Warn-and-continue fallback works; no functional impact. Hygiene issue.
4. **Quiver patents endpoint 403/404s.** 55 hits per full scan. Same warn-and-continue path. Quiver may have moved the endpoint.
5. **`marketCapBucket: null` on every ML training row.** `FundamentalsSnapshot` doesn't expose `marketCap`. Phase 11 (analyst depth) is the natural place to add it; Phase 5 ML can read whatever's available without it.

### What Phase 4b will need from this engine

For when an agent picks up Phase 4b:

- **Real run records exist** in Firestore at `backtestRuns/{runId}` from the smoke tests. UI can develop against them without needing to re-run the engine. Most recent honest run (post 4a-fix-2): `bt_20260511185505_ala21n` (Dow 2018-2024 monthly top-20 prophet board).
- **`universeSurvivorshipCorrected` stamp** lives on every result document. The UI MUST surface a banner when `corrected: false` (i.e., any SP500 or NDX backtest). Brief says "Phase 4b UI must gate the run with an explicit disclosure" — this is the non-negotiable part.
- **`tickerFailures` field** is also on every result (added in 4a-fix-1). UI should show a yellow warning when `failureRatePct > 5%` and a red banner when `> 50%`. Sample of first 20 failures is bounded so it's safe to render inline.
- **Only the prophet board has a working PIT scoring path** in 4a. UI should either disable non-prophet board options or surface a "coming soon" state. Engine returns null + a `warnings` entry for other boards.

### What Phase 5 will need from these runs

The `backtestRuns/{runId}/mlTraining` subcollection is the training dataset. Each row has:
- `composite` + per-layer scores at decision time
- `regime` + `sector` at decision time
- `forward5dReturn`, `forward20dReturn`, `forward60dReturn`, `forward252dReturn` (after PR #9 lands)
- `entryPrice` (after PR #9 lands)
- `marketCapBucket: null` (deferred — Phase 11 dependency)

Most recent run has 183 ML rows (Dow 7-year monthly window). Russell 2k weekly window would yield substantially more — recommend running that config to seed the dataset before Phase 5 starts. The CLI is at `scripts/run-backtest.ts`; sample configs in `configs/`. Live env vars pull from Netlify (team slug `chad-gdxevza`).
