# Phase 4c-2 — Russell Sieve Architecture

**Author:** orchestrator
**Target version:** 0.16.0-alpha
**Dependencies:** Phase 1 (Firestore snapshot infrastructure + scheduled scan functions), Phase 4a (engine writes mlTraining rows). Phase 4c-1 (narrative completeness) does NOT block this brief; they can ship in parallel.
**Status when this brief is written:** main = `64bfe12`, APP_VERSION = `0.15.0-alpha`, 367 tests passing.

---

## Why this exists

Chad's complaint, verbatim: *"It's still not scanning all Russell 2000. I told you to devise a layer system to produce the best options out of all 2000."*

Today the Russell-universe prophet board does not actually score all 2037 Russell 2000 constituents per scan. The architectural reality:

- The Phase 1 scheduled scan function (`scan-prophet-russell.ts`) loads the full 2037-ticker universe and starts scoring.
- The Netlify background-function container caps at 15 minutes. Scoring 2037 tickers across 7 layers, each pulling Polygon bars + Finnhub fundamentals + Quiver insider/political/contracts/patents, takes far longer than 15 minutes at any safe concurrency level (Polygon free-tier rate limits, Quiver free-tier rate limits, the cost of cold cache misses on first-time tickers).
- The scan exits at the 14-min internal budget with a partial result — typically the first 500–800 tickers scored, the remaining 1200+ untouched.
- The snapshot is written with the partial coverage. The top picks come exclusively from the slice that got scored.

In other words: **the system is structurally incapable of finding the best 20 picks out of 2037 names with a single uniform-cost scan**. Cheap and uniform doesn't fit the budget.

The fix Chad asked for is a sieve: a multi-stage filter where the early stages are very cheap (run on all 2037 tickers in seconds) and only narrow survivors reach the expensive late stages. The output is the same — a ranked list of high-quality picks — but the pipeline guarantees every ticker got at least a first-pass look.

This is a real architectural piece. Roughly the same scope as Phase 1 was. Expect a sizeable PR.

---

## The contract this brief upholds

The user-facing promise of the Russell prophet board is: *"the top 20 picks here are the best 20 in the Russell 2000 right now."* Today that promise is silently violated for ~60% of the universe. After this brief, the promise either holds OR the UI is honest about where the gap is.

The sieve must be:

1. **Complete** — every ticker in the Russell 2037 list gets at least the cheapest filter applied per scan.
2. **Honest** — the snapshot stamps coverage telemetry (`stage1Scored / stage2Scored / stage3Scored` counts) and the UI surfaces them. If for any reason Stage 3 only covers 80 names, the user sees that, not a "top 20" implication.
3. **Cost-aware** — each stage has a documented budget and concurrency. The system fails honestly (partial coverage stamp + warning) rather than dropping silently.
4. **Same architectural style as Phase 1** — runs as a Netlify background function, writes to the Firestore snapshot store, reuses the existing scoring code where possible.

## Operational context

- Repo: `DavisDelivery/TradeIQ`
- Netlify site: `tradeiq-alpha.netlify.app`
- Firebase project: `tradeiq-alpha`
- `GITHUB_PAT`: `<read-only-PAT, provided per session>` — Chad provides a write-scoped PAT per session.
- `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `QUIVER_API_KEY`: already configured in Netlify env across all contexts.
- Conventions:
  - APP_VERSION bumps to `0.16.0-alpha`.
  - Mobile-first; the existing FreshnessPill stays.
  - `tsc --noEmit`, `npm test`, `npm run build` clean before PR.
  - Background function = 15-min cap; this brief leans into that — the sieve stages must fit collectively in 15 min including all I/O.

## W0 — Preconditions

1. `git fetch origin && git log --oneline -3 origin/main` — confirm at `64bfe12` or later.
2. `npm ci && npm test` — confirm 367 tests passing as baseline.
3. `npm run build` — confirm clean.
4. Read `netlify/functions/scan-prophet-russell.ts` end-to-end. Note: budget constant, concurrency constant, how it invokes the scoring loop.
5. Read `netlify/functions/shared/prophet/layers/*.ts` — survey each of the 7 layers. For each, document:
   - Data sources it touches (Polygon? Finnhub? Quiver?).
   - Approximate compute time per ticker (cache hit vs miss).
   - Whether the layer can run on bars-only data (cheap) vs requires fundamentals/insider data (expensive).
6. Verify the Russell universe size in `netlify/functions/shared/universe.ts`. The brief assumes 2037 — confirm.
7. Read `netlify/functions/shared/snapshot-store.ts` — note how `writeSnapshot` works. The sieve adds metadata fields; understand the existing schema first.

## W1 — Stage design

This is the meat of the brief. Read it twice before implementing.

### Stage 1: Cheap universe-wide filter (target: 2037 → ~400 survivors)

**Goal:** every Russell ticker gets a first-pass look. Stage 1 fits in **~2 minutes total** for the full universe.

**Compute per ticker:** only Polygon bars (cached aggressively after Phase 1's pit-cache + bar cache work). No Finnhub, no Quiver. Bars-only signals.

**Signals (each ticker gets a Stage-1 composite score 0–100):**

- **Trend qualifier** — is `close > sma20 AND close > sma50 AND close > sma200`? Binary.
- **Momentum 20d** — `(close - close[20])/close[20]`, normalized to 0–100 via percentile rank within the Russell universe.
- **Volume surge** — `volume[5] / volume[20]` ratio, normalized.
- **Volatility regime** — 20d realized vol annualized, normalized inversely (lower vol gets higher Stage-1 score — Stage 1 favors stable-trending names; quirky names that survive to Stage 2 are quirky on purpose, but Stage 1 cleanly filters out the chaotic ones).
- **Above-52w-low margin** — `(close - low52w) / low52w`. Filter out names trading near 52-week lows (they're rarely the best 20 picks; the small minority that ARE great deep-value plays are best surfaced on a different board, not Prophet).

Composite formula: weighted sum of the 5 signals; weights configurable in `netlify/functions/shared/prophet/sieve/stage1.ts`. Default equal-weight (20% each); reweighting happens in Phase 5b if ML training surfaces better weights.

**Survival threshold:** top 20% by Stage-1 composite, OR Stage-1 composite ≥ 60 (whichever yields a survivor count between 300 and 600). Document the threshold in the snapshot metadata so the UI can show it.

**Concurrency:** 20 (bars are aggressively cacheable; Polygon paid plan tolerates this).

**Budget:** 120 seconds wall time. If exceeded, return the partial Stage-1 list and stamp `stage1_partial: true`.

### Stage 2: Mid-cost narrowing (target: ~400 → ~80 survivors)

**Goal:** add fundamentals + relative strength signal. Stage 2 fits in **~4 minutes total** for ~400 tickers.

**Compute per ticker:** Stage 1 cached results + Finnhub fundamentals (cached via pit-cache). Still no Quiver — the per-ticker insider/political/contracts/patents calls are too expensive to run on 400 tickers.

**New signals (Stage-2 composite is Stage-1 composite + the new signals, reweighted):**

- **Earnings growth** — YoY EPS trend, beat history (this is where `epsBeats` lives — same code path as 4c-1's fix).
- **Revenue growth** — YoY trend.
- **Fundamental quality** — ROE, margin, debt/equity composite. Reuse whatever the existing `fundamental` layer computes; Stage 2 just calls that layer.
- **Relative strength vs SPY** — 60d return vs SPY's 60d return. Names beating SPY get a boost.

**Survival threshold:** top 25% by Stage-2 composite, OR ≥ 70, whichever yields 60–120 survivors. Stamp the threshold + survivor count in metadata.

**Concurrency:** 8 (Finnhub paid plan rate limit is 300/min — at 8 concurrent calls of avg 1.5s each, throughput ≈ 320/min, on the edge but OK).

**Budget:** 240 seconds. Exceed → partial stamp.

### Stage 3: Full 7-layer scoring (target: ~80 → final ranked list)

**Goal:** the existing `runProphetScan` logic, but only on Stage-2 survivors. Fits in **~8 minutes** for 80 tickers.

**Compute per ticker:** identical to today's scan logic — all 7 layers, all data sources. Quiver insider/political/contracts/patents finally enters the picture here, where the per-ticker cost is justified by the small candidate count.

**Output:** standard `ProphetPick` shape with composite, layers, conviction, flags. The existing `narrateTopN` (or post-4c-1's `narrateAll`) generates AI theses on the survivors. Each pick stamps `_sieve_stage_max: 3` for telemetry.

**Concurrency:** 4 (Quiver free tier is 60/min; with 4 concurrent calls touching 4 endpoints each, throughput ≈ 60/min — at the limit).

**Budget:** 480 seconds. Exceed → partial stamp.

### Total budget: 120 + 240 + 480 = 840 seconds = 14 minutes.

Fits in the 15-min background container with a 60-second slack for snapshot write + narration + telemetry serialization.

If ANY stage hits its budget cap, the partial-stamp propagates downstream — Stage 2 only processes Stage-1 survivors, Stage 3 only processes Stage-2 survivors. The snapshot stamps:

```json
{
  "sieve": {
    "stage1": { "scored": 2037, "survived": 412, "thresholdScore": 58, "budgetMs": 119_840, "partial": false },
    "stage2": { "scored": 412, "survived": 87, "thresholdScore": 71, "budgetMs": 239_120, "partial": false },
    "stage3": { "scored": 87, "qualified": 23, "budgetMs": 478_650, "partial": false }
  }
}
```

When the snapshot is served, the frontend renders a sieve-coverage strip showing `2037 → 412 → 87 → 23 picks`. Visible. Honest.

## W2 — Implementation

### File structure (additions to `netlify/functions/shared/prophet/`)

```
netlify/functions/shared/prophet/sieve/
  stage1.ts           ~150 lines  — pure functions: signals + scoring
  stage2.ts           ~140 lines  — adds fundamentals + RS signal
  stage3.ts           ~80 lines   — orchestrates existing 7-layer scoring on survivors
  budgets.ts          ~30 lines   — exported budget constants
  types.ts            ~50 lines   — SieveMeta, StageResult types
  __tests__/
    stage1.test.ts    ~150 lines
    stage2.test.ts    ~120 lines
    sieve-integration.test.ts  ~100 lines  — end-to-end with mocked data sources
```

### Modified files

```
netlify/functions/scan-prophet-russell.ts    edit  ~80 lines  — replace single-pass with sieve orchestration
netlify/functions/shared/snapshot-store.ts   edit  ~10 lines  — extend ProphetSnapshot type with sieve metadata
netlify/functions/prophet-picks.ts           edit  ~30 lines  — pass sieve metadata through the response
```

### Frontend additions

```
src/components/SieveCoverageStrip.jsx        NEW   ~60 lines
src/ProphetView.jsx                          edit  ~15 lines  — render the strip
src/__tests__/SieveCoverageStrip.test.jsx    NEW   ~50 lines
```

The `SieveCoverageStrip` renders only when `pick.metadata.sieve` exists (i.e. only on Russell, since largecap doesn't need a sieve). Shows: `2037 names · stage1: 412 survived · stage2: 87 · stage3: 23 ranked` with small icons. Warning treatment (amber) if any stage stamped `partial: true`.

## W3 — Apply the sieve to other universes? (decision: NO, with a note)

Largecap (~230 tickers) and All (~400 tickers) do NOT need a sieve. Their single-pass scan completes within budget. Stage 1's cheap signals are still useful as a "Stage-1 mini-rank" for debugging, but the existing scan-prophet-largecap and scan-prophet-all functions keep their single-stage scoring.

If a future universe gets added (e.g. "all-cap-3500" or international), revisit. For now: sieve = Russell only.

The metadata strip should not render on largecap/all boards (cleaner UI, and avoiding confusing implications).

## W4 — Background-function deployment

The sieve runs inside `scan-prophet-russell.ts` which is already a `-background` function (15-min cap). No new function needed; this is a re-implementation of the existing scan body.

`scan-prophet-russell.ts` becomes the orchestrator:

```ts
export default async () => {
  const log = logger.child({ fn: 'scan-prophet-russell-sieve' });
  const startedAt = Date.now();

  // Stage 1
  const stage1 = await runStage1(RUSSELL_TICKERS, log);
  log.info('stage1_complete', { scored: stage1.scored, survived: stage1.survivors.length });

  // Stage 2
  const stage2 = await runStage2(stage1.survivors, log);
  log.info('stage2_complete', { scored: stage2.scored, survived: stage2.survivors.length });

  // Stage 3 — full 7-layer (reuse existing runProphetScan with the survivor subset as the universe)
  const stage3 = await runProphetScan({
    universe: stage2.survivors.map(s => s.ticker),  // pass the subset, not 'russell'
    boardName: 'prophet',
    log,
    budgetMs: 480_000,
  });

  // Compose sieve metadata
  const sieveMeta = {
    stage1: stage1.meta,
    stage2: stage2.meta,
    stage3: stage3.meta,
  };

  // Narrate (Phase 4c-1's narrateAll if shipped, else existing narrateTopN)
  await narrateAll(stage3.picks, log);

  // Persist
  await writeSnapshot('prophet', 'russell2k', {
    picks: stage3.picks,
    universeChecked: stage1.scored,   // honest: how many we actually touched
    sieve: sieveMeta,
    scanDurationMs: Date.now() - startedAt,
    warnings: [...stage1.warnings, ...stage2.warnings, ...stage3.warnings],
  });
};
```

Important: `runProphetScan` currently takes a universe key (`'russell'`, `'largecap'`, etc.) and resolves to a hard-coded ticker list. It must be refactored to OPTIONALLY accept an explicit array of tickers (Stage-3 survivors). This is a one-line signature change with all callsites updated.

## W5 — Tests (mandatory)

### Unit tests

**`stage1.test.ts`**: each signal computed correctly on synthetic bar data; survivor threshold respects the (top-X% OR min-score) rule; output ordering by Stage-1 composite descending.

**`stage2.test.ts`**: composite combines Stage-1 score + new signals correctly; survivor threshold; partial-stamp behavior when fundamentals fetcher returns null for a ticker.

**`sieve-integration.test.ts`**: end-to-end with mocked data sources. Start with 100 synthetic tickers; verify Stage 1 narrows to ~20, Stage 2 to ~5, Stage 3 to ~3 (or whatever the test thresholds yield). Verify the final picks all have `_sieve_stage_max: 3` stamped. Verify metadata is well-formed.

### Frontend tests

**`SieveCoverageStrip.test.jsx`**: renders only when `metadata.sieve` is present; shows the `2037 → 412 → 87 → 23` ladder; amber treatment when any stage is partial.

### Integration with existing test suite

The existing `prophet-picks.test.ts` (or equivalent) gets one new case: a russell response with sieve metadata is parsed and rendered correctly by the existing prophet endpoint flow.

Total test target: ≥10 new tests. Final count ≥377.

## W6 — Performance verification

Before opening the PR, run the sieve against the live Russell universe ONCE (via a fresh manual trigger from the agent's bash terminal — same pattern as the snapshot seeding earlier this session). Capture:

- Total wall time end-to-end.
- Per-stage wall time.
- Per-stage scored count / survivor count.
- Polygon API call count + cache hit ratio.
- Finnhub API call count.
- Quiver API call count.
- Anthropic narration call count (if W4 from 4c-1 has shipped; else zero).
- Final pick count + sample of top 5 tickers.

If total wall time exceeds 14 minutes, tune the budgets DOWN (smaller stage 2 survivor count, lower concurrency on stage 3) until it fits. Document the tuned numbers in the PR description.

If total wall time is well under 14 minutes (say, 8 min), the sieve has headroom; document that too — future work could relax thresholds to surface more candidates.

## W7 — Version + ORCHESTRATOR + PR

- `APP_VERSION` → `0.16.0-alpha`.
- `ORCHESTRATOR.md`:
  - Row for `4c-2`, `done`, summarize the sieve architecture + the observed wall time + the survivor counts + the top picks.
  - Note: the same architecture is the template for any future "scan a wide universe" use case (international, all-cap-3500, etc.).
- PR description in `briefs/phase-4c-2-pr-description.md`. Include the W6 performance numbers verbatim.

## Verification

1. `npx tsc --noEmit` — clean.
2. `npm test` — ≥377 passing.
3. `npm run build` — clean.
4. Manual sieve trigger from agent bash:
   ```bash
   curl -X POST 'https://deploy-preview-XX--tradeiq-alpha.netlify.app/.netlify/functions/seed-scan-background?board=prophet&universe=russell'
   ```
   Returns 202 instantly; check Firestore + `/api/health` after 14 minutes for the new snapshot with sieve metadata.
5. Open the deploy preview's Prophet board with universe=russell. Confirm:
   - SieveCoverageStrip renders with the `2037 → ...` ladder.
   - Top picks are visible with `_sieve_stage_max: 3` flag (visible only in dev tools, not the UI itself).
   - No amber warning unless a stage was genuinely partial.
6. Sentry should show no new error types from any of the three stages.

## Out of scope

- **Re-weighting Stage 1/2 composite weights** based on ML training results — Phase 5b territory.
- **Adding new Stage 1 signals** beyond the five specified — keeps the surface small.
- **Sieving largecap or all universes** — they don't need it; do not over-engineer.
- **Real-time progress streaming during scan** — the snapshot writes once at the end. If you want per-stage progress, that's a separate dashboard feature, not part of the sieve.
- **Cache-invalidation logic** beyond what pit-cache already does — out of scope.
- **Stage-0 (data freshness check) for the entire universe** — out of scope; the pit-cache + bar cache layers handle this on demand.

## Files target

```
netlify/functions/shared/prophet/sieve/stage1.ts                NEW  ~150
netlify/functions/shared/prophet/sieve/stage2.ts                NEW  ~140
netlify/functions/shared/prophet/sieve/stage3.ts                NEW  ~80
netlify/functions/shared/prophet/sieve/budgets.ts               NEW  ~30
netlify/functions/shared/prophet/sieve/types.ts                 NEW  ~50
netlify/functions/shared/prophet/sieve/__tests__/stage1.test.ts            NEW  ~150
netlify/functions/shared/prophet/sieve/__tests__/stage2.test.ts            NEW  ~120
netlify/functions/shared/prophet/sieve/__tests__/sieve-integration.test.ts NEW  ~100
netlify/functions/scan-prophet-russell.ts                       edit ~80
netlify/functions/shared/snapshot-store.ts                      edit ~10
netlify/functions/prophet-picks.ts                              edit ~30
netlify/functions/shared/prophet/engine.ts (or wherever runProphetScan lives)  edit ~10  (accept explicit ticker array)
src/components/SieveCoverageStrip.jsx                           NEW  ~60
src/ProphetView.jsx                                             edit ~15
src/__tests__/SieveCoverageStrip.test.jsx                       NEW  ~50
src/App.jsx                                                     edit  1   (APP_VERSION)
ORCHESTRATOR.md                                                 edit       (4c-2 row)
briefs/phase-4c-2-pr-description.md                             NEW  ~150
```

~17 files, ~1300 lines net. Mid-large PR.

## Note to the executing agent

The temptation on this brief is to over-engineer the sieve — add Stage 0, add Stage 4, add ML-tuned weights, add caching for stage transitions. Don't. The specified 3-stage design is intentionally simple. Stage transitions write nothing to Firestore; the only persistence is the final snapshot. The pit-cache and bar-cache layers do the cross-scan caching already.

The hard part of this brief is not the code — it's the budget tuning in W6. The first run will almost certainly miss its budget. Tune by lowering survivor counts (not by lowering concurrency, which kills the per-ticker latency benefit). Document the tuned numbers honestly in the PR description.

The other temptation is to skip Stage 1's volatility filter ("lower vol gets higher Stage-1 score") because it feels like throwing away good small-cap names. Don't skip it. Prophet's whole identity is "stable-trending names with positive catalyst tailwinds." If the user wants chaotic small-caps, that's a different board entirely. The volatility filter is honest about Prophet's strategy.

Final note on the user-facing strip: the `2037 → 412 → 87 → 23` ladder is the user's only window into whether the sieve is working as intended. Make it readable, make it honest, do not hide it. If a stage stamps `partial: true`, the strip turns amber and reads `2037 → 412 → 87 → 23 (PARTIAL — Stage 3 budget exceeded)`. That's the contract. Ship it.
