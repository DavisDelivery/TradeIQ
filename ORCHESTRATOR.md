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

## Phase 1 — Refactor foundation: schemas + monolith split + server state

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

**Dependencies.** Phase 0 (CI catches refactor regressions).

**Success criteria.**
- App.jsx is under 800 lines and contains only routing/shell.
- Tab switches no longer refetch already-fresh data.
- Bundle size is the same or smaller (verify via Vite build output).
- A Polygon schema change in a fixture test fails at the schema layer, not in JSX.
- All 7 view files exist and pass their own ErrorBoundary.

**Estimate.** 2 sessions. Split App.jsx is mostly mechanical; TanStack Query wiring is the careful part.

---

## Phase 2 — Snapshot infrastructure (the keystone)

**Goal.** Every day, every board (target, prophet, catalyst, earnings, insider, williams, lynch) is snapshotted to Firestore with a model-version tag.

**Why.** This is the foundation that unlocks the real backtest, the calibration loop, regime-conditional weighting, and any honest performance claim. Without this, "backtest" is forever a forward-only sample of current model on current universe — which is what's wrong with the current backtest.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Snapshot writer | `netlify/functions/scheduled/daily-snapshot.ts` | New. Scheduled function (Netlify cron). Runs all boards once per market day after close, writes to Firestore. |
| Model version stamp | `netlify/functions/shared/model-version.ts` | New. Single string `MODEL_VERSION` constant bumped any time scoring logic changes. Stamped on every snapshot. |
| Firestore schema | docs in `FIRESTORE_RULES.md` | Update. New collections: `boardSnapshots/{date}/{board}/{ticker}`, `modelVersions/{version}` with full weight + threshold config. |
| Snapshot replay viewer | `src/views/HistoryView.jsx` | New. View any past day's board exactly as it was. Tab in nav. |
| Snapshot health check | `netlify/functions/health.ts` | Modify. Surface "last snapshot age" so a missed cron is visible. |
| Backfill from existing journal | `scripts/backfill-snapshots.ts` | New (one-shot). Reconstruct what we can from existing trade-log entries' `loggedAt` timestamps. |

**Dependencies.** Phase 0 (logging + observability needed to know when cron fails).

**Success criteria.**
- Every market day at 4:30 PM ET, a snapshot exists in Firestore.
- `MODEL_VERSION` is stamped on every snapshot.
- HistoryView lets user pick a date and see that day's target board exactly.
- Health endpoint shows snapshot age in hours.

**Estimate.** 1 session.

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

## Phase 5 — Calibration loop

**Goal.** Close the loop: backtest tells you which analysts have edge, which weights are wrong, which regimes invert signal. Use that to retune the production model.

**Why.** Right now the composite weights (15/8/13/10/10/7/7/14/6/10) are priors. After Phase 4, you have OOS alpha per analyst — that should drive the weights, not gut.

**Scope.**

| Workstream | Files | Action |
|---|---|---|
| Weight optimizer | `backtest/optimize-weights.ts` | New. Grid search over weight space (or Bayesian opt) maximizing OOS Sharpe. Hard cap weight changes per cycle to avoid overfit-to-recent. |
| Regime-conditional weights | `analyst-runner.ts` | Modify. Weights become a function of `Regime`, not a constant. Optimizer outputs one weight vector per regime (risk_on / neutral / risk_off). |
| Post-trade AI review | `netlify/functions/scheduled/post-trade-review.ts` | New. Daily scheduled function. For each closed trade ≥ 10 days old, call Opus with: original thesis (analyst contributions, top signals), actual price path, news that hit during the trade. Opus classifies: thesis-confirmed / thesis-invalidated-but-profitable / thesis-failed / externally-driven. Result stored on the trade entry. |
| Calibration dashboard | `src/views/CalibrationView.jsx` | New. Per-analyst hit rate, alpha, info ratio rolling 30/90/180 days. Chart of weight evolution over time. |
| Weight version control | `modelVersions/{version}` collection | Use existing from Phase 2. Every weight change is a new version with full diff. Boards record which version generated them. |

**Dependencies.** Phase 4 (backtest must work first).

**Success criteria.**
- Running the optimizer outputs a new weight vector that beats current weights OOS by ≥ 10% in Sharpe on a held-out window.
- Regime-conditional weights show meaningfully different vectors across regimes (sanity check that the regime layer matters).
- Post-trade review has classified ≥ 50 closed trades.
- Calibration view shows that, e.g., political-analyst is currently 0.72 hit rate over 90 days.

**Estimate.** 2 sessions.

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
| 0 | Engineering foundation + safety nets | pending | — | — | — |
| 1 | Refactor foundation (schemas + monolith split + TanStack Query) | pending | — | — | — |
| 2 | Snapshot infrastructure | pending | — | — | — |
| 3 | Point-in-time data layer | pending | — | — | — |
| 4 | Real backtest v2 | pending | — | — | — |
| 5 | Calibration loop | pending | — | — | — |
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
| Phase 1 | 2 |
| Phase 2 | 1 |
| Phase 3 | 1–2 |
| Phase 4 | 2–3 |
| Phase 5 | 2 |
| Phase 6 | 1–2 |
| Phase 7 | 1–2 |
| Phase 8 | 1–2 |
| Phase 9 | 1–2 |
| Phase 10 | 2 |
| Phase 11 | 2 |
| Phase 12 | 1 |
| Phase 13 | 1–2 |
| Phase 14 | 1 |
| **Total** | **20–28 sessions** |

At a session a week, this is ~5–7 months of evening/weekend work. At a couple sessions a week, ~3 months. The dependency chain means Phases 0–4 are mostly sequential; after that several phases parallelize (e.g., 6 and 7 are independent; 10 and 11 are independent).

---

## Highest-leverage path if time gets compressed

If you only have time for the top three: **Phase 0, Phase 2, Phase 4.** That gets you tests + CI + spend cap + Sentry, daily snapshots, and a real backtest. Everything else compounds off those.

Worst path: skipping Phase 0 to chase features. Cache poisoning recurs, Anthropic spend gets weird, a bad commit silently breaks prod. Done that movie three times already.
