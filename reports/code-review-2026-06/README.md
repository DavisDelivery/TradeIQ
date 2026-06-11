# Full-System Code Review — June 2026

Scope: every subsystem — analyst/scoring layer, Prophet sieve + snapshot
pipeline, backtest engine, frontend, infrastructure/data providers.
Baseline at review time: **all 1,197 tests pass, `tsc --noEmit` clean** —
every defect below lives in logic the test suite does not (or wrongly) covers.

Verdict up front: the architecture is genuinely good (snapshot-first design,
checkpoint/resume, PIT plumbing, no-data rescaling, centralized query keys),
but **the numbers the system produces cannot currently be trusted**: the
portfolio backtest verdict is built on look-ahead data, the "survivorship-
corrected" engine only scores 2026 survivors, the earnings board windows on
fiscal period-ends instead of report dates, and the flagship technical trend
signal is sign-inverted.

Severity counts: **12 critical, ~35 major, ~60 minor.**

---

## 1. Critical findings

### Data integrity / algorithm correctness

| # | Finding | Where |
|---|---------|-------|
| CR-1 | **Portfolio backtest look-ahead**: `rankAtDate` falls back to the LIVE snapshot for any historical date without a stored snapshot — i.e. nearly all of 2018–2025. Every rolling-window "beat SPY" result feeding `portfolio-verdict`'s SHIP gate is void (today's winners bought in 2018 = look-ahead + survivorship at once). A unit test (`signal.test.ts:179`) pins this as *correct*. | `shared/prophet-portfolio/signal.ts:108-110` |
| CR-2 | **Survivorship bias in the regular engine**: all four PIT scorers gate on `UNIVERSE` (the current 2026 seed). Measured: 138/509 of the 2018-01-31 S&P snapshot, 836/2034 of the 2022 Russell snapshot silently return null — disproportionately delisted/acquired names (DWDP, BBBY, ATVI…). Runs are stamped `survivorshipCorrected: true`. | `shared/backtest/score-at-date.ts:177,329,415,529` |
| CR-3 | **Earnings board windows on fiscal period-end, not report date**: `getEarningsHistory` maps `date: r.period` (quarter END, lags the print by 2–8 weeks). All "earnings reaction" metrics (priorMoves, moveRatio, historicalEdge, PEAD/reversal classification) measure random 2-day moves ~a month from the actual print. Same root cause leaks future data into PIT reads (`r.date <= asOfDate` filters on period, not announcement). | `shared/scan-earnings.ts:208-220`, `shared/data-provider.ts:873,879-882`, `shared/earnings-intel.ts:128-135` |
| CR-4 | **Technical trend term sign-inverted**: `ema()` falls back to `xs.at(-1)` when bars < period; the 220-calendar-day fetch yields ~150 bars, so `ema200 == latest close` always. `ema50 > ema200` becomes `ema50 > price` → +10 when price is BELOW its 50-EMA, −10 when above, on every ticker in every target scan. | `analysts/technical.ts:14,30-31,67-73` |
| CR-5 | **Live MTM corrupted by splits, blind to dividends**: positions persist fixed `shares` but marks use split-adjusted closes — a 2:1 split reads as −50% equity and the corrupted state is re-persisted. Dividends never credited (portfolio and SPY both price-only). | `scan-prophet-portfolio-mtm.ts:57-66` |
| CR-6 | **Regime weight overrides not renormalized**: risk-on weights sum to 0.93, risk-off to 0.83 → max composite in risk-off is 83; HIGH conviction (≥80) nearly unreachable; composites incomparable across regimes, poisoning decision-log training data and any cross-regime backtest. | `shared/prophet-layers.ts:935-944` |

### Platform / wiring

| # | Finding | Where |
|---|---------|-------|
| CR-7 | **Prophet crons run 10–14-min scan bodies inside synchronous scheduled functions** (~26s platform kill). The repo knows the limit (insider/target use thin-cron→background workers; `scan-prophet-largecap-trigger.ts` says so verbatim) yet all three Prophet crons scan in-handler. PRs #67/#72 ("widen freshness", "serve stale") look like compensating controls for producers that never complete. **Verify against production logs** (`prophet_snapshot_written` from cron invocations). | `scan-prophet-largecap.ts:29`, `scan-prophet-russell.ts:26`, `scan-prophet-all.ts:26` |
| CR-8 | **`scan-prophet-russell`/`-all` promote partial/truncated scans as canonical `_latest`** — no `status` stamping, publish guard (`assessSnapshotPublish`) never invoked on any Prophet path. Violates the PR-H "never overwrite a good snapshot" rule that largecap honors. | `scan-prophet-all.ts:56-64`, `scan-prophet-russell.ts:56-86`, `snapshot-store.ts:380` |
| CR-9 | **`seed-scan-background` is unauthenticated**: anyone can trigger 15-min full-universe scans (4 providers × ~2,037 tickers) and overwrite production `_latest` snapshots. `universe` param cast unchecked. Contrast the token gate on `scan-prophet-largecap-trigger.ts:101`. | `seed-scan-background.ts:77-99` |

### Frontend crashes

| # | Finding | Where |
|---|---------|-------|
| CR-10 | **CatalystView crashes on data load**: `onClick={load}` references a deleted identifier, evaluated during render of the data branch → ReferenceError → ErrorBoundary on every load. | `src/CatalystView.jsx:76` |
| CR-11 | **Earnings "+ Log Trade" is dead**: calls `logTrade(...)` but only `readLog` is imported — uncaught ReferenceError in the handler, fails silently for the user. | `src/EarningsView.jsx:7,242` |
| CR-12 | **History view crashes on Prophet replay**: code does `ls.filter(...)` on `layers`, which Prophet snapshots store as an OBJECT keyed by layer name. | `src/HistoryView.jsx:328-332` |

---

## 2. Major findings (selected; full lists in section 6 track reports)

**Scoring/algorithms**
- Shorts surface their *weakest* evidence: aligned contributions sorted descending for direction `short` (`analyst-runner.ts:211-215,384-389`).
- Earnings vol-play classification is an artifact of days-until-event (calendar/trading-day annualization mix; `expectedMove` over the waiting period vs 2-day event moves); "IV rich" emitted with zero options data (`scan-earnings.ts:196-298`).
- 'reversal' play hardcodes SHORT triggers; gap-down-on-beat (a long fade) gets inverted trade instructions (`scan-earnings.ts:266-269,503-511`).
- 2 of 7 technical setups (`multi_tf_aligned`, `oversold_bounce`) can never fire — require 200 bars, scans fetch ~150 (`technical-setups.ts:79,119-161`).
- Lynch PEG uses uncapped single-quarter YoY EPS growth → base-effect rebounds get PEG≈0 and fair P/E up to 300 (`styles/lynch.ts:63`).
- Provider transport failures return the `empty` activity object → scored as genuine neutral data; the no-data rescale machinery is dead for insider/political/govcontracts (`insider-provider.ts:157` etc.).
- Imminent earnings encoded as a bearish directional vote (raw −30) — event risk masquerading as direction, inflating conflictLevel (`analysts/core.ts:138-168`).
- macro-regime computed and piped on every scan, then multiplied by weight 0 (`scan-target.ts:166`, `analyst-runner.ts:80`).

**Backtest**
- PIT cache permanently stores truncated future-window bar fetches (no TTL "because PIT is immutable") → forward 60d/252d returns permanently null for affected keys (`engine.ts:546-550`, `pit-cache.ts`).
- Delisted tickers exit at last stale close; bankruptcies read as flat holds (`engine.ts:489`, `backtest-harness.ts:157,230`).
- Portfolio harness marks equity on CALENDAR days but annualizes with √252 → Sharpe ~17% off (`run-portfolio-backtest-background.ts:106-118`).
- A rebalance date absent from markDates disables ALL later rebalances (strict `===` + never-advancing index) (`backtest-harness.ts:199`).
- Signal and fill on the same close (look-ahead, both engines; `backtest-harness.ts:201-231`).
- Duplicate tickers in `UNIVERSE_HISTORY` (e.g. `"ADRO","ADRO"`) double position weight.
- No single-flight on the portfolio path → cron fires duplicate concurrent runs of slow windows.

**Snapshot/freshness**
- `prophet-picks.ts:102-121` contradicts the #72 rule: stale largecap still live-scans 508 names in an 18s budget (every weekend); stale russell/all returns "no scheduled scan exists" — factually false — while discarding the stale snapshot it just read.
- Fixed 26h freshness can't model the scan calendar: Friday→Monday is ~74h, so weekends are stale-by-construction; should be schedule-aware (last expected scan slot, holiday-adjusted).
- `snapshotBeforeDate` (PIT reads, backtest signal) reads `runs/` with no status filter → ranks from the partial junk promotion excluded (`snapshot-store.ts:630-651`).
- `_latest` promotion race: blind transaction set lets an older-but-slower scan overwrite a newer snapshot (`snapshot-store.ts:389-406`).
- Forward-return populator starves permanently once 200 unresolvable rows accumulate at the head of the oldest-first query (`scan-prophet-portfolio-fwd-returns.ts:84-129`).
- #69's `universeChecked = entries.length` unconditionally — reports universe size as coverage even when stage 1 scored 60% (`prophet-sieve/index.ts:147`).

**Infrastructure**
- ~~`scan-status.ts:99` / `scan-resume/finalize.ts:144`: degenerate Firestore prefix-range queries~~ — **RETRACTED (Wave-1 verification, 2026-06-11)**: byte-level inspection shows both sites already append the invisible `U+F8FF` sentinel (`ef a3 bf`) to the prefix, not an empty string. Both queries are the canonical descending prefix-scan form and are correct as written; the review agents misread the invisible character. No fix needed, and the test mocks' `startsWith` semantics match the (correct) production behavior.
- Anthropic budget priced 3× actual ($15/$75 vs real $5/$25 per MTok) → the $25/day cap halts AI features at ~$8.33 real spend; test asserts the wrong constants. Also racy read-modify-write on Blobs, model-blind pricing.
- `research.ts` / `chart-analysis.ts`: unauthenticated, unrate-limited LLM endpoints with trivially bypassable caches — anonymous traffic can burn the entire (already 3×-undersized) daily AI budget.
- `analysts-status.ts` drifted from `analyst-runner.ts`: reports removed analysts (macro 0.07, patent 0.06) as live, totalWeight 1.00 vs real 0.87.
- `prophet-narrate` POST persists fully client-controlled composite/layer data into the shared Firestore thesis cache keyed (ticker, snapshotDate) — poisonable for all users.

**Frontend**
- react-query keys omit server-side filter params: `catalyst(universe)` misses `filter`+`minConviction` (filter buttons are no-ops within staleTime; AlertsView cross-pollutes the cache with low-conviction rows); `insider(universe)` misses `windowDays` (window selector silently shows the old window's data).
- Gross/operating margin unit bug: backend passes FRACTIONS (0.44) through `stock-detail.ts:234-239` while netMargin/roe on adjacent lines are ×100; UI formats all with pct1 → "0.4%", and the sector-median favorability dot compares 0.44 vs 55 (permanently "unfavorable"). Test fixture uses 44 (percent) — codifies the wrong side.
- Regime enum mismatch: backend emits `low|medium|high` vol-regime; UI checks `extreme|elevated` → VIX status dot always green, premium-multiplier branch dead (`RegimeView.jsx:41,119`).
- History replay columns read fields snapshots never contain (`r.score`/`r.side` vs `composite`/`direction`, `buyCount` vs `buyerCount`, …) → em-dash wallpaper on most boards.
- `useStockDetailsFanout` always-enabled for every visible row → 50 parallel `/api/stock-detail` calls (each fanning to ~10 providers) on board load, defeating the IntersectionObserver lazy-fetch economy it sits next to.
- `RegimeView` "VIX" sparkline is `Math.random()` data regenerated per render; App.jsx silently falls back to MOCK_REGIME/MOCK_ANALYSTS presented as live.

---

## 3. Cross-cutting failure patterns (the systemic stuff)

1. **Tests that encode intent, not reality.** Three confirmed instances
   (two retracted — see Infrastructure note above): the budget test asserts
   the wrong pricing constants; the KeyMetricsPanel fixture uses percent
   margins the handler never produces; `signal.test.ts` pins the look-ahead
   fallback as desired. **Rule to adopt: integration-shaped mocks must
   mimic the platform's actual semantics, and fixtures must be derived from
   captured real responses.**
2. **Calendar vs trading days.** 220-calendar-day fetches feeding 200-bar
   indicators (CR-4, dead setups); √252 annualization over calendar-day
   series; `expectedMove` mixing √252 with calendar scaling; "daysSince"
   drift windows in calendar days against trading-day claims.
3. **Period-end vs announcement date.** One provider-level mapping
   (`date: r.period`) poisons the earnings board live AND leaks future data
   into PIT backtests.
4. **Silent fallbacks instead of explicit absence.** `ema()` → last value;
   provider error → `empty` activity; `rankAtDate` → live snapshot;
   delisted price → last close; UI → MOCK_REGIME. Every one converts a
   detectable failure into a plausible-looking wrong number. Adopt
   null/status envelopes everywhere (the codebase already has the
   discipline — `_noData`, `_degraded` — it's just bypassed).
5. **Per-board patches instead of shared mechanisms.** Freshness constants
   widened (#67, #70) and live-scan suppressed (#72) board-by-board while
   the producers (CR-7) stayed broken; publish discipline exists only on
   the largecap path; thin-cron→background-worker exists but only insider/
   target use it; two holiday calendars; two earnings-quality gates
   (sieve copy vs prophet-layers).
6. **Auth asymmetry.** One trigger endpoint got a token gate; the more
   powerful seeder, narrate-POST, research, and chart-analysis did not.

---

## 4. "How I'd do it better" — algorithm redesign notes

- **Weights with a validation loop.** `composeTarget`'s structure (signed
  confidence-weighted deviation, conflict dampening, tier caps) is sound,
  but weights are hand-asserted and confidence scales are per-analyst and
  unnormalized. Z-score each analyst's raw signal cross-sectionally per
  scan, then fit/shrink weights against the W1-audit forward-return
  observations instead of asserting them. Same for Prophet layer step
  functions: cross-sectional ranks (as Stage 1 already does) beat absolute
  hand-tuned thresholds, and regime overrides must be normalized vectors.
- **Earnings**: source announcement dates (Finnhub calendar has them),
  compare event-window realized moves to an event-horizon expected move
  (rv20/√252 × √2), use real IV from the Polygon options snapshot already
  used by institutional-flow, and make reversal triggers direction-aware.
- **Lynch**: PEG from TTM-vs-prior-TTM (both already computed) or
  multi-year CAGR, clamped to ~10–40%; consistency from TTM EPS slope/
  variance, not 4 quarters of beat-the-game; wire in the real insider
  provider the repo already has.
- **Williams**: require 2-day %R turn confirmation (single-day −70→−50 is
  noise); publish tomorrow's breakout trigger LEVEL instead of a stale
  fired flag from a nightly scan.
- **Insider**: scale dollar thresholds by market cap; weight by buyer role
  (EDGAR enrichment exists); fix cluster windowing.
- **Political**: amount-weighted net flow instead of trade counts; apply
  the 45-day disclosure lag on the LIVE path too, not just backtests.
- **Portfolio accounting**: stop persisting share counts against an
  adjusted price feed — chain daily position returns from adjusted closes
  with explicit corporate-action events; fills at D+1 open; markDates from
  the trading calendar; include dividends or label everything price-only.
- **Backtest PIT**: resolve names/sectors from a PIT reference (or the
  universe-history snapshot itself), never the live `UNIVERSE`; refuse (not
  silently fallback) portfolio windows predating the first stored snapshot;
  forced liquidation on N missing bars.
- **Freshness**: make it schedule-aware — fresh ⇔ generatedAt ≥ last
  expected successful scan slot (weekend/holiday-adjusted via the single
  consolidated calendar) — plus an alert on snapshot age per board+universe,
  instead of ever-wider constants.

## 5. Recommended fix order

1. **Stop trusting the numbers**: CR-1, CR-2 (+M: delisting holds, PIT
   cache poisoning) — then re-run every stored baseline; all existing
   backtestRuns/portfolioBacktests/mlTraining rows predate these.
2. **Producers**: CR-7 (thin-cron→background for all three Prophet crons,
   confirm against prod logs first), CR-8 (status stamping + publish guard),
   promotion race, snapshotBeforeDate status filter.
3. **Live correctness**: CR-3, CR-4, CR-5, CR-6; budget repricing (decide:
   keep effective or nominal ceiling). (The "two degenerate Firestore
   queries" originally listed here were retracted — see section 2.)
4. **Security**: token-gate seed-scan-background (+narrate POST validation),
   shared per-IP limiter for research/chart-analysis.
5. **Frontend**: the three crashes (one-line fixes), the two query-key
   omissions, margin units (fix handler, re-derive fixtures from a real
   capture), regime enums, history replay field names.
6. **Test debt**: render-with-data smoke tests for CatalystView/
   EarningsView; realistic Firestore-semantics mocks; fixture-from-capture
   policy; coverage for runTechnical, scoreSetups, scan-earnings
   classification, prophet-picks freshness branches, per-board budget
   override (#71 — currently zero coverage).

## 6. Full track reports

The five detailed track reports (every minor finding, file:line, test
assessment per subsystem) are preserved in this directory:

- `track-1-analyst-scoring.md`
- `track-2-prophet-pipeline.md`
- `track-3-backtest-engine.md`
- `track-4-frontend.md`
- `track-5-infrastructure.md`
