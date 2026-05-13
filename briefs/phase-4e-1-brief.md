# Phase 4e-1 — Prophet Portfolio: engine + backtest validation

**Author:** orchestrator
**Target version:** `0.17.0-alpha` (only if backtest validates the rule; else `0.16.x` patch with the engine landed but live manager disabled)
**Dependencies:** Phase 1 (snapshots), Phase 3 (point-in-time data), Phase 4a (backtest engine — load-bearing here), Phase 4c-1/4c-2 merged.
**Status when this brief is written:** `main` = `1d7c9aa`, APP_VERSION = `0.16.0-alpha`, MODEL_VERSION = `2026.02.0`, 446 tests.
**Parallel-with:** Phase 5a. Zero file overlap — 5a touches `reports/phase-5a/` (Python), 4e-1 touches `netlify/functions/shared/prophet-portfolio/` + `netlify/functions/scan-prophet-portfolio-rebalance.ts`.

---

## Why this exists

Chad's product direction 2026-05-13: *"if we can't design something that beats the S&P, what's the point."* The right answer to that test is a self-managing 10-stock paper portfolio that lives in production and gets benchmarked against SPY in real time, with the picking signal coming from the Prophet engine.

Phase 4e-1 builds the engine and validates the rebalance rule over historical data before any live deployment. If the simple rule "weekly rebalance to top-10-composite from Prophet largecap" doesn't beat SPY in-sample over 2018–2026, we don't ship a live manager — we iterate on the rule.

Phase 4e-2 (separate brief, follows 4e-1) builds the UI tab once the engine has real decision history to render.

---

## What "beats SPY" actually means here

This is the contract the engine is held to. Stated explicitly so there's no goalpost-moving:

- **Total return on the portfolio** (price changes + simulated dividends + cash) over the test window
- **vs SPY total return** over the same window (price + SPY dividends)
- **After realistic costs**: 10 bps slippage per side on entries/exits, $0 commission (matches Chad's actual broker; not Robinhood-fee).
- **Net of style-factor effects**: also report return relative to QQQ (large-cap growth) and IWF (Russell 1000 growth). If the portfolio "beats SPY" purely by tilting growth, that's not alpha — it's a factor exposure. The portfolio must beat all three benchmarks meaningfully, or beat SPY by significantly more than QQQ does.
- **Rolling 1-year windows**: the start date isn't allowed to be cherry-picked. Report rolling 1-year returns vs SPY at every rebalance start.
- **Risk-adjusted**: Sharpe ratio (using risk-free rate from FRED), max drawdown, longest underwater stretch.

The bar isn't "beats SPY in one cherry-picked window" — it's "beats SPY across rolling windows on a risk-adjusted basis after costs." That's the orchestrator's gate before we recommend deploying to production.

---

## Operational context

- Repo: `DavisDelivery/TradeIQ`
- Netlify site: `tradeiq-alpha.netlify.app`
- Firebase project: `tradeiq-alpha`
- `GITHUB_PAT`: `<read-only-PAT, provided per session>` — Chad provides write-scoped PAT per session.
- Polygon + Finnhub + Quiver + FRED keys: already in Netlify env.
- Conventions:
  - APP_VERSION bumps only if the live manager ships in this PR. If the backtest disqualifies the simple rule, the engine lands as dormant code (no scheduled function active) and APP_VERSION holds.
  - MODEL_VERSION does NOT change in this phase. Scoring math is unchanged.
  - Mobile-first remains the rule but no UI is built here. 4e-2 handles UI.
  - `tsc --noEmit`, `npm test`, `npm run build` clean before PR.
  - Backtest report committed to `reports/phase-4e-1/backtest-validation.md` with raw numbers; not in `dist/`.

---

## W0 — Preconditions

1. `git fetch origin && git log --oneline -3 origin/main` — confirm `1d7c9aa` or later.
2. `npm ci && npm test` — confirm 446 tests passing as baseline.
3. `npm run build` — confirm clean.
4. Read `netlify/functions/shared/backtest/engine.ts`, `portfolio.ts`, `walk-forward.ts`, `score-at-date.ts`, `metrics.ts`, `costs.ts`. The backtest engine is the load-bearing piece — 4e-1's validation step delegates entirely to it, configured for the portfolio rebalance rule. If you don't understand `engine.ts`, stop and read until you do.
5. Read `netlify/functions/shared/snapshot-store.ts` and how the per-board freshness budgets work. Portfolio state lives in a separate Firestore collection but the engine reads snapshots for scoring.
6. Read `briefs/phase-4c-2-brief.md` for the sieve architecture's "earnings-quality gate" — the rebalance rule MUST respect the gate (don't swap into a fundamental-failing pick even if the composite ranks it top-10).

---

## The rebalance rule (v1 — to be validated)

This is the rule the executor will encode and the backtest will judge. It's deliberately simple. If the simple version beats SPY, ship it. If it doesn't, the data will tell us what's wrong before any new complexity is layered on.

```
On each rebalance day at market close:
  1. Read latest Prophet largecap snapshot (composite ≥ minComposite, all 7 layers pass).
  2. Filter to picks where layerFundamental.pass = true (earnings-quality gate must pass).
  3. Rank by composite descending; take top 15 as candidates.
  4. From candidates, build target portfolio of 10 names:
      - Drop current holdings that are no longer in candidates AND have held >= 30 days.
      - Add new candidates not in holdings, up to bring total to 10.
      - Equal-weight (10% per position).
      - Hard cap: max 3 swaps per rebalance (limits turnover).
      - Sector cap: no more than 4 positions in same sector.
  5. Execute trades next-open with 10 bps slippage per side; record in swap log.
  6. Mark portfolio to next-close price.

Cadence: weekly. Decision Monday close, execution Tuesday open.

Initial capital: $100,000. Equal-weighted across initial 10 picks at day 1.
```

**Rule constraints worth defending:**

- **30-day minimum hold** prevents short-horizon flip-flops on noise. The engine should NOT swap a name out just because it dropped to rank 11 in next week's snapshot.
- **Max 3 swaps per rebalance** caps turnover at ~30% per week → roughly 1500% annual turnover at the extreme. Realistic for active strategy; SPY's natural turnover is ~3%/year for comparison.
- **Sector cap 4** prevents the portfolio from becoming 8x semiconductors when the layerCatalyst sector_rank converges everyone there.
- **Earnings gate enforcement** means a ticker that rises to composite-rank-1 on pure momentum but fails the earnings gate (Phase 4c-2) is NOT added. This honors Chad's product direction — the portfolio is earnings-first by construction, not by accident.

If the backtest validates this rule, ship it. If it doesn't, the executor produces a "why it failed" analysis in the findings report (e.g., "lost to SPY because of the 30-day min hold preventing exits ahead of earnings disappointments — proposed v2: hard exit on layerFundamental.pass = false regardless of hold timer").

---

## W1 — Portfolio state schema

**Files:** `netlify/functions/shared/prophet-portfolio/state.ts`

Firestore collection layout:

```
prophetPortfolio/
  largecap/
    config/
      current: { startDate, startCapital, positionCount, minHoldDays, maxSwapsPerRebalance, sectorCap, slippageBps, version }
    state/
      current: {
        asOfDate: "YYYY-MM-DD",
        cash: number,
        equity: number,                            // cash + sum(positions.marketValue)
        positions: Array<{ ticker, shares, entryDate, entryPrice, currentPrice, marketValue, weight }>,
        lastRebalanceAt: ISO timestamp,
        updatedAt: server timestamp
      }
    swaps/
      {YYYY-MM-DD-HHmm}: {
        timestamp,
        out: Array<{ ticker, shares, exitPrice, holdDays, totalReturnPct, reasonCode }>,
        in:  Array<{ ticker, shares, entryPrice, candidateRank, composite, fundamentalScore }>,
        candidatesConsidered: number,
        swapsApplied: number,
        snapshotId: string,
        notes: string
      }
    equityCurve/
      {YYYY-MM-DD}: { date, equity, cash, holdingsValue, dailyReturn, spyClose, qqqClose, iwfClose }
    decisionLog/
      {ticker}_{YYYY-MM-DD}: {
        decisionDate, ticker, action, composite, layers, regime, sieveStage,
        forwardReturn30d, forwardReturn60d, forwardReturn90d   ← lagged-populated
      }
```

State module surface area:

```ts
export interface PortfolioState { ... }     // matches Firestore state.current shape
export interface SwapEvent { ... }
export interface PortfolioConfig { ... }

export async function getPortfolioState(universe: 'largecap' | 'all'): Promise<PortfolioState | null>;
export async function writePortfolioState(universe, state): Promise<void>;
export async function recordSwap(universe, event): Promise<string>;  // returns swapId
export async function appendEquityCurvePoint(universe, point): Promise<void>;
export async function listRecentSwaps(universe, limit): Promise<SwapEvent[]>;
```

Two universes initially: `largecap` (S&P 500 + NDX + Dow ~230) and `russell2k`. Start with `largecap` only; russell2k wired in 4e-2 once the largecap version proves out.

**Tests** in `__tests__/state.test.ts`: round-trip read/write with Firestore mock; numeric precision preservation on shares + prices; swap event ordering by timestamp.

---

## W2 — Pluggable ranking signal interface

**Files:** `netlify/functions/shared/prophet-portfolio/signal.ts`

The whole point of the parallel-with-5a setup. 4e-1 uses Prophet composite by default. When Phase 5a delivers a winning ML model, an alternative implementation plugs into this interface without touching the rebalance logic.

```ts
export interface RankingSignal {
  /** Stable name for telemetry + decisionLog stamping. */
  readonly id: string;

  /**
   * Return top-N candidates at a given as-of date, with composite-equivalent
   * 0-100 scores and the universe of layers used. Walks the existing
   * snapshot store for the date in question (or live for cron-driven calls).
   */
  rankAtDate(opts: {
    universe: 'largecap' | 'russell2k';
    asOfDate: string;
    topN: number;
    minComposite?: number;
  }): Promise<RankingResult[]>;
}

export interface RankingResult {
  ticker: string;
  name: string;
  sector: string;
  composite: number;
  layers: Record<string, { score: number; pass: boolean }>;
  fundamentalPass: boolean;
  regime: 'risk_on' | 'risk_off' | 'neutral';
  // Mark for downstream `decisionLog` so we can correlate ML training rows
  // with the signal used at decision time.
  signalId: string;
}

export const compositeRankingSignal: RankingSignal = {
  id: 'composite-v1',
  rankAtDate: async (opts) => { /* reads from snapshot-store */ },
};
```

When 5a delivers, executor agent for 5b creates `mlRankingSignal` exporting the same interface. The rebalance function takes a `signal: RankingSignal` parameter and runs unchanged. Zero refactor cost.

**Tests** in `__tests__/signal.test.ts`: composite signal returns top-N respecting `fundamentalPass` filter; honors `minComposite` cutoff; signalId stamped correctly.

---

## W3 — Rebalance decision logic

**Files:** `netlify/functions/shared/prophet-portfolio/rebalance.ts`

Pure function. No I/O. Inputs: current state, ranking results, config. Output: list of trades + metadata.

```ts
export interface RebalanceDecision {
  out: Array<{ ticker: string; shares: number; reason: 'fell_out_of_top_N' | 'fundamental_fail' | 'sector_cap_breach' | 'forced_exit' }>;
  in: Array<{ ticker: string; targetWeight: number; rank: number; composite: number }>;
  holds: Array<{ ticker: string; reason: 'still_top_N' | 'min_hold_active' | 'still_in_universe' }>;
  notes: string[];
}

export function decideRebalance(
  state: PortfolioState,
  candidates: RankingResult[],
  config: PortfolioConfig,
  asOfDate: string,
): RebalanceDecision;
```

Logic, in order:

1. **Forced exits first** — any holding where `fundamentalPass === false` in latest snapshot AND held >= 30 days is added to `out` regardless of min-hold (Phase 4c-2 gate breach is a quality signal change, not a noise event).
2. **Drop-outs** — holdings that have held >= 30 days AND are not in current top-15 candidates are exit candidates. Rank exits by how far they've fallen (rank 16 first, rank 30 last).
3. **Compute swap budget** — at most `maxSwapsPerRebalance` (3) net exits this rebalance.
4. **Pick additions** — top-ranked candidates not currently held, respecting:
   - Sector cap (max 4 per sector across portfolio)
   - Earnings gate (`fundamentalPass === true`)
   - Equal-weight target (10% per position; cash sleeve allowed if < 10 positions can be filled)
5. **Hold** everything else.

Pure function, fully unit-testable.

**Tests** in `__tests__/rebalance.test.ts`:
- Empty state → 10 buys, 0 sells, equal weight
- Top-1 holding drops to rank 11 with < 30 days hold → stays
- Top-1 holding drops to rank 11 with >= 30 days hold → exits
- Holding fails earnings gate → forced exit even with min-hold active
- 5 fundamentals-failing holdings → only 3 forced exits per swap budget; warning logged
- Sector cap: candidate would violate 4-per-sector → skip, take next
- Fewer than 10 valid candidates → cash sleeve held; no forced fills

---

## W4 — Backtest validation harness

**Files:** `netlify/functions/shared/prophet-portfolio/backtest-harness.ts` + `reports/phase-4e-1/backtest-validation.md` (output)

This is the load-bearing piece for the "must beat SPY" test. Wraps the existing `runBacktest` engine with portfolio-specific config + the new rebalance rule, then runs across multiple windows.

```ts
export interface PortfolioBacktestResult {
  windowLabel: string;        // "2018-2022", "2022-2026", "rolling-2020-01"
  startDate: string;
  endDate: string;
  portfolioReturnPct: number;
  spyReturnPct: number;
  qqqReturnPct: number;
  iwfReturnPct: number;
  excessReturnPct: number;    // portfolio - SPY
  sharpe: number;
  spySharpe: number;
  maxDDPct: number;
  spyMaxDDPct: number;
  longestUnderwaterDays: number;
  swapCount: number;
  avgHoldDays: number;
  turnoverPct: number;
  costDragPct: number;        // total slippage drag
}

export async function runPortfolioBacktest(config: PortfolioConfig, window: { start: string; end: string }): Promise<PortfolioBacktestResult>;
```

Windows to run:
- **Full window** 2018-01-01 → 2026-01-01 (one number)
- **Half windows** 2018-2022, 2022-2026 (regime resilience)
- **Rolling 1-year windows** start every January 2018 through 2025 (variability)
- **Stress window** 2020-02-01 → 2020-09-01 (COVID crash + recovery)
- **Stress window** 2022-01-01 → 2022-12-31 (rate-hike bear)

The harness uses the same `runBacktest` engine that ships today. Configure it with:
```
rebalanceFrequency: 'weekly'
portfolio.topN: 10
portfolio.weighting: 'equal'
portfolio.minComposite: 50
portfolio.maxPositionPct: 0.10
portfolio.maxSectorPct: 0.40
portfolio.cashSleeve: 0.00
costs.slippageBps.{universe}: 10
costs.commission: 0
initialCapital: 100_000
```

PIT data layer (Phase 3) ensures snapshots used for ranking at each rebalance date were available at that date — no lookahead. SPY/QQQ/IWF total returns computed from Polygon bars + dividend data.

**Output**: `reports/phase-4e-1/backtest-validation.md` with all numbers in a table, plus a written verdict at the top. Template:

```markdown
# Phase 4e-1 — Backtest Validation Findings

**Verdict:** SHIP / DON'T SHIP / SHIP WITH CAVEATS

[2-3 sentences explaining the call.]

## Summary table
| Window | Port % | SPY % | Excess | Sharpe | Port DD | SPY DD | Swaps |
|---|---|---|---|---|---|---|---|
| 2018-2026 | ... | ... | ... | ... | ... | ... | ... |
[etc]

## Rolling 1-year windows
[Chart or table; 8-10 starting points]

## Stress windows
[COVID, 2022 rate hikes]

## Style-factor decomposition
- vs SPY: ...
- vs QQQ: ...
- vs IWF: ...

## What broke (if anything)
[Honest assessment]

## Recommendation
[Ship live manager? Hold engine dormant? Iterate on rules?]
```

**The verdict line is binding.** If the executor agent writes "SHIP" but the numbers don't support it (excess return < 0 in majority of rolling windows), Chad pushes back and the brief loops to revise the rule.

---

## W5 — Live rebalance scheduled function (conditional)

**Files:** `netlify/functions/scan-prophet-portfolio-rebalance.ts`

ONLY built if backtest verdict is SHIP or SHIP WITH CAVEATS. If DON'T SHIP, this file is not created and the PR lands the engine modules + backtest findings without a scheduled function.

Schedule: `0 21 * * 2` (Tuesday at 21:00 UTC = ~4 PM ET — after-hours, but the function uses Monday close prices and simulates Tuesday open execution).

Function body, briefly:
1. Read current portfolio state.
2. Resolve `RankingSignal` (default: compositeRankingSignal).
3. Get candidates at Monday close.
4. Run `decideRebalance` to produce trades.
5. Apply slippage, update positions, recompute cash.
6. Write new state, swap event, decisionLog rows.
7. Append equity curve point with same-day SPY/QQQ/IWF closes.

`-background.ts` suffix? NO — this runs in seconds, not minutes. Standard 26s function is fine; bump timeout to 60s if needed for snapshot reads.

**Tests** in `__tests__/scan-prophet-portfolio-rebalance.test.ts`: end-to-end with mocked Firestore + snapshot store + Polygon prices. Verify state transitions are atomic; partial failure (Firestore write fails mid-update) doesn't leave the portfolio in an inconsistent state.

---

## W6 — Daily mark-to-market scheduled function

**Files:** `netlify/functions/scan-prophet-portfolio-mtm.ts`

Schedule: `0 21 * * 1-5` — every weekday at 21:00 UTC (after close). Refreshes:
- Current price for each holding
- `marketValue`, `weight`, `equity`
- Daily SPY/QQQ/IWF closes
- One new `equityCurve/{date}` doc

Cheap function (5-10s typical). Standard 26s timeout.

Stays active even when the rebalance function is gated on backtest verdict — we want the equity curve populated continuously regardless of swap activity.

---

## W7 — Read endpoint for the UI (4e-2 will consume)

**Files:** `netlify/functions/prophet-portfolio.ts`

```
GET /api/prophet-portfolio?universe=largecap
```

Response shape:
```json
{
  ok: true,
  universe: "largecap",
  state: { ... portfolio state ... },
  swaps: [ ... last 20 swaps ... ],
  equityCurve: [ ... last 252 days ... ],     // 1Y rolling window
  metrics: {
    sinceInception: { portfolioReturnPct, spyReturnPct, excessReturnPct, sharpe, maxDDPct },
    ytd: { ... same shape ... },
    last1y: { ... same shape ... },
  }
}
```

Snapshot-first reads; computes metrics on-the-fly from equityCurve (cached for 5 min in-memory).

Add to `netlify.toml`:
```toml
[[redirects]]
  from = "/api/prophet-portfolio"
  to = "/.netlify/functions/prophet-portfolio"
  status = 200
```

**Tests** in `__tests__/prophet-portfolio.test.ts`: empty state returns ok:true with empty arrays; full state returns metrics consistent with curve.

---

## W8 — Decision log row writer (ML loop seed)

**Files:** integrated into `rebalance.ts` and `scan-prophet-portfolio-rebalance.ts`.

Every rebalance writes one `decisionLog/{ticker}_{YYYY-MM-DD}` row per decision (buy/hold/sell). Features captured:
- composite, layers (all 7 with scores + pass), regime, sieveStage (if from russell)
- All earnings signals (epsGrowthYoY, op/gross margin trend pp, multiple expansion, beats)
- The signalId that made the call (`composite-v1` initially)
- Action taken: ADD / EXIT / HOLD_IN / HOLD_OUT

Forward return labels (`forwardReturn30d`, `60d`, `90d`) are populated by a lagged-update function — a separate scheduled job at `0 21 * * *` that scans decisionLog for rows N-days old and fills in the return from the entry-to-now price. Phase 5c will consume these labels for retraining.

This is the data substrate Phase 5c (monitoring + retraining cadence) depends on. Ship the writer in 4e-1 even though no one reads it yet — every day we delay starts another month of missing training data.

---

## W9 — Version + ORCHESTRATOR + PR description

- `APP_VERSION`: bump to `0.17.0-alpha` ONLY if live rebalance ships (W5 active). If verdict is DON'T SHIP and W5 is skipped, hold at `0.16.x` and add a patch version (e.g. `0.16.1-alpha`) for the engine landing.
- `ORCHESTRATOR.md`:
  - 4e-1 row: `done`, summarize verdict + key backtest numbers.
  - Add 4e-2 row as `pending (no brief yet)`.
  - If verdict is DON'T SHIP, add a `4e-1-fix` row capturing the rule revision plan.
- PR description in `briefs/phase-4e-1-pr-description.md`. Include the backtest verdict prominently — Chad needs to see it without scrolling.

---

## Verification

1. `npx tsc --noEmit` — clean.
2. `npm test` — passing, ≥ 446 + (10-15 new) = ≥ 460.
3. `npm run build` — clean.
4. Backtest harness run end-to-end on the agent's bash terminal:
   ```bash
   npx tsx scripts/run-portfolio-backtest.ts --window full
   ```
   Output report committed to `reports/phase-4e-1/backtest-validation.md`.
5. If shipping live: smoke test on deploy preview:
   - `curl /api/prophet-portfolio?universe=largecap` returns 200 with empty state pre-cron.
   - Manually trigger the rebalance function via the agent's bash to seed the first state (Polygon Monday close prices).
   - Re-curl the endpoint; confirm state populated with 10 holdings, swap event recorded, decisionLog populated.

---

## Out of scope (explicitly)

- **UI tab.** That's Phase 4e-2. Engine ships dormant if no UI yet — readable via the API endpoint only.
- **Real money.** Paper portfolio only. The word "live" in this brief means "writes to Firestore on a real schedule," NOT "places orders at a broker." If anyone considers wiring Alpaca/IBKR, that's its own brief with much higher safety bar.
- **Multiple portfolios.** One largecap portfolio in 4e-1. Russell, "all", and multi-strategy portfolios are 4e-2 or 4f.
- **ML retraining.** decisionLog writer ships here but the consumer (retrain loop) is Phase 5c.
- **Tax-aware swaps, wash-sale rules.** Out — this is paper, no tax implications.
- **Short side.** Long-only, by Prophet's design. A short portfolio is Phase 11 territory.
- **Live performance tracking visible to other users.** Single-user app; no multi-tenant concerns.

---

## Files target

```
netlify/functions/shared/prophet-portfolio/state.ts                  NEW   ~150
netlify/functions/shared/prophet-portfolio/signal.ts                 NEW   ~80
netlify/functions/shared/prophet-portfolio/rebalance.ts              NEW   ~200
netlify/functions/shared/prophet-portfolio/backtest-harness.ts       NEW   ~180
netlify/functions/shared/prophet-portfolio/types.ts                  NEW   ~60
netlify/functions/shared/prophet-portfolio/__tests__/state.test.ts            NEW   ~120
netlify/functions/shared/prophet-portfolio/__tests__/signal.test.ts           NEW   ~80
netlify/functions/shared/prophet-portfolio/__tests__/rebalance.test.ts        NEW   ~200
netlify/functions/shared/prophet-portfolio/__tests__/backtest-harness.test.ts NEW   ~120
netlify/functions/prophet-portfolio.ts                               NEW   ~100
netlify/functions/__tests__/prophet-portfolio.test.ts                NEW   ~100
netlify/functions/scan-prophet-portfolio-rebalance.ts                NEW (conditional)  ~120
netlify/functions/scan-prophet-portfolio-mtm.ts                      NEW   ~80
netlify/functions/scan-prophet-portfolio-fwd-returns.ts              NEW   ~80
scripts/run-portfolio-backtest.ts                                    NEW   ~50
reports/phase-4e-1/backtest-validation.md                            NEW (the verdict)
netlify.toml                                                         edit  ~6 lines
src/lib/validateResponse.js                                          edit  add portfolio shape
src/App.jsx                                                          edit  APP_VERSION (conditional)
ORCHESTRATOR.md                                                      edit  4e-1 row + 4e-2 placeholder
briefs/phase-4e-1-pr-description.md                                  NEW
```

~20 files, ~1800 lines net plus a backtest report. Mid-large PR. The backtest report is small but it's the highest-information artifact in the whole PR.

---

## Note to the executing agent

The temptation on this brief is to over-engineer the rule before the simple version is tested. Don't. Build the rule exactly as specified (W3), run the validation (W4), and let the data tell you whether you have alpha or just complexity. If the simple rule beats SPY across the rolling windows, ship it; if not, write up exactly what broke and propose a specific revision in the findings report. Don't shotgun ten variants hoping one survives — that's overfitting via search.

Second temptation: skipping the style-factor decomposition because "beats SPY" alone looks impressive. Don't. A growth-tilted portfolio of large-cap names will beat SPY in any decade that QQQ does, and that's not alpha — it's a factor exposure. Chad's product test is about real edge. Be honest in the findings; the QQQ and IWF comparisons are non-negotiable line items.

Third temptation: deferring the decisionLog writer (W8) because "5c isn't started yet." Don't. Every day without that writer is another day of training data that doesn't exist. Land it dormant if you must but land it.

The "ship live manager or not" verdict in `backtest-validation.md` is the single most important output of this PR. Write it with the same rigor a portfolio manager would write a strategy approval memo. The numbers either support the conclusion or they don't.
