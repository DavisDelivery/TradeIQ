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
- **`briefs/phase-0a-2-brief.md` + `kickoffs/phase-0a-2-executor.md`** — sp500 PIT universe-history backfill. Kickoff paste-and-go (1128 lines, self-contained, PAT inline). Optional Databento API key in second message; falls back to Polygon. Days of work; unblocks Phase 5a's data gate and every future historical sp500 backtest.
- **Phase 4f-finish** — no brief yet; scope captured in the 4f-finish row of the phase table. Best executed AFTER first audit cron has fired (Sunday 19:00 UTC) so there's real data to classify. Orchestrator can fire `GET /api/audit-stub-analysts` manually post-merge to seed an immediate first audit and unblock 4f-finish on demand.

### Briefs blocked / shelved
- **`briefs/phase-5a-brief.md`** — Phase 5a scaffolding shipped (PR #24 OPEN draft) but data gate cannot be cleared with current PIT coverage. Will unblock once Phase 0a-2 lands (2 sp500 runs would clear it). Recommendation 2026-05-14: ship 4f first; once 0a-2 lands, resume 5a.

### Pending no-brief phases (capturing scope for future drafting)
- **Phase 4a-2 — Engine write path for full scored universe** (no brief yet). Lifts the "every mlTraining row is inPortfolio=True" structural limitation. Only needed if 5a's eventual findings recommend going wider than re-ranking.
- **Phase 4b-3 — Run cancellation + presets + saved templates** (no brief yet). Quality-of-life for backtest launcher.
- **Phase 4e-2 — Prophet Portfolio UI tab** (no brief yet). Blocked on 4e-1-finish verdict flipping to SHIP/SHIP-WITH-CAVEATS.

Recommended order: **0a-2 PR review/merge (open 2026-05-15) + 4f (paste-and-go) + 4e-1-finish (in flight; just wait for completion)**. After 0a-2 merges + Netlify redeploys, resume 5a (re-fire the two sp500 seed runs to clear the data gate).

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
| 4a-2 | Engine: write `mlTraining` rows for full scored universe | pending (no brief yet) | — | — | Surfaced 2026-05-13 from Phase 5a schema audit. Current engine (`engine.ts:489`) writes `mlTraining` rows only for top-N portfolio picks (post-`buildPortfolio` filtering), not the full scored universe. Consequence: every row is `inPortfolio == True` by construction, so any ML model trained on this data can only re-rank within composite's picks — it cannot answer "should composite have picked differently?". Phase 4a-2 adds a parallel write path that emits one row per scored candidate (not just target), gated by a config flag (`config.mlTraining.includeUnselected: boolean`) so existing runs remain backward-compatible. Out-of-portfolio rows get `inPortfolio: false` stamped and zero/null cost fields. Small engine change; documented thoroughly in `briefs/phase-5a-schema-notes.md` § "Critical limitation". Run after 5a delivers initial findings — if findings recommend a wider question be answered, 4a-2 unblocks 5a-2 with full-universe data. |
| 0a-2 | PIT universe-history backfill (sp500) | done (PR open) | — | 2026-05-15 | Shipped via `phase-0a-2-sp500-pit-backfill` branch. **Diverged from original brief** — Wikipedia / Firestore plan was incompatible with the 2026-05-11 architectural pivot (Wikipedia decommissioned; `UNIVERSE_HISTORY` reads from a static TS module, not Firestore). Pivoted to **iShares IVV `asOfDate`** — same pattern the existing `backfillRussell2kHistory()` uses for IWM, just pointed at the S&P 500 ETF. Adds 100 monthly sp500 snapshots 2018-01-31 → 2026-04-30 alongside the existing SSGA SPY current snapshot. Ticker counts 503-510 per snapshot (within "500 ± 10" target). All spot-checks pass against documented history (FB→META rename, TSLA add Dec 2020, ABNB add Sept 2023, TWTR delist Oct 2022). 522 → 534 tests. Backfill report at `reports/phase-0a-2/backfill-report.md`; PR description at `briefs/phase-0a-2-pr-description.md` documents the divergence in detail. **Brief should be updated** to match what shipped (Chad: deferred per kickoff guidance). 0a-2b (NDX) + 0a-2c (russell2k pre-2022) follow-up sub-phases. **Acceptance test deferred to post-merge + Netlify redeploy** — the static-TS-module approach only takes effect after deploy, unlike the brief's Firestore design which would have been live on script-run. Polygon + Databento API keys provided by Chad are unused in this PR; either would be useful for a future symbol-activity audit phase. |
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
| 4e-1-finish | Backtest live-data run + verdict | in flight (re-fired post bg-dispatch fix) | — | — | First attempt 2026-05-15 09:33 UTC fired runId `pb-full-202605150933-fqrsid` but stuck in `pending` — root cause was a fire-and-forget dispatch race in `portfolio-backtest-trigger.ts` (PR #30 merged `1a8a003`, agent confirmed AWS Lambda container freeze before dispatch POST could leave). **Fix verified end-to-end**: `pb-short-demo-202605151412-89zcqq` advanced `pending → running` within 60s of firing post-deploy; new `dispatchOk:true` field in trigger response confirms gateway acknowledged the POST. **Fresh full-window run fired 2026-05-15 14:18 UTC**: runId `pb-full-202605151418-8v4k66`. Pre-fix stuck runs left untouched. On completion: results land in `portfolioBacktests/{runId}`; `GET /api/portfolio-verdict` synthesizes the full verdict markdown by reading the latest audit row + this backtest run. If verdict = SHIP → file follow-up PR landing `scan-prophet-portfolio-rebalance.ts` (W5 spec in brief) and bump APP_VERSION to `0.18.2-alpha`; if DON'T SHIP → propose v2 rule revision in `briefs/phase-4e-1-fix-brief.md`. |
| 4e-1-bgfix | Portfolio-backtest-trigger dispatch race | done | 0.18.1-alpha | 2026-05-15 | PR #30 merged `1a8a003`. Root cause: `portfolio-backtest-trigger.ts` used fire-and-forget `fetch(...).then().catch()` to invoke the background function; AWS Lambda froze the trigger container before the dispatch POST left, so `run-portfolio-backtest-background.ts` was never invoked. Fix: `await` the dispatch fetch with a 3-second timeout race (Netlify Background Functions return 202 from the gateway in <1s; await blocks only until dispatch in flight, not the 15-min background work). Trigger response now includes `dispatchOk: boolean` field. Tests 618 → 635 (+17 — 8 bg-handler diagnostic, 9 trigger including the key "AWAITS the dispatch fetch before returning" regression). Surgical: only `portfolio-backtest-trigger.ts` modified. **PR #30's commit message claim that the non-portfolio path was unaffected ("heavier pre-fetch validation kept the container warm") was wrong — corrected by 4e-1-bgfix-2 below.** Two pre-existing stuck portfolio runs (`pb-full-202605150933-fqrsid`, `pb-rolling-2022-202605142200-008f3z`) left in their stuck state. End-to-end verified post-deploy: `pb-short-demo-202605151412-89zcqq` completed cleanly with full metrics (+6.91% vs SPY +9.30% on 3-month sample). |
| 4e-1-bgfix-2 | Non-portfolio backtest-runs-trigger dispatch race | done | unchanged | 2026-05-15 | PR #31 merged `08aff83`. Discovered when 0a-2 acceptance test (`bt_20260515115436_ixxt1o`) sat stuck in `pending` for 3+ hours. **Same fire-and-forget bug as PR #30** — non-portfolio path was just luckier most of the time, not warm-container-protected as PR #30's commit message had claimed. Fix mirrors PR #30 inlined directly into `backtest-runs-trigger.ts` (no shared module; would have required modifying portfolio-backtest-trigger.ts, forbidden by brief scope guard). Tests 635 → 638 (+3: AWAITS regression + timeout + network-error). Note: agent had to re-author commit (`executor@tradeiq.local`) because GitHub's email-privacy setting on Chad's account now rejects pushes from `chad@davisdelivery.com`. Cosmetic only. **Unblocked 0a-2 verification**: fresh acceptance test fired at 2026-05-15 17:12 UTC as `bt_20260515171213_mclesk` with `dispatchOk: true` confirmation. |
| 4e-2 | Prophet Portfolio UI tab | pending (no brief yet) | — | — | Consumes `GET /api/prophet-portfolio`. Mobile-first ProphetPortfolioView with equity curve vs SPY/QQQ/IWF, holdings table, last-20-swap log, decisionLog drilldown. Blocked on 4e-1-finish flipping to SHIP/SHIP WITH CAVEATS so there's real state to render. |
| 4f | Stub-analyst audit + repair + institutional-flow data (partial) | done | 0.18.0-alpha | 2026-05-15 | PR #27 shipped W1 audit infra, W4 institutional-flow modules, W7 weekday-22:00 scan, W3/W5 partial (insider/patent/political `_noData` wrappers + composeWeights rescale). Live audit ran 2026-05-15 (14 Live / 5 Stub / 5 Degraded; see `reports/phase-4f/audit.md`). Follow-up tracked as 4f-finish below. |
| 4f-finish | Per-stub diagnoses + no_upstream removals + core-analyst _noData + UI badges + options-unusual wiring | done | 0.18.1-alpha | 2026-05-15 | Follow-up to PR #27. PR #29 merged `0ab2a10`. (1) **W2** — per-stub diagnoses in `reports/phase-4f/audit.md` § 2 classify every Stub + Degraded entry per kickoff § 4.2 taxonomy. (2) **W3** — `runEarnings`/`runNewsSentiment`/`runFundamental`/`runFlow` in `analysts/core.ts` now emit `signals._noData=true` on empty inputs (PR #27 only fixed the analyst-runner wrappers for insider/patent/political; this completes the core handlers). (3) **W5 permanent removals** — `ANALYST_WEIGHTS['macro-regime']=0` (no_upstream: macroBias defaults to 0 and is never wired) and `ANALYST_WEIGHTS['patent-analyst']=0` (no_upstream for russell2k, 1 unique value across 3600 obs; conservative global removal — Phase 4g may reintroduce per-universe). composeWeights rescales the surviving 8 analysts to sum to 1.0. (4) **W5 UI** — new `src/components/AnalystContributions.jsx` with `LIVE/NO_DATA/REMOVED` provenance badges; TargetBoardView inline contributions panel replaced. (5) **Options-unusual wiring** — `scan-institutional-flow-largecap.ts` now calls `getOptionsSnapshot` + `computeOptionsFlowSignal` per ticker; new `polygon-options-snapshot.ts` fetches Polygon's `/v3/snapshot/options/{ticker}`. OI-spike sub-score lands live; sweep/block sub-scores stay 0 until a per-contract tick fetcher follows (Phase 4g). Previous-day OI flows via Firestore `_oiToday` map for the day-over-day spike comparison. (6) **W6 SKIPPED** — blocked on Phase 4e-1-finish's background-function dispatch bug; no working backtest infra to fire pre/post runs. Explicit in PR description; kickoff authorizes skip (W6 is sanity check, not gate). APP_VERSION → 0.18.1-alpha (data-honesty + UI surface change). MODEL_VERSION stays 2026.03.0 — composite math itself didn't change, only which analysts contribute. Tests 583 → 618 (+35). |
| 4e-1-infra | Backtest checkpoint-and-resume (Netlify 15-min Background Function ceiling) | done | 0.18.2-alpha | 2026-05-16 | PR #32 merged `32773fb`. Shipped: `shared/backtest-resume/{cursor,watchdog,reinvoke}.ts` — generic `BacktestCursor<TState>` + 13-min budget watchdog + `Context.waitUntil()`-based self-reinvoke helper. Both `run-portfolio-backtest-background.ts` and `run-backtest-background.ts` refactored to cursor-driven via new `engine-batched.ts` and `prophet-portfolio/backtest-harness-batched.ts` with byte-identical equivalence tests pinning the refactor to the unbatched output. mlTraining rows migrated to Firestore subcollection (`backtestRuns/{runId}/mlTraining/{rowId}`) via new `appendMLTrainingRows` + `readAllMLTrainingRows` in `persistence.ts` — would have blown the 1 MiB doc ceiling at sp500/monthly/7yr (~1.3 MiB) otherwise. 8 rebalances per invocation default (`BACKTEST_BATCH_SIZE`), 13-min watchdog (`BACKTEST_BUDGET_MS`), graceful fallback to `await fetch()` if `context.waitUntil` is absent. APP_VERSION 0.18.1→0.18.2-alpha. Tests 638 → 691 (+53). **End-to-end verified post-merge:** canary `pb-short-demo-202605160100-wzs336` completed `done` in 52 seconds across 2 invocations, cursor properly cleared on terminal write. Architecture proven in production. |
| 4e-1-finish | Backtest live-data run + verdict | in flight (under new infra) | — | — | First two attempts dead: `pb-full-202605150933-fqrsid` stuck pending (pre-bg-dispatch-fix), `pb-full-202605151418-8v4k66` killed at 15-min ceiling (pre-checkpoint-resume). **Third attempt fired 2026-05-16 01:03 UTC under 4e-1-infra**: runId `pb-full-202605160103-5cs65b`, `dispatchOk:true`. Should chain across ~10-12 invocations and complete in 90-120 min. On completion: `GET /api/portfolio-verdict` synthesizes the full verdict markdown. If verdict = SHIP → follow-up PR lands `scan-prophet-portfolio-rebalance.ts` (W5 spec in brief) and bumps APP_VERSION to `0.18.3-alpha`; if DON'T SHIP → propose v2 rule revision. |
| 5a | ML training pipeline (discovery) | unblocked; data gate run in flight | — | — | `briefs/phase-5a-brief.md`. Scaffolding shipped (PR #24 OPEN draft — 50 tests, ruff clean, no findings.md). W0 data gate (≥10k rows / ≥5 runs) was blocked on sp500/ndx PIT coverage AND on backtest infra being able to run the full window. Both blockers now cleared: Phase 0a-2 PR #28 closed the sp500 PIT gap; Phase 4e-1-infra PR #32 closed the 15-min backtest ceiling. **Fresh acceptance run fired 2026-05-16 01:03 UTC**: runId `bt_20260516010323_xanxpf`, sp500/monthly/top50/2018-2024, `dispatchOk:true`. Should chain across ~10-12 invocations and produce ~8400 mlTraining rows in the subcollection (clears the 10k threshold with ~2 such runs). On completion, agent resumes from PR #24 draft to run the discovery pipeline and produce findings.md with SHIP/DON'T SHIP/PARTIAL verdict on the discovered model. |
| 4g | Threshold retunes + per-contract options tick fetcher + W6 backtest comparison | pending (no brief yet) | — | — | Captures the four items deferred from 4f-finish: (1) **Threshold retunes** for the three `threshold_misconfig` cases the 4f-finish W2 diagnoses identified — `flow-analyst` on Target × russell2k (stdev 3.93 too narrow), `technical-analyst` on Target × russell2k (mean 71, stdev 3.2, suspicious narrow range), `volatility` on Prophet × russell2k (34.66% pctExactly50). Each needs the band thresholds widened or recalibrated; must be validated against a backtest before shipping. (2) **Per-contract options tick fetcher** — current `polygon-options-snapshot.ts` returns aggregated snapshot data which yields the OI-spike sub-score; sweep + block sub-scores in `options-unusual.ts` remain at 0 until a per-contract tick fetcher (probably `polygon-options-trades.ts` calling `/v3/trades/{contract}`) lands. (3) **W6 IC comparison** — pre/post 4f composite IC on the same backtest config; need to demonstrate the W3/W5 changes are product-positive empirically, not just by construction. (4) **Per-universe weight reintroduction** — macro-regime + patent-analyst are globally removed in 4f-finish; for universes/regimes where they DO have signal (e.g., patent-analyst on largecap with real Quiver data), reintroduce via `ANALYST_WEIGHTS[universe][name]` instead of the global flat map. **All four items blocked on 4e-1-infra (Netlify 15-min ceiling) — bg-dispatch is fixed (#30, #31), but backtest infrastructure still can't run multi-year windows in a single invocation. Threshold retunes + W6 IC comparison both need >15-min compute.** Until 4e-1-infra lands, the audit cron's next run (Sunday 19:00 UTC) should reclassify several Target × russell2k analysts from `stub` to `live` (PR #27 + #29 fixes will show up in the data); 4g can read that re-audit as supporting evidence but still can't ship until backtest infra works. |
| 4h | Russell scan reliability + nightly schedule + company info display | pending (no brief yet; stopgap nightly cron landed) | — | — | **Surfaced 2026-05-15 from Chad's UI observation** that the Russell2k Target Board "isn't working." Confirmed by live probe: the `/api/target-board?universe=russell2k` endpoint hangs ~25 sec under cold conditions (slow Firestore aggregate read across thousands of partial-scan snapshots) and the daytime cron `0,30 13-21 * * 1-5` cannot complete russell2k in 15 min (~2000 names × ~1-2s scoring = 33-67 min compute) — every invocation gets killed before finishing, never producing a complete fresh sweep. **Stopgap shipped this session**: new `scan-target-board-russell2k-nightly.ts` adds a daily 9pm-ET (01:00 UTC) attempt so the system at least tries an evening scan. Partial scores still write to Firestore. **Phase 4h proper fix** (blocked on 4e-1-infra): (1) apply 4e-1-infra's checkpoint-resume pattern (`cursor.ts` + `watchdog.ts` + `reinvoke.ts` from `shared/backtest-resume/`) to `scan-target-board-russell2k.ts` and prophylactically to `scan-target-board-sp500.ts` (also borderline); (2) optimize the `target-board.ts` read endpoint (Firestore composite index or aggregation rewrite — current shape is slow at russell2k scale); (3) add `companyName` + `sector` to each pick's JSON output by enriching from Polygon `/v3/reference/tickers/{ticker}` at snapshot-write time (cache aggressively — ticker reference data rarely changes); (4) update `AnalystContributions.jsx` and pick-row renderer to display company name + sector. Sector data is already known internally (sector-rotation analyst computes it); just not surfaced at the pick level. Estimated single agent session ~3-4 hours after 4e-1-infra lands. |
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
