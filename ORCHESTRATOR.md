# TradeIQ — Orchestrator

**Purpose.** Sequence every fix and capability gap into a phased build plan. One doc, persistent in repo, updated each session. Each phase is a shippable unit ending in a green deploy and a status update at the bottom of this doc.

**Rule of the road.** Personal tool, but every commit goes through CI gates. The status table at the bottom is the single source of truth on what's done. The phase deep-dives are reference material for whoever picks up the next workstream.

**Current state (2026-05-12).** Production at `v0.15.0-alpha` on `https://tradeiq-alpha.netlify.app`. Phases 0 through 4b-2 shipped + all four 4a hotfixes landed. Three briefs sitting on the runway awaiting agent execution: `phase-4c-1-brief.md`, `phase-4c-2-brief.md`, `phase-5a-brief.md`. Two security items still outstanding (PAT + FB SA key rotations — see Outstanding remediation below).

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
- Briefs never contain literal secrets. Use `<read-only-PAT, provided per session>` placeholders. Lesson from the secrets-scan incident — see Lessons-learned section.
- Smoke-test every new HTTP route on the deploy preview BEFORE merging to main. Unit tests can't catch Netlify routing quirks. Lesson from PR #17/#18.

---

## Stack reference (read first if you're a fresh conversation)

- **Repo:** `DavisDelivery/TradeIQ`
- **Netlify site:** `tradeiq-alpha.netlify.app` (site ID `8e90d525-78f3-4288-9c15-8b1968e994c1`)
- **Firebase project:** `tradeiq-alpha`
- **Production:** `https://tradeiq-alpha.netlify.app`
- **Netlify team:** business account `chad@davisdelivery.com`
- **Read-only `GITHUB_PAT`:** `<provided per session>`. Chad provides write-scoped PAT separately per session when push needed. Do not commit literal values to briefs.
- **`FIREBASE_SERVICE_ACCOUNT`:** JSON in Netlify env vars across all contexts. Service-account credentials used by every backend function via `netlify/functions/shared/firebase-admin.ts`.
- **Anthropic, Polygon, Finnhub, Quiver, FRED:** all keys in Netlify env, configured across all contexts.
- **Frontend stack:** React + Vite + TanStack Query + Recharts + Tailwind. Mobile-first, neutral dark theme.
- **Backend stack:** Netlify Functions (TypeScript), Firestore via firebase-admin, Zod at every external provider boundary.
- **Persistence schema:**
  - `boardSnapshots/{board}/{universe}/{snapshotId}` — full scan results, model version stamped
  - `backtestRuns/{runId}` + subcollections `dailyEquity / trades / attribution / mlTraining`
  - `pitCache/{key}` — point-in-time data cache, Firestore-backed
  - `tradeLog/{tradeId}` — user-logged trades
- **Boards (7 total):** target, prophet, catalyst, williams, lynch, insider, earnings. Each has a `scan-{board}-{universe}.ts` scheduled function + a live API endpoint. After Phase 1 + 4a-fix-4, all boards are snapshot-first with fallback-partial live scan.
- **Universes (4):** `dow` (30), `sp500` (~500), `ndx` (~100), `russell2k` (~2037). The russell2k pool is large enough to require a sieve architecture for prophet — see Phase 4c-2.

### Code-path landmarks

- Backtest engine: `netlify/functions/shared/backtest/engine.ts` (+ `walk-forward.ts`, `costs.ts`, `metrics.ts`, `attribution.ts`, `persistence.ts`, `types.ts`)
- Backtest UI: `src/BacktestView.jsx` + `src/components/{BacktestLauncher,SurvivorshipBanner,RunMetricsTiles,EquityCurveChart,DrawdownChart,AttributionChart,RegimeBreakdownTable,TopTradesTable,KpiCard,ChartPanel}.jsx`
- Backtest hooks: `src/hooks/{useBacktestRuns,useBacktestRun,useStartBacktest}.js`
- Background functions: `run-backtest-background.ts`, `seed-scan-background.ts` (filename suffix `-background.ts` gives 15-min container; same pattern used for both)
- Scheduled scan functions: `netlify/functions/scan-{board}-{universe}.ts` — 23 files post-4a-fix-4 (one per board × universe; earnings stays monolithic by design)
- Snapshot store: `netlify/functions/shared/snapshot-store.ts`
- PIT layer: `netlify/functions/shared/{data-provider,insider-provider,political-provider,patent-provider,govcontracts-provider,universe-history,pit-cache}.ts`
- Zod schemas: `netlify/functions/shared/schemas/{polygon,finnhub,quiver,fred,index}.ts`
- Frontend prophet detail: `src/ProphetView.jsx` (contains LAYER_META, renders the 7-layer panels conditionally on `pick.layers`)

---

## Phase 0 — Engineering foundation + safety nets

**Goal.** Stop bleeding before doing anything else: tests, CI, spend cap, error tracking, backups, dead code purge.

**Shipped @ 0.10.0-alpha (2026-05-08).** Tests + CI + circuit breaker + structured logger + Sentry hooks + weekly Firestore backups all landed. **Partial:** the Anthropic budget cap was explicitly DROPPED by user decision (2026-05-12) — "I'm not worried about a budget for Anthropic." Future phases that increase API spend (Phase 4c-1 W4, Phase 5b ML inference) ship without a cap; surface a warning log instead of refusing.

### Scope (reference)

| Workstream | Files | Status |
|---|---|---|
| Vitest harness | `vitest.config.ts`, `src/**/*.test.jsx`, `netlify/functions/**/*.test.ts` | done |
| Cache-poisoning regression tests | `netlify/functions/__tests__/cache-poisoning.test.ts` | done |
| Layer scorer unit tests | `netlify/functions/shared/__tests__/prophet-layers.test.ts` | done |
| CI gates | `.github/workflows/ci.yml`, `deploy.yml` | done |
| Anthropic spend cap | `netlify/functions/shared/anthropic-budget.ts` | **DROPPED by decision** |
| Anthropic circuit breaker | same | done |
| Sentry | `src/lib/sentry.js`, function wrapper | done |
| Structured logger | `netlify/functions/shared/logger.ts` | done |
| Firestore backup workflow | `.github/workflows/backup-firestore.yml` | done |
| `app/` dead code purge | repo root | done |

---

## Phase 1 — Universe coverage + snapshot infrastructure

**Goal.** Every board scans the FULL configured universe — not the first 80–200 alphabetical. Snapshots double as the historical archive for backtest, calibration, replay.

**Shipped @ 0.9.1-alpha (2026-05-07).** Reordering between 0 and 1 ended up with 1 shipping first; doc records the actual sequence. **All 7 boards snapshot-first end-to-end.** FreshnessPill on every view. HistoryView replay surface. Backfill script for tradeLog reconstruction.

**Critical follow-on:** the scheduled scan functions had a layout bug (functions in `netlify/functions/scheduled/` were never deployed) — diagnosed early, fixed in Phase 4a-fix-4.

### Scope (reference)

| Workstream | Files | Status |
|---|---|---|
| Firebase Admin in functions | `netlify/functions/shared/firebase-admin.ts` | done |
| Snapshot store | `netlify/functions/shared/snapshot-store.ts` | done |
| Model version stamp | `netlify/functions/shared/model-version.ts` | done |
| 7 board scheduled scans (later split to 23 per-universe) | `netlify/functions/scan-{board}-{universe}.ts` | done (post-4a-fix-4) |
| 7 live API rewires (snapshot-first + fallback-partial) | each `*-board.ts` / `*-picks.ts` | done |
| Freshness pill | `src/components/FreshnessPill.jsx` | done |
| History view | `src/HistoryView.jsx` | done |
| Backfill script | `scripts/backfill-tradelog.ts` | done |

---

## Phase 2 — Refactor foundation: schemas + monolith split + server state

**Goal.** Refactor App.jsx, add Zod at every provider boundary, replace ad-hoc fetch with TanStack Query.

**Shipped @ 0.11.0-alpha (2026-05-08).** Zod at 5 provider boundaries (10 fetch sites + 5 Quiver datasets). App.jsx went from 2965 → 331 lines. 16 hooks + provider wrap. All 13 views wired to hooks. Bundle +12kB gzipped, still under 820kB budget.

### Scope (reference)

| Workstream | Files | Status |
|---|---|---|
| Zod schemas | `netlify/functions/shared/schemas/{polygon,finnhub,quiver,fred,index}.ts` | done |
| Split App.jsx | `src/views/*.jsx` (7 views) | done |
| Mock data extraction | `src/lib/mockData.js` | done |
| TanStack Query | every view | done |
| Centralized query keys | `src/lib/queryKeys.js` | done |
| 16 hooks | `src/hooks/use*.js` | done |

---

## Phase 3 — Point-in-time data layer

**Goal.** Audit every external data source for "as-of" semantics. Wrap each provider with explicit PIT guarantees or document where PIT is impossible.

**Shipped @ 0.12.0-alpha (2026-05-10).** All 5 providers as-of capable. FRED `vintage_dates` (gold-standard PIT for macro). Polygon fundamentals/news. Finnhub recommendations (hybrid: live filter + snapshot fallback). Quiver political/patents/contracts. **Universe history covers Dow 2018-01-31..2026-04-30 monthly (full coverage).** sp500/ndx/russell current seed only (Wikipedia/iShares hostname-blocked at egress in build env; `docs/UNIVERSE_HISTORY_RUNBOOK.md` documents how to extend from a network that allows the hosts).

PIT audit doc enumerates every data class with workarounds for non-PIT vendors. 55 new PIT correctness tests.

### Scope (reference)

| Workstream | Files | Status |
|---|---|---|
| PIT audit | `docs/POINT_IN_TIME_AUDIT.md` | done |
| Bars (Polygon, PIT-safe by nature) | `data-provider.ts` | done |
| Fundamentals (Polygon, filter by filed-before) | `data-provider.ts:getFundamentals` | done |
| News (Polygon, filter by published_utc) | `data-provider.ts:getNews` | done |
| Insider (Finnhub + Quiver, filter by filing date) | `insider-provider.ts` | done |
| Political/patents/contracts (Quiver, filter by date) | `political-provider.ts` etc. | done |
| Recommendations (Finnhub, hybrid live + snapshot) | `data-provider.ts` | done |
| Universe history | `netlify/functions/shared/universe-history.ts` | done (Dow full; others seed) |

---

## Phase 4 — Real backtest

### 4a — Engine + correctness (shipped @ 0.13.x-alpha, 2026-05-11)

Walk-forward engine with hot PIT cache (Firestore-backed). Portfolio + costs + slippage. Per-analyst attribution. ML hook data (forward 5d/20d/60d/252d returns persisted to `backtestRuns/{runId}/mlTraining/`). STOCK Act 45-day forward-shift. Walk-forward integrity tests (11 P0). Dow + Russell fully backtest-able with `corrected: true` survivorship stamp; SP500/NDX uncorrected with required disclosure. CLI script + 3 sample configs. `BACKTEST_LIMITATIONS.md`. **Prophet board only** — other boards return null and emit warning (Phase 5b territory).

Required four follow-on hotfixes:

- **4a-fix-1** (PR #8, `0.13.1-alpha`): Firestore Admin SDK rejected `undefined` field values; `getEarningsIntel` returned objects with optional undefined fields; cache writes threw; engine's silent `catch{}` dropped every ticker → all-zeros backtest. Three-layer fix: `ignoreUndefinedProperties: true` setting; structured `TickerFailure` tracking with HIGH FAILURE RATE warning >50%; happy-path integrity test that empirically catches the bug. Post-fix smoke: Sharpe 0.224, CAGR 1.03%, 350 trades, 0% failure rate.
- **4a-fix-2** (PR #9, `0.13.3-alpha`): ML training rows had `entryPrice: null` and forward returns null on all 206 rows; IC=0.000. Root cause was bar window math — `getCachedBarsThrough(ticker, asOfDate + 400d)` started 100 days AFTER the rebalance, so `lastCloseAtOrBefore(longBars, asOfDate)` had nothing to find. Fix: new `getCachedBars(ticker, from, to)` with explicit window. Post-fix IC=-0.0951 (small honest signal, below leak threshold).
- **4a-fix-3** (PR #10, `0.13.2-alpha`): Sentry prod alert `ReferenceError: Can't find variable: useEffect` on prophet row expansion. Line-1 React destructure imported `useState` only. One-line fix. Sibling audit confirmed no other view file had the bug.
- **4a-fix-4** (PRs #12/#13/#14, `0.13.4-alpha`, 2026-05-11): scheduled scan functions in `netlify/functions/scheduled/` subdirectory were silently dropped by Netlify's bundler — `function_schedules: []` on every deploy since Phase 1; the 7 `scan-*` functions never appeared in `available_functions`. **Cron had never fired any board scan, ever.** Three-PR fix: (#12) moved 7 scan files to flat `netlify/functions/` + switched to `schedule(CRON, async () => {})` wrapper from `@netlify/functions`; (#13) split 6 multi-universe scans into 23 per-universe functions (`scan-{board}-{universe}.ts`) to fit within Netlify's 15-min cap × 4 universes; (#14) added `netlify/functions/seed-scan-background.ts` — HTTP-invokable fire-and-forget seeder using `-background.ts` filename suffix to bypass the 211s gateway timeout. After fix-4, scheduled scans actually run.

### 4b — Backtest UI

**4b-1 — Run viewer (read-only, shipped @ 0.14.0-alpha, 2026-05-12).** Two endpoints (`/api/backtest-runs`, `/api/backtest-runs/:runId`). Two hooks. BacktestView rewritten. Seven run-detail subcomponents including the non-negotiable `SurvivorshipBanner` (renders only when `corrected: false`, links to `BACKTEST_LIMITATIONS.md`). Mobile-first 375px tested. Bundle 256.18 kB gzipped. 331 tests green.

**4b-2 — Run launcher (shipped @ 0.15.0-alpha, 2026-05-12).** UI launch via Netlify background function. `-background.ts` filename suffix gives the 15-min container window even when invoked via HTTP. Trigger endpoint `POST /api/backtest-runs/start` (synchronous <1s) validates config via engine's exported `validateConfig`, enforces prophet-only, runs single-flight check (30-min window), writes `pending` record, fires-and-forgets to `run-backtest-background`. Background flips `pending → running` via new `persistRunRunning(runId)` helper. Frontend: `useStartBacktest` mutation hook returning annotated errors (409 deeplinks to existing run); `useBacktestRun` patched with `refetchInterval` 5s while in-flight. `BacktestLauncher` form replaces 4b-1's placeholder. Bundle 259.68 kB (+3.5 kB). 367 tests green.

**Routing lesson during 4b-2:** the original brief specified `conditions = { method = ["POST"] }` in `netlify.toml` to split GET (list) from POST (trigger) on `/api/backtest-runs`. PR #17 shipped it that way. Netlify silently dropped the method condition, both rules matched, GET fallback won, POSTs hit the list endpoint. Caught in production via smoke test 5 min after merge. **PR #18 hotfix moved the trigger to a distinct literal path `/api/backtest-runs/start`** + added a defense-in-depth `'start'`-reserved-word guard in the get endpoint. Lesson absorbed into Standing rules above.

**4b-3 — Cancellation + presets + saved templates (pending, no brief yet).** Three improvements deferred from 4b-2: (1) Firestore-backed cancellation token the engine polls between rebalances; (2) hand-curated config presets (Dow 2018-2024 monthly top-20 as the canonical template); (3) user-saved configs in Firestore listable in the launcher. Also folds in granular progress ("Rebalance 6 of 84") which requires the engine to write per-rebalance events to Firestore.

### 4c — Prophet board completeness (briefs ready, pending agent execution)

User report from a PWR screenshot (2026-05-12): the prophet detail view shows only 3 of 7 analyst panels above the fold, the AI Thesis block is missing on most picks, and EPS-beats counts read `0/4` for most tickers.

**4c-1 — Prophet narrative + EPS bug (brief at `briefs/phase-4c-1-brief.md`).** Five workstreams: (W1) UI placeholder block when `pick.narrative` is null with a "→ Generate AI thesis" button; (W2) `POST /api/prophet-narrate` lazy endpoint reusing the extracted `narrative-cache.ts` + `narrative-generator.ts` modules; (W3) `useGenerateNarrative` mutation that patches the cached prophet query; (W4) narrate-all in `scan-prophet-{largecap,russell,all}.ts` — ships freely now that budget cap is dropped; (W5) EPS-beats diagnostic-first fix that renders `null` as `— / 4 beats` not `0 / 4` so the user can distinguish "missed" from "unknown." Target: `0.15.1-alpha`, ~16 files, ~700 lines, ≥372 tests.

**4c-2 — Russell sieve architecture (brief at `briefs/phase-4c-2-brief.md`).** Replaces the single-pass russell scan (which can't reach the back half of 2037 names within Netlify's 15-min cap) with a 3-stage sieve: Stage 1 bars-only signals on all 2037 in ~2 min → ~400 survivors; Stage 2 +fundamentals +RS-vs-SPY in ~4 min → ~80; Stage 3 full 7-layer scoring in ~8 min. Snapshot stamps `sieve.stage{1,2,3}` metadata; new `SieveCoverageStrip` UI renders `2037 → 412 → 87 → 23` ladder; amber when any stage stamps partial. Confined to russell only — largecap + all keep single-pass. Target: `0.16.0-alpha`, ~17 files, ~1300 lines, ≥377 tests.

---

## Phase 5 — Calibration loop + ML refinement

**Hard dependency:** Phase 3 (PIT data) and Phase 4a (real backtest with forward-return labels) — both shipped.

**Honest caveat (kept from original spec).** ML on stock picking is hype-prone. Three guardrails: (1) all ML is interpretable — gradient boosting + SHAP, k-NN explanations, no deep nets; (2) all ML re-ranks on top of the rule-based composite, never replaces it; (3) every ML output ships with a fallback so a model failure degrades gracefully. Auto-disable rule: if meta-ranker IC < composite-alone for 2 consecutive weeks, disable.

The brief work-stream splits Phase 5 into three sub-phases:

### 5a — Training pipeline + discovery (brief at `briefs/phase-5a-brief.md`, pending agent)

Discovery phase. The engine has been writing `mlTraining` rows since Phase 4a. Brief asks: does any ML model beat the existing hand-tuned composite scorer by a statistically meaningful margin, under methodology that survives scrutiny?

Methodology, non-negotiable per the brief:
- Purged walk-forward CV with embargo expressed in rebalances
- Cross-sectional rank-IC as the primary metric
- Paired Wilcoxon signed-rank test vs composite baseline, Bonferroni-corrected per config
- Per-config IC reporting when multiple configs survive deduplication
- 5 model classes (linear, ridge, LightGBM ranker, LightGBM binary, LightGBM full-feature) + Model 0 baseline (existing composite)

Polyglot decision: introduces Python under `scripts/ml/`. Confined, not on the hot path. The deliverable is `reports/phase-5a/findings.md`, which selects one of three paths for 5b: A (deploy winning model), B (more data/features needed), C (inconclusive, repeat in 6 months).

**No frontend changes; no `APP_VERSION` bump.**

### 5b — Production rollout (pending, blocked on 5a finding)

If 5a's Path A: deploy the winning model into the scorer. Open question 5b answers: how do we ship a Python-trained model artifact back into the TypeScript Netlify function tier? Three candidates — (a) re-implement inference in TS (only feasible for linear models), (b) export to ONNX and load via Node ONNX runtime, (c) stand up a separate Python inference service (Cloud Run or Cloud Functions). Decision in 5b.

### 5c — Monitoring + retraining cadence (pending, blocked on 5b)

Weekly retrain schedule. Calibration dashboard (per-analyst hit rate, alpha, info ratio rolling 30/90/180 days). Auto-disable rule wired. Model version stamped on every snapshot.

### Phase 5 broader scope (from original spec, retained for reference)

| Workstream | Files | Notes |
|---|---|---|
| Weight optimizer | `backtest/optimize-weights.ts` | Grid or Bayesian. Cap weight changes per cycle. |
| Regime-conditional weights | `analyst-runner.ts` | One weight vector per regime. |
| Post-trade AI review | `netlify/functions/scheduled/post-trade-review.ts` | Daily; classifies closed trades via Opus. |
| Calibration dashboard | `src/views/CalibrationView.jsx` | Per-analyst rolling metrics. |
| Meta-ranker (gradient boosting) | `ml/meta-ranker.ts`, `scripts/train-meta-ranker.ts` | XGBoost/LightGBM on layer scores → forward returns. Weekly retrain. |
| Case-based reasoning | `ml/similarity.ts`, `src/components/SimilarCasesPanel.jsx` | k-NN over historical signal vectors. |
| Bayesian online weight updates | `ml/bayes-weights.ts` | Beta posteriors per analyst, continuous update. |
| Anomaly flag | `ml/anomaly.ts` | Isolation forest. |
| Regime classifier upgrade | `ml/regime.ts` | Replace rule-based regime with logistic/gradient boosting on wider macro features. |

---

## Phase 6 — Real options data

**Goal.** Replace the volume-and-realized-vol proxy in `options-flow.ts` with actual OPRA chain data.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Provider selection | `docs/OPTIONS_PROVIDER.md` | New. Compare Tradier (free OPRA delayed), Polygon Options, TradeStation, Alpaca. |
| Options data provider | `netlify/functions/shared/options-provider.ts` | New. `getChain`, `getIV30`, `getIVRank`, `getSkew`. |
| IV percentile + IV rank | same | New. 252-trading-day rolling. |
| Term structure + skew | same | New. Front vs back month; 25-delta call vs put. |
| Options-flow rewrite | `netlify/functions/options-flow.ts` | Real chain volume, OI changes, unusual flow detection. |
| Earnings IV plumbing | `earnings-board.ts` | Real IV percentile, not proxy. |
| Strike picker | `shared/options-strike-picker.ts` | New. Setup + bias + expiration → real chain strikes. |

**Dependencies.** Phase 0 spend awareness (chain calls can balloon).

---

## Phase 7 — Portfolio layer

**Goal.** Stop scoring tickers in isolation. Every recommendation respects portfolio constraints: correlation, sector caps, exposure bands, beta-adjusted sizing.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Correlation matrix | `netlify/functions/shared/correlation.ts` | New. Rolling 60-day, daily update. |
| Sector exposure caps | `portfolio/exposure.ts` | New. Hard caps per sector (default 25%); sub-industry 15%. |
| Factor exposure | `portfolio/factors.ts` | New. Momentum, value, quality, size, vol. |
| Gross / net by regime | `portfolio/exposure.ts` | New. Risk_on 100/100; neutral 70/70; risk_off 40/30. |
| Beta-adjusted sizing | `portfolio/beta-size.ts` | New. |
| Portfolio VaR | `portfolio/var.ts` | New. 1-day 95% historical. |
| Portfolio dashboard | `src/views/PortfolioView.jsx` | New. |
| Recommendation filter | `runAnalystsForTicker` | Modify. Flag sector-cap breaches + 0.8+ correlations. |

---

## Phase 8 — Position sizing engine

**Goal.** Three sizing modes properly enforced: equal-weight, vol-target, fractional Kelly.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Realized vol per ticker | `shared/realized-vol.ts` | New. Rolling 30-day annualized. |
| Sizing modes | `portfolio/sizing.ts` | New. Three pure functions. |
| Per-setup sizing rules | `earnings-board.ts`, `prophet-picks.ts` | Modify. Config-driven. |
| Hit-rate-aware Kelly | `portfolio/sizing.ts` | New. Uses Phase 5 attribution. |
| Sizing enforcer in journal | `src/JournalView.jsx`, `tradeLog.js` | Modify. recommended vs actual. |
| Rebalancer | `portfolio/rebalance.ts` | New. Trade list to target weights. |

**Dependencies.** Phase 5 (Kelly needs hit rates), Phase 7 (sizing is portfolio-aware).

---

## Phase 9 — Exit / trade management

**Goal.** Trades have a lifecycle. Trailing stops, scale-out ladders, news-event triggers, correlation-break alerts, time-based exits.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Trade state machine | `shared/trade-lifecycle.ts` | New. Open / T1-hit / T2-hit / stopped / time-exited / manually-closed. |
| ATR trailing stop | `lifecycle/trailing-stop.ts` | New. Activates after T1. |
| Scale-out ladders | `lifecycle/scale-out.ts` | New. Default 1/3 at T1, 1/3 at T2, 1/3 runner. |
| News-event triggers | `netlify/functions/scheduled/news-watch.ts` | New. Daily scan; flag material events. |
| Correlation-break trigger | `lifecycle/correlation-break.ts` | New. SPY 50dma break flags correlated longs. |
| Time-based exits | `lifecycle/time-exit.ts` | New. Vol plays close +1 post-earnings; PEAD 30/60 days. |
| Open positions view | `src/views/OpenPositionsView.jsx` | New. |
| Notifications | `src/lib/notifications.js` | New. Browser push, phone-first. |

---

## Phase 10 — Missing data classes

**Goal.** Plug the data gaps a serious desk wouldn't trade without.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Short interest + days-to-cover | `shared/short-interest-provider.ts` | New. FINRA biweekly + vendor for daily. |
| Borrow rate | same | New. IBKR if available, else Quiver. |
| Dark pool prints | `shared/darkpool-provider.ts` | New. Quiver dark pool or FINRA ATS. |
| Options skew | `options-provider.ts:getSkew` | From Phase 6. Surface in catalyst layer. |
| Block trade tape | `shared/block-trade-provider.ts` | New. Polygon trades >10k shares + cross-exchange flag. |
| Breadth indicators | `shared/breadth-provider.ts` | New. NH/NL, %>50dma, McClellan. |
| Sentiment | `shared/sentiment-provider.ts` | New. AAII bull/bear, NAAIM. |
| Credit spread layer | `shared/regime.ts` | Modify. Add HY OAS, IG OAS. |
| New analysts | `analysts/short-pressure.ts`, `breadth.ts`, `sentiment.ts` | New, each a composite layer. |
| Weight rebalance | `analyst-runner.ts` | Modify. Re-run optimizer with new analysts. |

**Dependencies.** Phase 5 (new weights calibrated, not guessed), Phase 6 (skew).

---

## Phase 11 — Analyst depth

**Goal.** Lynch view becomes actually Lynch. Fundamental analyst becomes actually fundamental. Build the dedicated short-side analyst.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Lynch depth | `analysts/lynch.ts`, `src/LynchView.jsx` | Rewrite. PEG vs analyst LT growth; D/E vs sector median; 5y EPS std; insider vs buyback; six-bucket classification. |
| Fundamental depth | `analysts/core.ts:runFundamental` | Rewrite. Add ROIC, FCF yield, share count drift, debt structure. |
| Dedicated short analyst | `analysts/short-side.ts` | New. Insider selling clusters, debt covenant stress, declining estimates, etc. |
| Earnings interpreter | `netlify/functions/shared/earnings-interpreter.ts` | New. Reads transcript via Opus, structured signals out. |
| Arbitrator | `netlify/functions/shared/arbitrator.ts` | New. Resolves analyst conflicts via Opus. |
| Claude-as-PM | `netlify/functions/scheduled/pm-decision.ts` | New. Daily structured PM decision. |

**Dependencies.** Phase 6 (skew for short signals), Phase 10 (short interest data).

---

## Phase 12 — Auth + DR

**Goal.** Firebase Auth on the app, per-user Firestore rules, daily backups verified by a restore drill.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Firebase Auth wiring | `src/firebase.js`, `src/lib/auth.js`, `src/components/AuthGate.jsx` | New. Google sign-in. |
| Per-user Firestore rules | `FIRESTORE_RULES.md` + console | Update. `request.auth.uid == resource.data.ownerUid`. |
| ownerUid on every record | `tradeLog.js`, all snapshot writers | Modify. Migration script for existing records. |
| Auth-aware functions | `netlify/functions/shared/auth.ts` | New. Verify Firebase ID token. |
| Frontend auth state | `src/lib/useAuth.js` | New. |
| Backup verification drill | `scripts/restore-drill.ts` | New. Quarterly. |

**Dependencies.** Phase 0 backups must exist first.

---

## Phase 13 — Scale + caching + staging

**Goal.** Caches survive cold starts. Functions don't get hammered. There's a staging URL.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Shared cache | `netlify/functions/shared/cache.ts` | New. Netlify Blobs or Upstash Redis. |
| Edge rate limiting | `netlify/edge-functions/rate-limit.ts` | New. Per-IP, 60/min. |
| Staging environment | new Netlify site `tradeiq-staging.netlify.app` | New. Separate Firebase project. |
| Promotion workflow | `.github/workflows/promote-to-prod.yml` | New. |
| Bundle splitting | `vite.config.js` | Modify. Code-split each view route. |
| Service worker (PWA) | `src/sw.js` | New. Phone-first offline read. |

---

## Phase 14 — Audit trail + compliance hooks

**Goal.** Every recommendation logged with model version, inputs, time, user. Exportable audit log.

### Scope (reference)

| Workstream | Files | Action |
|---|---|---|
| Recommendation log | Firestore `recommendationLog/{date}/{eventId}` | New. |
| Per-recommendation disclaimer | UI components | Modify. v{model}/{date} stamp on each card. |
| Audit export | `src/views/AuditView.jsx`, `scripts/export-audit.ts` | New. CSV / JSON for date range. |
| Compliance disclaimer surfacing | global footer + per-action | Modify. "Not financial advice" beyond footer. |
| Inputs hash | `shared/inputs-hash.ts` | New. Deterministic hash of all inputs. |

**Dependencies.** Phase 12 auth so user is identified.

---

## Cross-cutting concerns

- **Polygon / Finnhub / Quiver / FRED quota tracking.** Alert before hitting walls. (Anthropic spend cap was dropped by decision.)
- **Test coverage drift.** Coverage report on every PR. Gate at 50% for `shared/` files; aspire to 80% on scoring math.
- **Documentation drift.** This doc + `SPEC.md` kept honest. Each phase's PR updates both.
- **Briefs hygiene.** Never inline literal secrets. `SECRETS_SCAN_OMIT_PATHS = "briefs/*"` already in `netlify.toml` as belt-and-suspenders.

---

## Lessons learned (for whoever reads this fresh)

These are the non-obvious gotchas the project has hit:

1. **`undefined` in Firestore writes throws.** Set `ignoreUndefinedProperties: true` once in `firebase-admin.ts`; engine-level silent catches mask the problem ruinously (4a-fix-1).
2. **Bar window math.** When fetching forward-return bars, the window must START at or before the rebalance date, not after. `getCachedBars(ticker, from, to)` with an explicit window is the safe primitive; `getCachedBarsThrough(ticker, end)` had implicit-start semantics that bit (4a-fix-2).
3. **React hook imports.** Every view that uses a hook must import it. Line-1 React destructure is the single point of failure. Cross-view audit when fixing one (4a-fix-3).
4. **Netlify scheduled functions in subdirectories don't deploy.** Files in `netlify/functions/scheduled/*.ts` are silently dropped by the bundler — `function_schedules: []` on every deploy. Keep scan functions flat at `netlify/functions/scan-*.ts` (4a-fix-4).
5. **Per-universe scan splitting.** A single 4-universe scan function can't fit in Netlify's 15-min cap. Split into per-(board,universe) functions; earnings is the exception (calendar-driven, doesn't benefit) (4a-fix-4 PR #13).
6. **The `-background.ts` filename suffix unlocks 15-min container even via HTTP.** Used by both `seed-scan-background.ts` and `run-backtest-background.ts`. Standard pattern for any work that exceeds the 211s gateway timeout.
7. **Netlify method-conditioned redirects are silently dropped.** `conditions = { method = ["POST"] }` in `netlify.toml` doesn't work — the bundler treats the rule as malformed and silently ignores the condition; the unconditioned fallback wins. Use distinct literal paths for method-specific routing instead (4b-2 PR #18).
8. **Smoke-test every new HTTP route on the deploy preview before merging.** Unit tests can't catch Netlify's redirect-layer quirks. The 4b-2 routing bug shipped to prod for 5 minutes before catch (4b-2 PR #18).
9. **Briefs go in `briefs/` and shouldn't contain literal secrets.** Use `<read-only-PAT, provided per session>` placeholders. Real secrets in briefs trip Netlify's secrets scanner on every commit. Fix has been in place via `SECRETS_SCAN_OMIT_PATHS = "briefs/*"` env var, but the better fix is rotation + placeholders (this conversation's lesson).
10. **Composite scores cluster at 50.** Phase 4a smoke tests showed this — post-sigmoid normalization compression. Phase 4c-1 W5 + Phase 5a explore this. Real artifact, not a data bug, but ML on raw layer scores (pre-sigmoid) may extract information the composite squashed.

---

## Session-start protocol

When resuming work in a new conversation:

1. Read this doc end-to-end before doing anything.
2. Check the Status table — find the next phase marked `pending`.
3. If a brief exists for it (see Briefs awaiting execution), read the brief.
4. Read the phase's "Scope" + "Dependencies".
5. Verify dependencies are `done`. If not, surface that — don't skip.
6. Set up the working tree:
   ```bash
   cd /home/claude
   if [ ! -d tradeiq ]; then
     git clone https://<token>@github.com/DavisDelivery/TradeIQ.git tradeiq
   fi
   cd tradeiq
   git pull --rebase
   git checkout -b phase-N-<short-topic>
   ```
7. Build. Test. Smoke-test on deploy preview. Commit. Push. Open PR.
8. Update the Status table at the bottom of this doc with: phase number, version shipped, date, summary of changes, regressions noted.
9. Bump `APP_VERSION` if any user-visible change.
10. Verify deploy is live and version matches in the bundle.

---

## Status

`pending` → `in-progress` → `done` (with version + date). One row per phase. Single source of truth.

| # | Phase | Status | Version | Date | Notes |
|---|---|---|---|---|---|
| 0 | Engineering foundation + safety nets | done (partial) | 0.10.0-alpha | 2026-05-08 | Tests + CI + circuit breaker + structured logger + Sentry + weekly Firestore backups. **Anthropic budget cap DROPPED by decision 2026-05-12.** |
| 1 | Universe coverage + snapshot infrastructure | done | 0.9.1-alpha | 2026-05-07 | All 7 boards snapshot-first; FreshnessPill on all views; HistoryView replay. Scheduled scan layout bug fixed later in 4a-fix-4. |
| 2 | Refactor foundation (schemas + monolith split + TanStack Query) | done | 0.11.0-alpha | 2026-05-08 | Zod at 5 provider boundaries; App.jsx 2965→331 lines; 16 hooks; all 13 views wired. |
| 3 | Point-in-time data layer | done | 0.12.0-alpha | 2026-05-10 | All 5 providers as-of capable; Dow universe history full 2018-2026 monthly; sp500/ndx/russell seed only with runbook. |
| 4a | Real backtest v2 — engine + correctness | done | 0.13.0-alpha | 2026-05-11 | Walk-forward; PIT cache; portfolio + costs; attribution; ML hook data; 4 hotfixes followed. |
| 4a-fix-1 | Cache undef-rejection + silent catch (PR #8) | done | 0.13.1-alpha | 2026-05-11 | `ignoreUndefinedProperties: true` + structured TickerFailure + happy-path test. |
| 4a-fix-2 | ML-row bar window (PR #9) | done | 0.13.3-alpha | 2026-05-11 | New `getCachedBars(ticker, from, to)` with explicit window. Post-fix IC=-0.0951 (honest signal). |
| 4a-fix-3 | ProphetDetail useEffect import (PR #10) | done | 0.13.2-alpha | 2026-05-11 | One-line fix + sibling audit. |
| 4a-fix-4 | Scheduled function deployment (PRs #12/#13/#14) | done | 0.13.4-alpha | 2026-05-11 | Moved 7 scans flat + per-universe split (23 total) + `seed-scan-background.ts` helper. Scheduled scans now actually run. |
| 4b-1 | Backtest run viewer UI | done | 0.14.0-alpha | 2026-05-12 | Two endpoints, two hooks, BacktestView rewritten, 7 detail subcomponents, mobile-first 375px. 331 tests. |
| 4b-2 | Backtest run launcher | done | 0.15.0-alpha | 2026-05-12 | Background-function pattern via `-background.ts` suffix. PR #17 + #18 (routing hotfix to `/api/backtest-runs/start`). 367 tests. |
| 4b-3 | Run cancellation + presets + saved templates | pending | — | — | No brief yet. Cancellation token + curated presets + user-saved templates + per-rebalance progress events. |
| 4c-1 | Prophet detail completeness + EPS bug | pending (brief ready) | — | — | `briefs/phase-4c-1-brief.md`. Five workstreams: UI placeholder, lazy narrate endpoint, hook, narrate-all in scanner, EPS-beats null vs zero. Target 0.15.1-alpha. |
| 4c-2 | Russell sieve architecture | pending (brief ready) | — | — | `briefs/phase-4c-2-brief.md`. 3-stage filter to score all 2037 Russell names within 15-min cap. Target 0.16.0-alpha. |
| 5a | ML training pipeline (discovery) | pending (brief ready) | — | — | `briefs/phase-5a-brief.md`. Purged walk-forward CV with embargo; cross-sectional rank-IC vs composite baseline; Bonferroni-corrected Wilcoxon. 5 models + Model 0. No frontend, no version bump. Output: `reports/phase-5a/findings.md`. |
| 5b | Production rollout of winning model | pending | — | — | Blocked on 5a finding (Path A only). Decides Python-to-TS deployment path: TS re-impl, ONNX, or separate Python service. |
| 5c | Monitoring + retraining cadence | pending | — | — | Blocked on 5b. Weekly retrain; auto-disable if IC drops below composite; calibration dashboard. |
| 6 | Real options data | pending | — | — | OPRA chain data; IV percentile + IV rank + skew; strike picker; rewrites options-flow. |
| 7 | Portfolio layer | pending | — | — | Correlation matrix; sector caps; factor exposure; gross/net by regime; beta-adjusted sizing; VaR. |
| 8 | Position sizing engine | pending | — | — | Three modes (equal-weight, vol-target, fractional Kelly); per-setup sizing; rebalancer. |
| 9 | Exit / trade management | pending | — | — | Trade state machine; trailing stops; scale-out; news triggers; correlation-break; time exits; open positions view. |
| 10 | Missing data classes | pending | — | — | Short interest + borrow rate + dark pool + block trade tape + breadth + sentiment + credit spread. |
| 11 | Analyst depth | pending | — | — | Lynch depth; Fundamental depth; dedicated short-side; earnings interpreter; arbitrator; Claude-as-PM. |
| 12 | Auth + DR | pending | — | — | Firebase Auth + per-user Firestore rules + ownerUid migration + backup restore drill. |
| 13 | Scale + caching + staging | pending | — | — | Shared cache (Netlify Blobs); edge rate limiting; staging environment; bundle splitting; PWA. |
| 14 | Audit trail + compliance hooks | pending | — | — | recommendationLog; per-card model version stamp; export CSV; inputs hash. |

---

## Current operational state (2026-05-12)

### Production

- Live at `https://tradeiq-alpha.netlify.app` on `0.15.0-alpha`.
- All 7 boards return data. Snapshots are written by the post-4a-fix-4 scheduled scans; live endpoints serve snapshot-first with `fallback-partial` outside cron windows.
- Backtest runner end-to-end: launcher → trigger → background function → engine → Firestore → viewer. Polls live until completion.

### Open PRs awaiting merge

None. Hotfix queue cleared.

### Briefs awaiting agent execution

- `briefs/phase-4c-1-brief.md` — prophet detail completeness + EPS bug. Smallest scope, highest visible user impact. Target `0.15.1-alpha`.
- `briefs/phase-4c-2-brief.md` — russell sieve architecture. Bigger, independent. Target `0.16.0-alpha`.
- `briefs/phase-5a-brief.md` — ML training discovery. Polyglot (Python). Output is a report, not a deploy.

Order is independent; any can ship in parallel. Recommended first: 4c-1 (smallest, fixes the user-reported screenshot issue).

### Outstanding remediation items

- 🚨 **Rotate the leaked Firebase service account key.** `private_key_id: c52711f114...` on `firebase-adminsdk-fbsvc@tradeiq-alpha.iam.gserviceaccount.com`. Action: Google Cloud Console → IAM → Service accounts → Keys → generate new + delete old → paste new JSON into Netlify env var `FIREBASE_SERVICE_ACCOUNT`. ~5 min from phone. Longest-standing item.
- 🚨 **Rotate the read-only GitHub PAT.** The literal `ghp_sgXH…` appears in 17 brief files in git history (every brief since `phase-0-brief.md`). Once rotated, the leaked string is a dead key and the briefs-sweep PR becomes cosmetic rather than mitigation.
- **Briefs sweep PR** (cosmetic, post-rotation). Mechanical `s/ghp_…/<read-only-PAT, provided per session>/g` across 17 briefs + a CONTRIBUTING note. Defer until after rotation.
- **Health endpoint hardcoded `version: 0.10.0-alpha`.** Cosmetic but wrong in prod. Sync to real `APP_VERSION` next time `netlify/functions/health.ts` is touched.
- **Param-name normalization.** `?index=` vs `?universe=` is inconsistent across 7 boards. Cosmetic — frontend hooks already route per-board correctly. Small PR when convenient.

### Known second-tier issues (non-blocking, file when ready)

1. **Composite scores cluster at the `minComposite: 50` floor** on early picks. Attribution rows show `layers.fundamental: 0` consistently. The fundamental layer probably returns default-zero when Polygon fundamentals are thin (older end of 2018-2024 window, NKE/V/CVX). Phase 4c-1 W5 starts the diagnostic; Phase 5a may surface root cause.
2. **`recovery_days: null`** on runs where the equity curve clearly recovers intermediate drawdowns. Bug in recovery-days computation with multiple dips. Separate metrics fix.
3. **Quiver lobbying schema noise.** ~2,300 `schema_mismatch` warns per full Dow scan (`expected string, received null`). Warn-and-continue works; no functional impact.
4. **Quiver patents endpoint 403/404s.** 55 hits per full scan. Same warn-and-continue. Quiver may have moved the endpoint.
5. **`marketCapBucket: null` on every ML training row.** `FundamentalsSnapshot` doesn't expose `marketCap`. Natural fit for Phase 11 (analyst depth).

### Phase 0 leftovers (acknowledged-skipped)

- **Anthropic budget cap** — explicitly dropped by user decision 2026-05-12. Phases that increase API spend (4c-1 W4 narrate-all, future ML inference) ship without a cap. Surface a warning log if spend looks anomalous; don't refuse.
- Other Phase 0 items (Sentry, vitest, structured logger, weekly backups) all landed.

---

## What's already powering current work

- **`backtestRuns/{runId}/mlTraining`** — the training dataset for Phase 5a. Each row has `composite`, per-layer scores, `regime`, `sector`, `forward5dReturn`, `forward20dReturn`, `forward60dReturn`, `forward252dReturn`, `entryPrice`, `inPortfolio` boolean. `marketCapBucket` deferred to Phase 11.
- **`scan-{board}-{universe}.ts`** — 23 scheduled functions running on Netlify cron. After 4a-fix-4, these actually fire. Each writes to `boardSnapshots/{board}/{universe}/{snapshotId}`.
- **`seed-scan-background.ts`** — HTTP-invokable fire-and-forget seeder for manually triggering a single board+universe scan. Useful for bootstrapping snapshots without waiting for cron.
- **`run-backtest-background.ts`** — invoked by `POST /api/backtest-runs/start`. Wraps `runBacktest()` from the engine with the `-background.ts` suffix to get the 15-min container.
- **`BACKTEST_LIMITATIONS.md`** — required disclosure for SP500/NDX backtests (uncorrected universes). `SurvivorshipBanner` renders on every uncorrected run + on the launcher when sp500/ndx is selected.

---

## Highest-leverage path forward

**Near-term (one to three sessions).** Rotate the two keys. Hand off 4c-1 first — it's small, fixes a user-visible bug, and surfaces the EPS-beats diagnostic findings that may feed Phase 5a. Then 4c-2 (russell sieve unlocks scoring quality on the 2000-name universe). Then 5a (the answer to "does ML beat the composite" determines the next year's roadmap).

**Medium-term (three to ten sessions).** 5b deployment, then 4b-3 cancellation/templates, then Phase 6 (real options data), Phase 7 (portfolio), Phase 8 (sizing).

**Long-term.** Phases 9–14 mostly parallelize once Phase 6/7/8 land. Phase 12 (auth) should land before any sharing or commercialization conversation. Phase 14 (audit trail) becomes mandatory if commercialization happens.
