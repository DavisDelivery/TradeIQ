# TradeIQ — Orchestrator

**Purpose.** Sequence every fix and capability gap into a phased build plan. One doc, persistent in repo, updated each session. Each phase ships as a versioned PR and updates the Status table.

**Current state (2026-05-12).** Production at `v0.15.0-alpha` on `https://tradeiq-alpha.netlify.app`. Phases 0 → 4b-2 shipped including all four Phase 4a hotfixes. Three briefs sitting on the runway awaiting agent execution: `phase-4c-1-brief.md`, `phase-4c-2-brief.md`, `phase-5a-brief.md`. Two security items outstanding (PAT + FB SA key rotations).

---

## If you're a new conversation, read this first

1. **The Status table is the source of truth.** Find the next `pending` phase.
2. **If a brief exists** (`briefs/phase-N-*.md`), the brief is the spec. This doc is the index.
3. **Verify dependencies are `done`** before starting. Don't skip.
4. **Set up the working tree:**
   ```bash
   cd /home/claude
   [ -d tradeiq ] || git clone https://<write-PAT>@github.com/DavisDelivery/TradeIQ.git tradeiq
   cd tradeiq && git pull --rebase
   ```
5. **Build, test, smoke-test on deploy preview, commit, push, open PR.** Smoke-test is non-negotiable — Lessons #7+#8.
6. **Update the Status table** with version + date + summary. Bump `APP_VERSION` if any user-visible change.

---

## Standing rules

- ALWAYS bump `APP_VERSION` in `src/App.jsx` on any user-visible change.
- Every data table column is sortable via `useSortable` + `SortableTh`. No exceptions.
- Critical data ingest preserves four layers: original bytes (gzipped), `{source}_rows_raw`, parsed/normalized rows, aggregations. Never drop fields.
- Brand blue `#1e5b92` is Davis Delivery only — TradeIQ uses its own neutral dark palette.
- Each phase ships its own `vX.Y.Z-alpha` bump. No combining unrelated phases.
- Every phase that touches scoring/alpha logic must add a regression test before merge.
- Briefs never contain literal secrets. Use `<read-only-PAT, provided per session>` placeholders.
- Smoke-test every new HTTP route on the deploy preview BEFORE merging. Unit tests can't catch Netlify routing quirks.
- Every phase ends by updating the Status table.

---

## Stack reference

| | |
|---|---|
| Repo | `DavisDelivery/TradeIQ` |
| Production | `https://tradeiq-alpha.netlify.app` |
| Netlify site ID | `8e90d525-78f3-4288-9c15-8b1968e994c1` |
| Netlify team | `chad@davisdelivery.com` |
| Firebase project | `tradeiq-alpha` |
| Read-only `GITHUB_PAT` | `<provided per session>` (write-scoped separately when needed) |
| `FIREBASE_SERVICE_ACCOUNT` | JSON in Netlify env across all contexts |
| Other secrets | `ANTHROPIC_API_KEY`, `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `QUIVER_API_KEY`, `FRED_API_KEY` — all in Netlify env |
| Frontend | React + Vite + TanStack Query + Recharts + Tailwind, mobile-first neutral dark |
| Backend | Netlify Functions (TypeScript) + Firestore via firebase-admin + Zod at every external boundary |

### Firestore schema
- `boardSnapshots/{board}/{universe}/{snapshotId}` — scan results, model version stamped
- `backtestRuns/{runId}` + subcollections `dailyEquity / trades / attribution / mlTraining`
- `pitCache/{key}` — point-in-time data cache
- `tradeLog/{tradeId}` — user-logged trades

### Boards (7) × universes (4)
Boards: target, prophet, catalyst, williams, lynch, insider, earnings.
Universes: `dow` (30), `sp500` (~500), `ndx` (~100), `russell2k` (~2037).
Russell2k is large enough to require sieve architecture for prophet — see 4c-2.

### Code-path landmarks
- Backtest engine: `netlify/functions/shared/backtest/{engine,walk-forward,costs,metrics,attribution,persistence,types}.ts`
- Backtest UI: `src/BacktestView.jsx` + `src/components/{BacktestLauncher,SurvivorshipBanner,RunMetricsTiles,EquityCurveChart,DrawdownChart,AttributionChart,RegimeBreakdownTable,TopTradesTable,KpiCard,ChartPanel}.jsx`
- Backtest hooks: `src/hooks/{useBacktestRuns,useBacktestRun,useStartBacktest}.js`
- Background functions: `*-background.ts` filename suffix → 15-min container even via HTTP (`run-backtest-background.ts`, `seed-scan-background.ts`)
- Scheduled scans: `netlify/functions/scan-{board}-{universe}.ts` — 23 per-universe files post-4a-fix-4 (earnings monolithic by design)
- Snapshot store: `netlify/functions/shared/snapshot-store.ts`
- PIT layer: `netlify/functions/shared/{data-provider,insider-provider,political-provider,patent-provider,govcontracts-provider,universe-history,pit-cache}.ts`
- Zod schemas: `netlify/functions/shared/schemas/{polygon,finnhub,quiver,fred,index}.ts`
- Frontend prophet: `src/ProphetView.jsx` (LAYER_META + 7-layer panel rendering)

---

## Operational state

### Production
- Live at `0.16.0-alpha` after 4c-2 merge. MODEL_VERSION `2026.02.0` (composite weights + new fundamental signals changed scoring; historical snapshots remain on `2026.01.0` and backtest replay filters by version). Russell scan now uses the 3-stage sieve and scores every ticker at Stage 1 — the pre-4c-2 "scans 50 then quits" issue is fixed. Largecap + all universes still single-pass; they don't need a sieve at their universe sizes.
- All 7 boards return data. Snapshots written by post-4a-fix-4 scheduled scans; scans pre-narrate qualified picks before snapshot write (4c-1). Live endpoints serve snapshot-first with `fallback-partial` outside cron windows.

### Open PRs awaiting merge
None. Hotfix queue cleared.

### Briefs awaiting agent execution
- **`briefs/phase-4e-1-brief.md`** — Prophet Portfolio engine + backtest validation (4e split). Target `0.17.0-alpha` or `0.16.1-alpha` depending on verdict.
- **`briefs/phase-5a-brief.md`** — ML training discovery. Polyglot (Python). Output is a report, not a deploy.
- **Phase 4f — Stub-analyst audit + repair** (no brief yet). Surfaced 2026-05-13: 5 of 10 Target Board contributors (44% weight) were stub-returning 50 on a sample ticker. Same risk exists for Prophet's 7 layers. Diagnostic + repair phase; produces an audit report, traces each stub to root cause, repairs or removes from composite.

Recommended order: 4e-1 and 5a in parallel (zero file overlap; kickoffs in `kickoffs/`). 4f after — its findings will likely retroactively improve both 4e-1's backtest verdict and 5a's training data.

### Outstanding remediation (your hands)
- 🚨 **Rotate the Firebase SA key.** `private_key_id: c52711f114...` on `firebase-adminsdk-fbsvc@tradeiq-alpha.iam.gserviceaccount.com`. Google Cloud Console → IAM → Service accounts → Keys → generate new + delete old → paste new JSON into Netlify env var `FIREBASE_SERVICE_ACCOUNT`. ~5 min from phone. Longest-standing item.
- 🚨 **Rotate the read-only GitHub PAT.** Literal `ghp_sgXH…` appears in 17 brief files in git history. Once rotated, the leaked string is dead and the briefs-sweep PR becomes cosmetic.
- **Briefs sweep PR** (cosmetic, post-rotation). Mechanical `s/ghp_…/<read-only-PAT, provided per session>/g` across 17 briefs + CONTRIBUTING note. Defer.
- **Health endpoint hardcoded `version: 0.10.0-alpha`.** Cosmetic but wrong in prod. Sync next time `netlify/functions/health.ts` is touched.
- **Param-name normalization.** `?index=` vs `?universe=` inconsistent across 7 boards. Frontend hooks already route per-board correctly. Small PR when convenient.

### Phase 0 leftovers (acknowledged-skipped)
- **Anthropic budget cap** — explicitly dropped by user decision 2026-05-12. Phases that increase API spend (4c-1 W4 narrate-all, future ML inference) ship without a cap. Surface a warning log if spend looks anomalous; don't refuse.

### Known second-tier issues (non-blocking, file when ready)
1. **Composite scores cluster at 50** on early picks. `layers.fundamental: 0` consistently for NKE/V/CVX. Phase 4c-1 W5 starts the diagnostic; Phase 5a may surface root cause.
2. **`recovery_days: null`** on runs where equity curve clearly recovers intermediate drawdowns. Metrics bug.
3. **Quiver lobbying schema noise.** ~2,300 `schema_mismatch` warns per full Dow scan. Warn-and-continue works.
4. **Quiver patents endpoint 403/404s.** 55 hits per full scan.
5. **`marketCapBucket: null` on every ML training row.** `FundamentalsSnapshot` doesn't expose `marketCap`. Phase 11 fit.

---

## Status (source of truth)

`pending` → `in-progress` → `done` (with version + date). One row per phase.

| # | Phase | Status | Version | Date | Notes |
|---|---|---|---|---|---|
| 0 | Engineering foundation + safety nets | done (partial) | 0.10.0-alpha | 2026-05-08 | Tests + CI + circuit breaker + structured logger + Sentry + weekly Firestore backups. Budget cap DROPPED by decision 2026-05-12. |
| 1 | Universe coverage + snapshot infrastructure | done | 0.9.1-alpha | 2026-05-07 | All 7 boards snapshot-first; FreshnessPill on all views; HistoryView replay. Scheduled-scan layout bug fixed later in 4a-fix-4. |
| 2 | Refactor foundation (schemas + monolith split + TanStack Query) | done | 0.11.0-alpha | 2026-05-08 | Zod at 5 provider boundaries; App.jsx 2965→331 lines; 16 hooks; all 13 views wired. |
| 3 | Point-in-time data layer | done | 0.12.0-alpha | 2026-05-10 | All 5 providers as-of capable; Dow universe history full 2018-2026 monthly; sp500/ndx/russell seed only with runbook. |
| 4a | Real backtest v2 — engine + correctness | done | 0.13.0-alpha | 2026-05-11 | Walk-forward + PIT cache + portfolio/costs + attribution + ML hook data. 4 hotfixes followed. |
| 4a-fix-1 | Cache undef-rejection + silent catch (PR #8) | done | 0.13.1-alpha | 2026-05-11 | `ignoreUndefinedProperties: true` + structured TickerFailure + happy-path test. Post-fix Sharpe 0.224. |
| 4a-fix-2 | ML-row bar window (PR #9) | done | 0.13.3-alpha | 2026-05-11 | New `getCachedBars(ticker, from, to)` with explicit window. Post-fix IC=-0.0951 (honest signal). |
| 4a-fix-3 | ProphetDetail useEffect import (PR #10) | done | 0.13.2-alpha | 2026-05-11 | One-line fix + sibling audit. |
| 4a-fix-4 | Scheduled function deployment (PRs #12/#13/#14) | done | 0.13.4-alpha | 2026-05-11 | Moved 7 scans flat + per-universe split (23 total) + `seed-scan-background.ts` helper. Scheduled scans now actually run. |
| 4b-1 | Backtest run viewer UI | done | 0.14.0-alpha | 2026-05-12 | Two endpoints, two hooks, BacktestView rewritten, 7 detail subcomponents, mobile-first 375px. 331 tests. |
| 4b-2 | Backtest run launcher | done | 0.15.0-alpha | 2026-05-12 | Background-function pattern via `-background.ts` suffix. PRs #17 + #18 (routing hotfix to `/api/backtest-runs/start`). 367 tests. |
| 4b-3 | Run cancellation + presets + saved templates | pending | — | — | No brief yet. Cancellation token + curated presets + user-saved templates + per-rebalance progress events. |
| 4c-1 | Prophet detail completeness + EPS bug | done | 0.15.1-alpha | 2026-05-13 | All 5 workstreams shipped: shared `narrative-cache` + `narrative-generator` extracted, on-demand `/api/prophet-narrate` endpoint with per-IP rate limit (30/hr), `useGenerateNarrative` mutation hook that patches every prophet cache entry, three-state AI Thesis UI placeholder, `narrateAll` in all three scheduled scanners with per-universe budget guards, and W5 EPS-beats fix: `earnings-intel.ts` now emits `beatsLast4: null` when Finnhub returns no surprise data (was emitting `0`, rendered as misleading "0/4 beats") plus new `beatsLast4Quarters` honest denominator. 397 tests (367 baseline + 30 new). |
| 4c-2 | Russell sieve architecture + earnings priority | done | 0.16.0-alpha | 2026-05-13 | Re-scoped from coverage-only to coverage+scoring per Chad's 2026-05-13 product direction (earnings-heavy Prophet). 3-stage sieve in `prophet-sieve/`: Stage 1 cheap bars-only filter scores every Russell ticker (~2037 → ~400), Stage 2 adds fundamentals + earnings intel + RS-vs-SPY + earnings-quality gate (~400 → ~80), Stage 3 runs existing 7-layer scan on survivors. New fundamental signals: multiple expansion (P/E vs 1y ago), YoY operating + gross margin trend in pp. `layerFundamental` reworked with new scoring bands + earnings-quality gate. Composite reweighted: fundamental 20→25%, catalyst 26→30% (earnings stack now 55% vs prior 46%). SieveCoverageStrip surfaces the `universe → s1 → s2 → final` ladder on Russell. New chips on the row strip: op margin trend, P/E expansion. MODEL_VERSION bumped to 2026.02.0. Tests 397 → 427 (+30 new). |
| 4e-1 | Prophet Portfolio — engine + backtest validation | done (engine dormant) | 0.16.1-alpha | 2026-05-13 | All W1–W4 + W6–W9 shipped; W5 (live scheduled rebalance) intentionally skipped because the binding verdict in `reports/phase-4e-1/backtest-validation.md` is **PENDING LIVE-DATA RUN** — executor session had no Polygon/Firebase credentials to populate § 0 layer audit and § 1–§ 5 backtest tables. Built: `prophet-portfolio/{types,state,signal,rebalance,backtest-harness,decision-log}.ts` + `scripts/run-portfolio-backtest.ts` CLI + `scan-prophet-portfolio-{mtm,fwd-returns}.ts` scheduled functions + `GET /api/prophet-portfolio` + report scaffolding. Rule v1 encoded literally per brief; rebalance pure function passes all 10 brief-spec test cases. RankingSignal interface in place as the 5b plug-in seam. Tests +59 (427 → 486 expected). Engine + endpoint land dormant; mtm + fwd-returns scheduled functions land harmless (no state until a live rebalance writes the first one). |
| 4e-1-finish | Backtest live-data run + verdict | pending | — | — | Run `npx tsx scripts/run-portfolio-backtest.ts` with `FIREBASE_SERVICE_ACCOUNT` + `POLYGON_API_KEY` set; populate `reports/phase-4e-1/backtest-validation.md` § 0–§ 5 with real numbers; flip verdict line to SHIP / SHIP WITH CAVEATS / DON'T SHIP; if SHIP → file follow-up to land `scan-prophet-portfolio-rebalance.ts` (W5 spec in brief) and bump APP_VERSION to `0.17.0-alpha`; if DON'T SHIP → propose v2 rule revision in `briefs/phase-4e-1-fix-brief.md`. |
| 4e-2 | Prophet Portfolio UI tab | pending (no brief yet) | — | — | Consumes `GET /api/prophet-portfolio`. Mobile-first ProphetPortfolioView with equity curve vs SPY/QQQ/IWF, holdings table, last-20-swap log, decisionLog drilldown. Blocked on 4e-1-finish flipping to SHIP/SHIP WITH CAVEATS so there's real state to render. |
| 4f | Stub-analyst audit + repair (Target + Prophet) | pending (no brief yet) | — | — | Surfaced 2026-05-13 from Chad's screenshot of the Target Board ON ticker: 5 of 10 analyst contributions (Insider 14%, Political 10%, Macro 7%, Earnings 7%, Patents 6% — total 44% weight) were returning exactly 50, the neutral midpoint. The same risk exists for Prophet's 7 layers and must be audited. Phase 4f produces a full report identifying which analysts/layers are stub-returning across both boards, traces root cause for each (no upstream data subscription? null upstream that defaults to 50? handler bug?), then either repairs the analyst or removes it from the weighted composite with proportional reweight of the live ones. Phase 4e-1's W0 includes a Prophet-side stub audit as a precondition, but does NOT fix anything — that's 4f. |
| 5a | ML training pipeline (discovery) | pending (brief ready) | — | — | `briefs/phase-5a-brief.md`. Purged walk-forward CV + embargo; cross-sectional rank-IC vs composite; Bonferroni-corrected Wilcoxon; 5 models + Model 0. No frontend, no version bump. Output: `reports/phase-5a/findings.md`. |
| 5b | Production rollout of winning model | pending | — | — | Blocked on 5a Path A. Decides Python→TS deployment: TS re-impl, ONNX, or separate Python service. |
| 5c | Monitoring + retraining cadence | pending | — | — | Blocked on 5b. Weekly retrain; auto-disable if IC < composite; calibration dashboard. |
| 6 | Real options data | pending | — | — | OPRA chain; IV percentile/rank/skew; strike picker; rewrites `options-flow.ts`. |
| 7 | Portfolio layer | pending | — | — | Correlation matrix; sector caps; factor exposure; gross/net by regime; beta-adjusted sizing; VaR. |
| 8 | Position sizing engine | pending | — | — | Three modes (equal, vol-target, fractional Kelly); per-setup sizing; rebalancer. |
| 9 | Exit / trade management | pending | — | — | Trade state machine; trailing stops; scale-out; news triggers; correlation-break; time exits; open-positions view. |
| 10 | Missing data classes | pending | — | — | Short interest + borrow rate + dark pool + block trade + breadth + sentiment + credit spread. |
| 11 | Analyst depth | pending | — | — | Lynch depth; Fundamental depth; dedicated short-side; earnings interpreter; arbitrator; Claude-as-PM. |
| 12 | Auth + DR | pending | — | — | Firebase Auth + per-user Firestore rules + ownerUid migration + restore drill. |
| 13 | Scale + caching + staging | pending | — | — | Shared cache (Netlify Blobs); edge rate limiting; staging env; bundle splitting; PWA. |
| 14 | Audit trail + compliance hooks | pending | — | — | recommendationLog; per-card model version stamp; export CSV; inputs hash. |

---

## Lessons learned (the gotchas)

1. **`undefined` in Firestore writes throws.** Set `ignoreUndefinedProperties: true` once in `firebase-admin.ts`. Engine-level silent catches mask the problem ruinously (4a-fix-1).
2. **Bar-window math.** When fetching forward-return bars, window must START at or before rebalance date, not after. Use explicit `getCachedBars(ticker, from, to)` (4a-fix-2).
3. **React hook imports.** Every view that uses a hook must import it. Line-1 React destructure is the SPOF. Cross-view audit when fixing one (4a-fix-3).
4. **Netlify scheduled functions in subdirectories don't deploy.** Files in `netlify/functions/scheduled/*.ts` silently dropped by bundler. Keep scan functions flat at `netlify/functions/scan-*.ts` (4a-fix-4).
5. **Per-universe scan splitting.** A single 4-universe scan can't fit Netlify's 15-min cap. Split into per-(board,universe) functions; earnings excepted (4a-fix-4 PR #13).
6. **The `-background.ts` filename suffix unlocks 15-min container even via HTTP.** Standard pattern for any work that exceeds the 211s gateway timeout.
7. **Netlify method-conditioned redirects are silently dropped.** `conditions = { method = ["POST"] }` doesn't work — bundler treats the rule as malformed and silently ignores the condition; unconditioned fallback wins. Use distinct literal paths for method-specific routing (4b-2 PR #18).
8. **Smoke-test every new HTTP route on deploy preview before merging.** Unit tests can't catch Netlify's redirect-layer quirks. The 4b-2 routing bug shipped to prod for 5 min before catch (4b-2 PR #18).
9. **Briefs go in `briefs/` and never contain literal secrets.** Use placeholders. `SECRETS_SCAN_OMIT_PATHS = "briefs/*"` already in `netlify.toml` as belt-and-suspenders; real fix is rotation + placeholders.
10. **Composite scores cluster at 50.** Post-sigmoid normalization compression. Phase 4c-1 W5 + Phase 5a explore this. Real artifact; ML on raw layer scores (pre-sigmoid) may extract information the composite squashed.

---

## Cross-cutting concerns

- **Polygon / Finnhub / Quiver / FRED quota tracking.** Alert before hitting walls. (Anthropic spend cap dropped by decision.)
- **Test coverage drift.** Coverage report on every PR. Gate at 50% for `shared/`; aspire to 80% on scoring math.
- **Documentation drift.** This doc + `SPEC.md` kept honest. Each phase's PR updates both.
- **Briefs hygiene.** Never inline literal secrets. Omit-paths env var is a backstop, not the fix.

---

## What's already powering current work

- **`backtestRuns/{runId}/mlTraining`** — training dataset for 5a. Per-row: `composite`, per-layer scores, `regime`, `sector`, `forward{5,20,60,252}dReturn`, `entryPrice`, `inPortfolio`. `marketCapBucket` deferred to Phase 11.
- **`scan-{board}-{universe}.ts`** — 23 scheduled functions on Netlify cron. After 4a-fix-4, these actually fire. Each writes to `boardSnapshots/{board}/{universe}/{snapshotId}`.
- **`seed-scan-background.ts`** — HTTP-invokable fire-and-forget seeder. Manually trigger a single board+universe scan without waiting for cron.
- **`run-backtest-background.ts`** — invoked by `POST /api/backtest-runs/start`. Wraps `runBacktest()` with `-background.ts` suffix for 15-min container.
- **`BACKTEST_LIMITATIONS.md`** — required disclosure for SP500/NDX backtests (uncorrected universes). `SurvivorshipBanner` renders on every uncorrected run + on launcher when sp500/ndx selected.

---

## Highest-leverage path forward

**Near-term (1–3 sessions).** Rotate the two keys. Hand off 4c-1 first — small, fixes a user-visible bug, surfaces EPS-beats diagnostic findings that may feed 5a. Then 4c-2 (russell sieve unlocks scoring quality on 2000-name universe). Then 5a (the answer to "does ML beat the composite" determines the next year's roadmap).

**Medium-term (3–10 sessions).** 5b deployment, then 4b-3 cancellation/templates, then Phase 6 (real options data), Phase 7 (portfolio), Phase 8 (sizing).

**Long-term.** Phases 9–14 mostly parallelize once 6/7/8 land. Phase 12 (auth) should land before any sharing or commercialization conversation. Phase 14 (audit trail) becomes mandatory if commercialization happens.

---

## Phase deep-dives (reference, read on demand)

### Phase 0 — Engineering foundation + safety nets

**Shipped @ 0.10.0-alpha (2026-05-08).** Tests, CI, circuit breaker, structured logger, Sentry hooks, weekly Firestore backups, dead-code purge. Anthropic spend cap was the one Phase 0 item DROPPED by user decision 2026-05-12.

Scope: `vitest.config.ts`, `.github/workflows/{ci,deploy,backup-firestore}.yml`, `netlify/functions/shared/{anthropic-budget,logger}.ts`, `src/lib/sentry.js`, `netlify/functions/__tests__/cache-poisoning.test.ts`, `netlify/functions/shared/__tests__/prophet-layers.test.ts`.

### Phase 1 — Universe coverage + snapshot infrastructure

**Shipped @ 0.9.1-alpha (2026-05-07).** Phase 1 landed before Phase 0 because the universe-coverage bug was more user-visible. All 7 boards snapshot-first end-to-end. FreshnessPill on every view. HistoryView replay surface. Backfill script for tradeLog reconstruction. Critical follow-on: scheduled scan functions had layout bug fixed in 4a-fix-4.

Scope: `netlify/functions/shared/{firebase-admin,snapshot-store,model-version}.ts`, `scan-{board}-{universe}.ts` (now 23 files post-4a-fix-4), all `*-board.ts` / `*-picks.ts` rewired snapshot-first, `src/components/FreshnessPill.jsx`, `src/HistoryView.jsx`, `scripts/backfill-tradelog.ts`.

### Phase 2 — Refactor foundation

**Shipped @ 0.11.0-alpha (2026-05-08).** Zod at 5 provider boundaries (10 fetch sites + 5 Quiver datasets). `App.jsx` 2965 → 331 lines. 16 hooks + provider wrap. All 13 views wired to hooks (zero remaining useState+useEffect+fetch patterns for server data). Bundle +12kB gzipped, under 820kB budget.

Scope: `schemas/{polygon,finnhub,quiver,fred,index}.ts`, `src/views/*.jsx`, `src/lib/{mockData,queryKeys}.js`, `src/hooks/use*.js` (16 files), TanStack Query in every view.

### Phase 3 — Point-in-time data layer

**Shipped @ 0.12.0-alpha (2026-05-10).** All 5 providers as-of capable. FRED `vintage_dates` (gold-standard PIT for macro). Polygon fundamentals/news. Finnhub recommendations (hybrid: live filter + snapshot fallback). Quiver political/patents/contracts. Universe history covers Dow 2018-01-31..2026-04-30 monthly (full coverage); sp500/ndx/russell current seed only (Wikipedia/iShares hostname-blocked at egress; `docs/UNIVERSE_HISTORY_RUNBOOK.md` documents extension).

PIT audit at `docs/POINT_IN_TIME_AUDIT.md` enumerates every data class with workarounds for non-PIT vendors. 55 new PIT correctness tests.

### Phase 4 — Real backtest

**4a Engine + correctness (0.13.x-alpha, 2026-05-11).** Walk-forward engine with hot PIT cache (Firestore-backed). Portfolio + costs + slippage. Per-analyst attribution. ML hook data (forward 5d/20d/60d/252d returns persisted to `backtestRuns/{runId}/mlTraining/`). STOCK Act 45-day forward-shift. Walk-forward integrity tests (11 P0). Dow + Russell fully backtest-able with `corrected: true` survivorship stamp; SP500/NDX uncorrected with required disclosure. CLI script + 3 sample configs. `BACKTEST_LIMITATIONS.md`. **Prophet board only** — other boards return null and emit warning (5b territory). Four hotfixes followed — see Status table + Lessons #1-#5.

**4b Backtest UI.**
- **4b-1 viewer (0.14.0-alpha, 2026-05-12):** two endpoints (`/api/backtest-runs`, `/api/backtest-runs/:runId`), two hooks, BacktestView rewritten. Seven run-detail subcomponents including non-negotiable `SurvivorshipBanner` (renders when `corrected: false`, links to `BACKTEST_LIMITATIONS.md`). Mobile-first 375px. 331 tests.
- **4b-2 launcher (0.15.0-alpha, 2026-05-12):** UI launch via Netlify background function. `-background.ts` filename suffix gives 15-min container even via HTTP. Trigger endpoint `POST /api/backtest-runs/start` validates config, enforces prophet-only, runs single-flight check, writes `pending` record, fires-and-forgets. Background flips `pending → running` via new `persistRunRunning(runId)` helper. Frontend: `useStartBacktest` with annotated errors (409 deeplinks to existing run); `useBacktestRun` patched with `refetchInterval` 5s while in-flight. Bundle +3.5 kB. 367 tests. **Routing lesson (#7):** PR #17 used `conditions = { method = ["POST"] }`, Netlify silently dropped it. PR #18 moved trigger to distinct literal `/start` path.
- **4b-3 cancellation + presets + templates (pending, no brief).** Firestore-backed cancellation token; hand-curated presets; user-saved templates; granular progress signal requires engine to write per-rebalance events.

**4c Prophet board completeness (briefs ready, pending agent).** Response to user-reported PWR screenshot (2026-05-12): only 3 of 7 analyst panels above the fold, AI Thesis missing on most picks, EPS-beats reads `0/4` for most tickers.
- **4c-1** (`briefs/phase-4c-1-brief.md`): UI placeholder + lazy narrate endpoint + hook + narrate-all in scanner + EPS-beats diagnostic. Target `0.15.1-alpha`.
- **4c-2** (`briefs/phase-4c-2-brief.md`): 3-stage russell sieve. Stage 1 bars-only on all 2037 in ~2 min → ~400; Stage 2 +fundamentals +RS in ~4 min → ~80; Stage 3 full 7-layer scoring in ~8 min. SieveCoverageStrip renders `2037 → 412 → 87 → 23` ladder; amber when partial. Russell only — largecap + all keep single-pass. Target `0.16.0-alpha`.

### Phase 5 — Calibration loop + ML refinement

**Hard dependency:** Phase 3 (PIT data) + Phase 4a (forward-return labels). Both shipped.

**Honest caveats from original spec.** ML on stock picking is hype-prone. Three guardrails: (1) all ML is interpretable — gradient boosting + SHAP, k-NN explanations, no deep nets; (2) all ML re-ranks on top of the rule-based composite, never replaces it; (3) every ML output ships with a fallback so a model failure degrades gracefully. Auto-disable rule: if meta-ranker IC < composite-alone for 2 consecutive weeks, disable.

- **5a Training + discovery** (`briefs/phase-5a-brief.md`, pending agent). Engine has been writing `mlTraining` rows since 4a. Does any ML model beat the existing hand-tuned composite by a statistically meaningful margin under methodology that survives scrutiny? Non-negotiable methodology: purged walk-forward CV with embargo in rebalances; cross-sectional rank-IC as primary metric; paired Wilcoxon vs composite baseline with Bonferroni correction per config; per-config IC reporting when multiple configs survive dedup; 5 model classes (linear, ridge, LightGBM ranker, LightGBM binary, LightGBM full-feature) + Model 0 baseline. Polyglot: introduces Python under `scripts/ml/`, confined, not on hot path. Deliverable: `reports/phase-5a/findings.md` selecting one of three paths for 5b — A (deploy winning model), B (more data/features needed), C (inconclusive, repeat in 6 months). No frontend, no `APP_VERSION` bump.
- **5b Production rollout** (pending, blocked on 5a Path A). Decides Python→TS deployment: (a) re-implement inference in TS (only linear models), (b) export to ONNX + Node ONNX runtime, (c) separate Python inference service (Cloud Run / Cloud Functions).
- **5c Monitoring + retraining** (pending, blocked on 5b). Weekly retrain; calibration dashboard (per-analyst hit rate, alpha, info ratio rolling 30/90/180); auto-disable rule wired; model version stamped on every snapshot.

Phase 5 broader scope retained for reference: weight optimizer (`backtest/optimize-weights.ts`, grid or Bayesian with cap on weight changes per cycle); regime-conditional weights (one weight vector per regime); post-trade AI review (`scheduled/post-trade-review.ts`, daily Opus); calibration dashboard (`src/views/CalibrationView.jsx`); meta-ranker (`ml/meta-ranker.ts`, XGBoost/LightGBM on layer scores → forward returns, weekly retrain).

### Phase 6 — Real options data

Replace volume-and-realized-vol proxy in `options-flow.ts` with actual OPRA chain data.

Scope: `docs/OPTIONS_PROVIDER.md` (Tradier free OPRA delayed vs Polygon Options vs TradeStation vs Alpaca); `shared/options-provider.ts` (`getChain`, `getIV30`, `getIVRank`, `getSkew`); IV percentile + IV rank (252-day rolling); term structure + skew (front vs back month, 25-delta call vs put); options-flow rewrite (real chain volume + OI changes + unusual flow); earnings-board IV plumbing (real IV percentile, not proxy); strike picker (`shared/options-strike-picker.ts`).

**Dependencies.** Phase 0 spend awareness — chain calls can balloon.

### Phase 7 — Portfolio layer

Stop scoring tickers in isolation. Every recommendation respects portfolio constraints.

Scope: `shared/correlation.ts` (rolling 60-day, daily update); `portfolio/exposure.ts` (sector caps default 25%, sub-industry 15%; gross/net by regime — risk_on 100/100, neutral 70/70, risk_off 40/30); `portfolio/factors.ts` (momentum, value, quality, size, vol); `portfolio/beta-size.ts`; `portfolio/var.ts` (1-day 95% historical); `src/views/PortfolioView.jsx`; `runAnalystsForTicker` flags sector-cap breaches + 0.8+ correlations.

### Phase 8 — Position sizing engine

Three sizing modes properly enforced: equal-weight, vol-target, fractional Kelly.

Scope: `shared/realized-vol.ts` (rolling 30-day annualized); `portfolio/sizing.ts` (three pure functions); per-setup sizing rules in `earnings-board.ts` + `prophet-picks.ts`; hit-rate-aware Kelly via Phase 5 attribution; sizing enforcer in journal (recommended vs actual); `portfolio/rebalance.ts`.

**Dependencies.** Phase 5 (Kelly needs hit rates), Phase 7 (sizing is portfolio-aware).

### Phase 9 — Exit / trade management

Trade lifecycle: trailing stops, scale-out ladders, news-event triggers, correlation-break alerts, time-based exits.

Scope: `shared/trade-lifecycle.ts` (state machine: Open / T1-hit / T2-hit / stopped / time-exited / manually-closed); `lifecycle/trailing-stop.ts` (ATR, activates after T1); `lifecycle/scale-out.ts` (default 1/3 T1, 1/3 T2, 1/3 runner); `scheduled/news-watch.ts`; `lifecycle/correlation-break.ts` (SPY 50dma break flags correlated longs); `lifecycle/time-exit.ts` (vol plays +1 post-earnings; PEAD 30/60 days); `src/views/OpenPositionsView.jsx`; `src/lib/notifications.js` (browser push, phone-first).

### Phase 10 — Missing data classes

Plug the data gaps a serious desk wouldn't trade without.

Scope: `shared/short-interest-provider.ts` (FINRA biweekly + vendor for daily); borrow rate (IBKR or Quiver); `shared/darkpool-provider.ts` (Quiver dark pool or FINRA ATS); options skew surfaced in catalyst layer (from Phase 6); `shared/block-trade-provider.ts` (Polygon trades >10k shares + cross-exchange flag); `shared/breadth-provider.ts` (NH/NL, %>50dma, McClellan); `shared/sentiment-provider.ts` (AAII bull/bear, NAAIM); credit-spread layer in `shared/regime.ts` (HY OAS, IG OAS); new dedicated analysts (`short-pressure.ts`, `breadth.ts`, `sentiment.ts`); weight rebalance via optimizer.

**Dependencies.** Phase 5 (weights calibrated, not guessed), Phase 6 (skew).

### Phase 11 — Analyst depth

Lynch becomes actually Lynch. Fundamental becomes actually fundamental. Dedicated short-side analyst.

Scope: Lynch rewrite (PEG vs analyst LT growth, D/E vs sector median, 5y EPS std, insider vs buyback, six-bucket classification); Fundamental rewrite (ROIC, FCF yield, share count drift, debt structure); `analysts/short-side.ts` (insider-selling clusters + debt covenant stress + declining estimates); `shared/earnings-interpreter.ts` (reads transcripts via Opus, structured signals out); `shared/arbitrator.ts` (resolves analyst conflicts via Opus); `scheduled/pm-decision.ts` (Claude-as-PM, daily structured decision).

**Dependencies.** Phase 6 (skew), Phase 10 (short interest).

### Phase 12 — Auth + DR

Firebase Auth + per-user Firestore rules + daily backups verified by restore drill.

Scope: `src/firebase.js`, `src/lib/auth.js`, `src/components/AuthGate.jsx` (Google sign-in); update `FIRESTORE_RULES.md` for `request.auth.uid == resource.data.ownerUid`; ownerUid migration on `tradeLog.js` + all snapshot writers; `shared/auth.ts` (verify Firebase ID token); `src/lib/useAuth.js`; `scripts/restore-drill.ts` (quarterly).

**Dependencies.** Phase 0 backups exist.

### Phase 13 — Scale + caching + staging

Caches survive cold starts. Functions don't get hammered. Staging URL exists.

Scope: `shared/cache.ts` (Netlify Blobs or Upstash Redis); `netlify/edge-functions/rate-limit.ts` (per-IP 60/min); separate `tradeiq-staging.netlify.app` site with own Firebase project; `.github/workflows/promote-to-prod.yml`; bundle splitting (vite code-split per view); `src/sw.js` (PWA service worker, phone-first offline read).

### Phase 14 — Audit trail + compliance hooks

Every recommendation logged with model version, inputs, time, user. Exportable audit log.

Scope: Firestore `recommendationLog/{date}/{eventId}`; per-recommendation disclaimer (v{model}/{date} stamp on each card); `src/views/AuditView.jsx` + `scripts/export-audit.ts` (CSV/JSON for date range); compliance disclaimer surfacing beyond global footer ("Not financial advice" per-action); `shared/inputs-hash.ts` (deterministic hash of all inputs).

**Dependencies.** Phase 12 auth so user is identified.
