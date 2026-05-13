# Phase 4e-1 Executor Kickoff — Prophet Portfolio (Engine + Backtest Validation)

> **For Chad:** paste this entire file as the opening message of a new
> Claude conversation. In your follow-up message, send the write-scoped
> GitHub PAT. The agent has everything else it needs after that.
>
> This kickoff is fully self-contained: cold-start commands, repo
> orientation, conventions, the complete Phase 4e-1 brief embedded
> inline, code shape templates, verdict rules, PR commands, smoke test
> commands, hand-off format, and failure modes.

---

You are an executor agent. Your single assignment is **Phase 4e-1 —
Prophet Portfolio: engine + backtest validation** for the TradeIQ
project. The conversation you're reading right now is your complete
boot prompt. Do not ask Chad to explain TradeIQ or re-summarize
anything below — read end-to-end, then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. The Prophet board scores tickers
across 7 layers (structure, momentum, volume, volatility, relative
strength, fundamental, catalyst), composites them via a hand-tuned
weighted sum (fundamental 25%, catalyst 30%, others 45%), and surfaces
top candidates with AI theses. The system runs scheduled scans, writes
snapshots to Firestore, serves them via Netlify functions to a
single-file React SPA. Owner: Chad Davis. Stack: TypeScript Netlify
functions + React 18 / Vite SPA + Firestore + Polygon / Finnhub /
Quiver / FRED data providers + Anthropic Claude Opus 4.7 for narration.
Phases ship incrementally and merge into `main` after Chad reviews.

## Your assignment in two sentences

Build a paper-portfolio engine that uses Prophet's scoring to manage a
10-stock portfolio with weekly rebalancing, then **prove via backtest
that the rule beats SPY** (after costs, after style-factor adjustment,
across rolling 1-year windows) before any live scheduled function
ships. The verdict in `reports/phase-4e-1/backtest-validation.md` is
**binding**: if the simple rule doesn't survive the test, the engine
lands dormant pending a rule revision in a future phase.

---

# PART 1 — COLD START

## 1.1 Boot commands (literal, in order)

```bash
# Working directory
mkdir -p /home/claude && cd /home/claude

# Clone (Chad will give you a write-scoped PAT in his next message;
# substitute it for <PAT> below)
git clone https://<PAT>@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ

# Confirm you landed on a current commit. The kickoff was written
# against main at the SHA committed alongside this file in the repo.
# Newer is fine; if commits are missing, stop and surface to Chad.
git log --oneline -6
# Expected to include (in some order, top of list):
#   briefs: 4e-1 add data-quality precondition + ORCHESTRATOR Phase 4f
#   kickoffs: rewrite at depth — concrete commands, repo orientation, secrets handling
#   kickoffs: executor boot prompts for 4e-1 and 5a
#   briefs: 4e-1 — Prophet Portfolio engine + backtest validation
#   1d7c9aa Phase 4c-2 — Russell sieve + earnings-priority Prophet (#20)
#   ffcc5d3 Phase 4c-1 — Prophet detail completeness + EPS bug (#19)

# Identity for your commits
git config user.email "executor-4e1@tradeiq.local"
git config user.name "Executor 4e-1"

# Install + verify baseline. THESE NUMBERS ARE GROUND TRUTH:
npm ci
npx tsc --noEmit             # must be clean (no output)
npm test                     # must report: Tests 446 passed (446)
npm run build                # must complete cleanly; the ">500 kB chunk" warning is expected

# Create your branch
git checkout -b phase-4e-1-portfolio-engine
```

If any of the above fails or produces unexpected numbers, STOP and
report to Chad with the exact output. Don't proceed on a poisoned
baseline.

## 1.2 Secrets handling

Chad provides the write-scoped GitHub PAT in his next message. Use it
ONLY for:
- The `git clone` command above (substitute into the URL)
- `git push origin phase-4e-1-portfolio-engine`
- The GitHub-API PR-open `curl` command in PART 6

Never write the PAT to any file in the repo. Never commit it. Never
print it to logs.

You will NOT need:
- Firebase service account JSON (the backtest harness uses test
  fixtures, not live Firestore)
- Polygon / Finnhub / Quiver / Anthropic keys (none of your work
  requires live data provider calls)

If you find yourself thinking "I need to hit live Firestore to verify
something" — stop, write the question concisely, ask Chad. Don't
request the SA key speculatively.

---

# PART 2 — REPO ORIENTATION

## 2.1 Directory map

```
TradeIQ/
├── briefs/                          ← phase specs
│   ├── phase-4e-1-brief.md          ← embedded below in PART 3 (also on disk)
│   ├── phase-5a-brief.md            ← 5a (parallel agent's work; don't touch)
│   ├── phase-4c-1-brief.md          ← reference for executor style
│   ├── phase-4c-2-brief.md          ← reference; also has earnings-quality gate spec
│   └── phase-4e-1-pr-description.md ← YOU WRITE THIS at end (W9)
├── kickoffs/
│   └── phase-4e-1-executor.md       ← this file
├── reports/
│   └── phase-4e-1/                  ← YOU CREATE
│       └── backtest-validation.md   ← THE BINDING VERDICT lives here
├── netlify/
│   ├── functions/
│   │   ├── *.ts                     ← HTTP endpoints (GET /api/<name>)
│   │   ├── scan-*.ts                ← scheduled functions (cron-driven)
│   │   ├── run-*-background.ts      ← long-running (15-min container)
│   │   ├── shared/                  ← reusable modules
│   │   │   ├── backtest/            ← Phase 4a engine — LEVERAGE, don't fork
│   │   │   │   ├── engine.ts        ← read first
│   │   │   │   ├── portfolio.ts     ← top-N + sector caps (your W3 mirrors this)
│   │   │   │   ├── walk-forward.ts  ← rebalance-date iterator
│   │   │   │   ├── score-at-date.ts ← PIT scoring of one ticker
│   │   │   │   ├── metrics.ts       ← Sharpe, max DD, etc.
│   │   │   │   ├── costs.ts         ← slippage modeling
│   │   │   │   └── __tests__/
│   │   │   ├── prophet-sieve/       ← Phase 4c-2 — DO NOT TOUCH
│   │   │   ├── prophet-portfolio/   ← NEW — YOUR WORK LIVES HERE
│   │   │   │   ├── types.ts         ← YOU CREATE (W1)
│   │   │   │   ├── state.ts         ← YOU CREATE (W1)
│   │   │   │   ├── signal.ts        ← YOU CREATE (W2)
│   │   │   │   ├── rebalance.ts     ← YOU CREATE (W3)
│   │   │   │   ├── backtest-harness.ts  ← YOU CREATE (W4)
│   │   │   │   └── __tests__/       ← YOU CREATE
│   │   │   ├── snapshot-store.ts    ← read for snapshot-fetch patterns
│   │   │   ├── prophet-layers.ts    ← DO NOT MODIFY; read layerFundamental + computeEarningsQualityGate
│   │   │   ├── earnings-intel.ts    ← DO NOT MODIFY
│   │   │   ├── data-provider.ts     ← DO NOT MODIFY; read getDailyBars signature
│   │   │   ├── narrative-generator.ts ← DO NOT MODIFY
│   │   │   ├── firebase-admin.ts    ← reference for Firestore patterns
│   │   │   └── __tests__/
│   │   ├── prophet-portfolio.ts     ← YOU CREATE (W7) — GET /api/prophet-portfolio
│   │   ├── scan-prophet-portfolio-rebalance.ts ← YOU CREATE (W5, CONDITIONAL on verdict)
│   │   ├── scan-prophet-portfolio-mtm.ts        ← YOU CREATE (W6)
│   │   ├── scan-prophet-portfolio-fwd-returns.ts ← YOU CREATE (W8)
│   │   └── __tests__/               ← endpoint-level tests
├── src/
│   ├── App.jsx                      ← edit APP_VERSION conditionally (W9)
│   ├── lib/validateResponse.js      ← edit: add portfolio response shape
│   └── (do not touch anything else)
├── scripts/
│   └── run-portfolio-backtest.ts    ← YOU CREATE (W4)
├── netlify.toml                     ← edit: add 1 redirect (W7)
├── package.json                     ← do not modify
├── tsconfig.json                    ← do not modify
├── vitest.config.ts                 ← do not modify
├── ORCHESTRATOR.md                  ← edit at end (W9): mark 4e-1 row done
└── HANDOFF.md                       ← orchestrator handoff (ignore)
```

## 2.2 Files you ARE allowed to touch

Creating:
- `netlify/functions/shared/prophet-portfolio/types.ts`
- `netlify/functions/shared/prophet-portfolio/state.ts`
- `netlify/functions/shared/prophet-portfolio/signal.ts`
- `netlify/functions/shared/prophet-portfolio/rebalance.ts`
- `netlify/functions/shared/prophet-portfolio/backtest-harness.ts`
- `netlify/functions/shared/prophet-portfolio/__tests__/*.test.ts`
- `netlify/functions/prophet-portfolio.ts`
- `netlify/functions/scan-prophet-portfolio-rebalance.ts` (CONDITIONAL on verdict)
- `netlify/functions/scan-prophet-portfolio-mtm.ts`
- `netlify/functions/scan-prophet-portfolio-fwd-returns.ts`
- `netlify/functions/__tests__/prophet-portfolio.test.ts`
- `scripts/run-portfolio-backtest.ts`
- `reports/phase-4e-1/backtest-validation.md`
- `briefs/phase-4e-1-pr-description.md`

Editing:
- `netlify.toml` (one redirect addition)
- `src/lib/validateResponse.js` (one shape addition)
- `src/App.jsx` (APP_VERSION bump, conditional on verdict)
- `ORCHESTRATOR.md` (mark 4e-1 row done at end)

## 2.3 Files you may NOT touch (PR will be rejected)

- Anything under `netlify/functions/shared/prophet-sieve/`
- Anything under `netlify/functions/shared/backtest/` (read-only; reuse,
  don't fork)
- `netlify/functions/shared/prophet-layers.ts`
- `netlify/functions/shared/earnings-intel.ts`
- `netlify/functions/shared/narrative-generator.ts`
- `netlify/functions/shared/snapshot-store.ts` (read only; if you need
  a new query helper, ask Chad rather than adding it speculatively)
- Any `*-board.ts` or `scan-*.ts` not in your "creating" list
- Any `*View.jsx` (UI is Phase 4e-2's territory; you ship no UI)
- Any `*.py` file, `reports/phase-5a/`, or `scripts/ml/` (Phase 5a's
  parallel territory)

---

# PART 3 — THE BRIEF (verbatim)

The rest of this part is the contents of `briefs/phase-4e-1-brief.md`
verbatim. Treat it as the spec. If anything below conflicts with PART
1/2 or PART 4-9, the brief wins. If anything is ambiguous in the brief,
ask Chad with one specific question and two concrete options.

═══════════════════════════════════════════════════════════════════════
BEGIN BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

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
7. **Stub-layer audit (added 2026-05-13 per Chad's screenshot of the ON ticker showing 5 of 10 Target analysts returning exactly 50).** Before running the backtest, sample a representative set of recent Prophet snapshots (largecap, last 90 days) and for each of the 7 layers (`structure`, `momentum`, `volume`, `volatility`, `relativeStrength`, `fundamental`, `catalyst`) compute:
   - % of (asOfDate, ticker) rows where `layer.score === 50` exactly
   - % where `layer.score === 0` or `layer.pass === false` for a "no data" reason
   - Mean and standard deviation of `layer.score` across the sample
   A layer is considered "live" if its score has stdev > 5 and ≤ 25% of rows are exactly 50. A layer that fails this is "stub-returning" — defaulting to a neutral midpoint instead of computing real values.

   Output the audit table verbatim into `reports/phase-4e-1/backtest-validation.md` under a new section `## 0. Layer activity audit (run before backtest)`. The table goes BEFORE the verdict so a reader can see what the rule was actually built on.

   **If ≥ 1 layer is stub-returning, the backtest harness must run TWO scenarios:**
   - **Scenario A (as-is):** composite computed with all 7 layers including stubs. This is what the live system currently produces.
   - **Scenario B (active-only):** composite recomputed using only live layers, with the stub layers' weight redistributed proportionally across the live ones. This isolates whether the strategy works on the *information that's actually present*.
   - Both scenarios run the full validation window set. The headline verdict compares both, e.g. *"Scenario A beats SPY in 6/8 rolling windows; Scenario B beats SPY in 7/8. Stub layers (X, Y) are not adding edge."*

   The verdict in `reports/phase-4e-1/backtest-validation.md` opens with a one-line statement of how many layers are live vs stub. If 0 layers are stub, omit Scenario B and note "all 7 layers active" — short circuit is allowed but the audit table is not skippable.

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

═══════════════════════════════════════════════════════════════════════
END BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

---

# PART 4 — CODE SHAPE TEMPLATES

These are starter shapes anchored to existing conventions in the repo.
They are NOT complete implementations — fill bodies, add fields the
brief requires.

## 4.1 `types.ts` (W1 — start here)

```ts
// netlify/functions/shared/prophet-portfolio/types.ts
// Shared types — keep dependency-light, no I/O imports.

export type PortfolioUniverse = 'largecap' | 'russell2k';

export interface PortfolioPosition {
  ticker: string;
  shares: number;
  entryDate: string;        // 'YYYY-MM-DD'
  entryPrice: number;
  currentPrice: number;
  marketValue: number;      // shares * currentPrice
  weight: number;           // marketValue / totalEquity
  sector: string;           // honored by rebalance.ts sector cap
}

export interface PortfolioState {
  universe: PortfolioUniverse;
  asOfDate: string;
  cash: number;
  equity: number;           // cash + sum(positions.marketValue)
  positions: PortfolioPosition[];
  lastRebalanceAt: string;  // ISO timestamp
  updatedAt: string;        // ISO timestamp
}

export interface PortfolioConfig {
  universe: PortfolioUniverse;
  startDate: string;
  startCapital: number;
  positionCount: number;        // 10
  minHoldDays: number;          // 30
  maxSwapsPerRebalance: number; // 3
  sectorCap: number;            // 4
  slippageBps: number;          // 10
  minComposite: number;         // 50
  candidatePool: number;        // 15
  version: string;              // 'v1'
}

export interface SwapEvent {
  swapId: string;
  timestamp: string;
  asOfDate: string;
  out: Array<{
    ticker: string;
    shares: number;
    exitPrice: number;
    holdDays: number;
    totalReturnPct: number;
    reasonCode: 'fell_out_of_top_N' | 'fundamental_fail' | 'sector_cap_breach' | 'forced_exit';
  }>;
  in: Array<{
    ticker: string;
    shares: number;
    entryPrice: number;
    candidateRank: number;
    composite: number;
    fundamentalScore: number;
  }>;
  candidatesConsidered: number;
  swapsApplied: number;
  snapshotId: string;
  notes: string;
  signalId: string;       // 'composite-v1' initially
}

export interface EquityCurvePoint {
  date: string;
  equity: number;
  cash: number;
  holdingsValue: number;
  dailyReturn: number;
  spyClose: number;
  qqqClose: number;
  iwfClose: number;
}

export interface DecisionLogRow {
  decisionDate: string;
  ticker: string;
  action: 'ADD' | 'EXIT' | 'HOLD_IN' | 'HOLD_OUT';
  composite: number;
  layers: Record<string, { score: number; pass: boolean }>;
  regime: string;
  sieveStage?: number;
  signalId: string;
  // Lagged-populated by scan-prophet-portfolio-fwd-returns.ts (W8)
  forwardReturn30d?: number;
  forwardReturn60d?: number;
  forwardReturn90d?: number;
}

// The pluggable ranking signal interface (W2)
export interface RankingSignal {
  readonly id: string;
  rankAtDate(opts: {
    universe: PortfolioUniverse;
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
  signalId: string;
}

export interface RebalanceDecision {
  out: Array<{
    ticker: string;
    shares: number;
    reason: 'fell_out_of_top_N' | 'fundamental_fail' | 'sector_cap_breach' | 'forced_exit';
  }>;
  in: Array<{
    ticker: string;
    targetWeight: number;
    rank: number;
    composite: number;
  }>;
  holds: Array<{
    ticker: string;
    reason: 'still_top_N' | 'min_hold_active' | 'still_in_universe';
  }>;
  notes: string[];
}
```

## 4.2 Firestore mock pattern (use in `__tests__/state.test.ts`)

The codebase mocks `firebase-admin` like this. Mirror it for the
`prophetPortfolio/` collection tests:

```ts
// Adapted from netlify/functions/shared/__tests__/snapshot-store-pit.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory fixture
const fakeDocs: Map<string, any> = new Map();

vi.mock('../firebase-admin', () => ({
  getAdminDb: () => ({
    collection: (top: string) => ({
      doc: (universe: string) => ({
        collection: (sub: string) => ({
          doc: (id: string) => ({
            set: async (data: any) => {
              fakeDocs.set(`${top}/${universe}/${sub}/${id}`, data);
            },
            get: async () => {
              const key = `${top}/${universe}/${sub}/${id}`;
              const data = fakeDocs.get(key);
              return {
                exists: data !== undefined,
                data: () => data,
                id,
              };
            },
          }),
          // Add stream/get/where helpers as your tests need
          where: () => ({
            orderBy: () => ({
              limit: (n: number) => ({
                get: async () => {
                  // Return docs matching the universe path
                  const prefix = `${top}/${universe}/${sub}/`;
                  const matches: Array<{ id: string; data: () => any }> = [];
                  for (const [key, value] of fakeDocs.entries()) {
                    if (key.startsWith(prefix)) {
                      matches.push({ id: key.slice(prefix.length), data: () => value });
                    }
                  }
                  return { empty: matches.length === 0, docs: matches.slice(0, n) };
                },
              }),
            }),
          }),
        }),
      }),
    }),
  }),
}));

beforeEach(() => fakeDocs.clear());

const SAMPLE_STATE = {
  universe: 'largecap' as const,
  asOfDate: '2024-01-08',
  cash: 0,
  equity: 100_000,
  positions: [
    { ticker: 'AAPL', shares: 55, entryDate: '2024-01-02', entryPrice: 180.50,
      currentPrice: 181.91, marketValue: 10_005.05, weight: 0.10, sector: 'Tech' },
    // ... 9 more
  ],
  lastRebalanceAt: '2024-01-08T21:00:00.000Z',
  updatedAt: '2024-01-08T21:00:01.234Z',
};

describe('writePortfolioState → getPortfolioState', () => {
  it('round-trips state with positions intact', async () => {
    const { writePortfolioState, getPortfolioState } = await import('../state');
    await writePortfolioState('largecap', SAMPLE_STATE);
    const got = await getPortfolioState('largecap');
    expect(got).toEqual(SAMPLE_STATE);
  });

  it('preserves numeric precision on shares + prices', async () => {
    const { writePortfolioState, getPortfolioState } = await import('../state');
    const state = {
      ...SAMPLE_STATE,
      positions: [{
        ...SAMPLE_STATE.positions[0],
        shares: 12.345678,
        entryPrice: 99.123456,
      }],
    };
    await writePortfolioState('largecap', state);
    const got = await getPortfolioState('largecap');
    expect(got?.positions[0].shares).toBe(12.345678);
    expect(got?.positions[0].entryPrice).toBe(99.123456);
  });
});
```

## 4.3 `signal.ts` — composite-v1 skeleton (W2)

```ts
// netlify/functions/shared/prophet-portfolio/signal.ts
import { latestSnapshot } from '../snapshot-store';
// If snapshotAtOrBefore doesn't exist, ask Chad before adding it. Most
// likely you can compose with existing helpers + a generatedAt filter.
import type { RankingSignal, RankingResult, PortfolioUniverse } from './types';

export const compositeRankingSignal: RankingSignal = {
  id: 'composite-v1',

  async rankAtDate({ universe, asOfDate, topN, minComposite = 50 }) {
    // For live mode (asOfDate === today), use latestSnapshot.
    // For backtest mode, use a date-bounded snapshot fetcher — coordinate
    // with the backtest harness in W4 on exactly which API to call.
    const snap = await latestSnapshot('prophet', universe);
    if (!snap || !Array.isArray(snap.results)) return [];

    const picks = (snap.results as any[])
      .filter((p) => typeof p.composite === 'number' && p.composite >= minComposite)
      .filter((p) => p.layers?.fundamental?.pass === true) // earnings-quality gate
      .sort((a, b) => b.composite - a.composite)
      .slice(0, topN);

    return picks.map((p) => ({
      ticker: p.ticker,
      name: p.name ?? p.ticker,
      sector: p.sector ?? 'Unknown',
      composite: p.composite,
      layers: p.layers,
      fundamentalPass: p.layers?.fundamental?.pass === true,
      regime: p.regime ?? 'neutral',
      signalId: 'composite-v1',
    }));
  },
};
```

## 4.4 `rebalance.ts` test scaffolding (W3)

Pure function; no mocks needed.

```ts
// __tests__/rebalance.test.ts
import { describe, it, expect } from 'vitest';
import { decideRebalance } from '../rebalance';
import type {
  PortfolioState, RankingResult, PortfolioConfig,
} from '../types';

const CONFIG: PortfolioConfig = {
  universe: 'largecap', startDate: '2024-01-01', startCapital: 100_000,
  positionCount: 10, minHoldDays: 30, maxSwapsPerRebalance: 3,
  sectorCap: 4, slippageBps: 10, minComposite: 50, candidatePool: 15,
  version: 'v1',
};

const EMPTY_STATE: PortfolioState = {
  universe: 'largecap', asOfDate: '2024-01-01', cash: 100_000, equity: 100_000,
  positions: [], lastRebalanceAt: '2024-01-01T00:00:00Z',
  updatedAt: '2024-01-01T00:00:00Z',
};

function makeCandidate(
  ticker: string, composite: number, sector = 'Technology', fundamentalPass = true,
): RankingResult {
  return {
    ticker, name: ticker, sector, composite,
    layers: { fundamental: { score: composite, pass: fundamentalPass } } as any,
    fundamentalPass, regime: 'risk_on', signalId: 'composite-v1',
  };
}

describe('decideRebalance — empty state', () => {
  it('initial fill produces 10 buys, 0 sells, equal weight', () => {
    const candidates = Array.from({ length: 15 }, (_, i) =>
      makeCandidate(`T${i}`, 90 - i));
    const decision = decideRebalance(EMPTY_STATE, candidates, CONFIG, '2024-01-08');
    expect(decision.in).toHaveLength(10);
    expect(decision.out).toHaveLength(0);
    expect(decision.in.every((x) => x.targetWeight === 0.10)).toBe(true);
  });
});

describe('decideRebalance — drop-out with min-hold', () => {
  it('keeps a name that fell out of top-N but is < 30 days held', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-01-15',
      positions: [
        { ticker: 'AAPL', shares: 55, entryDate: '2024-01-01',
          entryPrice: 180, currentPrice: 185, marketValue: 10_175,
          weight: 0.10, sector: 'Technology' },
      ],
    };
    const candidates = [makeCandidate('NEW', 80)]; // top-15 doesn't include AAPL
    const decision = decideRebalance(state, candidates, CONFIG, '2024-01-15');
    expect(decision.out.find((o) => o.ticker === 'AAPL')).toBeUndefined();
    expect(decision.holds.find((h) => h.ticker === 'AAPL')?.reason).toBe('min_hold_active');
  });
});

describe('decideRebalance — forced exit on fundamental fail', () => {
  it('exits a holding whose fundamentalPass flipped to false, even mid-hold', () => {
    const state: PortfolioState = {
      ...EMPTY_STATE,
      asOfDate: '2024-02-15',
      positions: [
        { ticker: 'BAD', shares: 50, entryDate: '2024-01-01',  // 45 days held
          entryPrice: 100, currentPrice: 95, marketValue: 4_750,
          weight: 0.05, sector: 'Tech' },
      ],
    };
    const candidates = [
      // BAD is in top-15 but fundamentalPass = false → forced exit
      makeCandidate('BAD', 75, 'Tech', false),
    ];
    const decision = decideRebalance(state, candidates, CONFIG, '2024-02-15');
    expect(decision.out.find((o) => o.ticker === 'BAD')?.reason).toBe('fundamental_fail');
  });
});

// Add cases for: sector cap, swap budget enforcement, cash sleeve when
// < 10 candidates, equal-weight rebalancing math, ticker-precision swaps.
```

## 4.5 Backtest report template (W4 — copy verbatim, fill numbers)

```markdown
# Phase 4e-1 — Backtest Validation Findings

**Verdict:** SHIP | DON'T SHIP | SHIP WITH CAVEATS

**Layers active:** N of 7 (list active; list any stubs)
[2-3 sentence verdict explanation. Be specific: which window's numbers
drove the decision, and what the style-factor + active-layer checks
showed.]

**Generated:** YYYY-MM-DD HH:MM UTC
**Engine commit:** <git rev-parse HEAD>
**Rule version:** v1 (per briefs/phase-4e-1-brief.md § "The rebalance rule")
**Costs applied:** 10 bps slippage per side, $0 commission

---

## 0. Layer activity audit (W0 step 7, run BEFORE backtest)

Sample: 90 days of Prophet largecap snapshots, distinct (asOfDate, ticker) rows.

| Layer            | Mean | StDev | % exactly 50 | Verdict |
|------------------|-----:|------:|-------------:|---------|
| structure        |      |       |              | live | stub |
| momentum         |      |       |              |       |
| volume           |      |       |              |       |
| volatility       |      |       |              |       |
| relativeStrength |      |       |              |       |
| fundamental      |      |       |              |       |
| catalyst         |      |       |              |       |

If any layer is stub-returning, this report runs BOTH Scenario A
(composite as-is) and Scenario B (composite recomputed using only live
layers, stub weights redistributed proportionally).

---

## 1. Summary table — Scenario A (composite as-is)

| Window                  | Port %   | SPY %   | Excess   | Port Sharpe | SPY Sharpe | Port Max DD | SPY Max DD | Swaps |
|-------------------------|---------:|--------:|---------:|------------:|-----------:|------------:|-----------:|------:|
| 2018-01-01 → 2026-01-01 |          |         |          |             |            |             |            |       |
| 2018-01-01 → 2022-01-01 |          |         |          |             |            |             |            |       |
| 2022-01-01 → 2026-01-01 |          |         |          |             |            |             |            |       |
| 2020-02-01 → 2020-09-01 |          |         |          |             |            |             |            |       |
| 2022-01-01 → 2022-12-31 |          |         |          |             |            |             |            |       |

## 2. Summary table — Scenario B (active layers only, if applicable)

| Window                  | Port %   | SPY %   | Excess   | Port Sharpe | SPY Sharpe | Port Max DD | SPY Max DD | Swaps |
|-------------------------|---------:|--------:|---------:|------------:|-----------:|------------:|-----------:|------:|
| [same rows]             |          |         |          |             |            |             |            |       |

## 3. Rolling 1-year windows (Scenario A; Scenario B if applicable)

| Start (Jan)  | Scen A Port % | Scen A SPY % | Scen A Excess | Beat SPY (A)? | Scen B Excess (if applic) | Beat SPY (B)? |
|--------------|--------------:|-------------:|--------------:|:-------------:|--------------------------:|:-------------:|
| 2018         |               |              |               |               |                           |               |
| 2019         |               |              |               |               |                           |               |
| ...          |               |              |               |               |                           |               |
| 2024         |               |              |               |               |                           |               |

**Rolling 1-year windows that beat SPY (Scenario A):** N of M (XX%)
**Rolling 1-year windows that beat SPY (Scenario B):** N of M (XX%)

## 4. Style-factor decomposition (full window 2018-2026, Scenario A)

| Series   | Total Return | Annualized | vs SPY  |
|----------|-------------:|-----------:|--------:|
| Portfolio|              |            |   ref   |
| SPY      |              |            |   0%    |
| QQQ      |              |            |         |
| IWF      |              |            |         |

**Style-factor check:** Does the portfolio beat SPY by clearly more
than QQQ does? [YES → alpha. NO → factor exposure, not edge.]

## 5. Position-level diagnostics (full window, Scenario A)

- Total swaps executed: N
- Average hold days per position: X.X
- Annual turnover: X.X%
- Total cost drag (slippage): X.XX%
- Best contributor: TICKER (+X.X% to portfolio return)
- Worst contributor: TICKER (-X.X% to portfolio return)

## 6. What broke (if anything)

[Honest assessment. If verdict is DON'T SHIP, this is where you
explain why. Cite specific dates and contributors.]

## 7. Recommendation

[If SHIP: confirm W5 ships in this PR.
 If SHIP WITH CAVEATS: list caveats, confirm W5 ships with caveats
 documented in the PR description.
 If DON'T SHIP: propose a specific v2 rule. Example:
 "Proposed v2 changes: (a) forced exit when fundamentalPass=false
 regardless of min-hold; (b) raise minComposite from 50 to 60.
 Recommend a 4e-1-fix brief incorporating these changes."]
```

---

# PART 5 — CONVENTIONS + GOTCHAS

## 5.1 Commit cadence + messages

One commit per workstream. Suggested sequence:

1. `phase-4e-1: W0 layer activity audit (precondition)`
2. `phase-4e-1: W1 portfolio state schema + types`
3. `phase-4e-1: W2 pluggable RankingSignal + composite-v1`
4. `phase-4e-1: W3 decideRebalance pure function + tests`
5. `phase-4e-1: W4 backtest harness + run-portfolio-backtest CLI`
6. `phase-4e-1: W4 backtest run results + findings report (verdict: X)`
7. `phase-4e-1: W5 live scheduled rebalance` (CONDITIONAL on verdict)
8. `phase-4e-1: W6 daily mark-to-market scheduled function`
9. `phase-4e-1: W7 GET /api/prophet-portfolio + netlify.toml redirect`
10. `phase-4e-1: W8 decisionLog writer + forward-return populator`
11. `phase-4e-1: W9 APP_VERSION + ORCHESTRATOR + PR description`

Commit message body: 2-5 short paragraphs explaining what + why.
Match the style on `main` (`git log --oneline -20` shows examples).

## 5.2 Branch + push hygiene

Branch name: `phase-4e-1-portfolio-engine`. Single branch for the
whole phase. Push ONCE when ready for PR. Use `git rebase -i origin/main`
to clean local history before pushing if needed.

## 5.3 APP_VERSION bump rule

In `src/App.jsx`. Current: `0.16.0-alpha`.

- Verdict **SHIP** → `0.17.0-alpha`
- Verdict **SHIP WITH CAVEATS** → `0.17.0-alpha`
- Verdict **DON'T SHIP** → `0.16.1-alpha`

## 5.4 MODEL_VERSION rule

In `netlify/functions/shared/model-version.ts`. Current: `2026.02.0`.
**DO NOT BUMP.** Scoring math is unchanged in 4e-1.

## 5.5 Netlify gotchas (from prior phases — read or you'll repeat them)

These bit prior phases. They're documented in `ORCHESTRATOR.md § Lessons learned`:

- **Method-conditioned redirects are silently dropped.** Do NOT try
  `from = "/api/x" [method] "POST"` in `netlify.toml`. Either gate
  inside the function or use distinct paths.
- **The `-background.ts` filename suffix gives a 15-min container
  even when invoked via HTTP** (not just via cron). Your portfolio
  functions are NOT background — they run in seconds. Don't name
  them with `-background` suffix.
- **Always smoke-test new redirects on the deploy preview before
  merge.** A 4b-2 routing bug shipped to prod for 5 minutes before
  catch.

## 5.6 Test conventions

- Runner: `vitest`. Tests live under `__tests__/` next to the code.
- `.test.ts` (functions) / `.test.jsx` (React).
- `npm test` runs everything; `npx vitest run <path>` runs a subset.
- Mock `firebase-admin` per PART 4.2; reuse the in-memory store style.
- Don't network. Don't hit Polygon / Finnhub / Quiver / Anthropic in tests.
- New tests should grow count from 446 by ~15-25.

## 5.7 TypeScript

- `strict: true` is on. No `any` without an inline comment explaining why.
- `npx tsc --noEmit` must pass before each commit.
- Exported functions: explicit types. Internal helpers: inferred OK.

---

# PART 6 — OPENING THE PR

## 6.1 Push the branch

```bash
git push -u origin phase-4e-1-portfolio-engine
```

## 6.2 Open the PR via GitHub API

```bash
# Substitute <PAT> with Chad's write-scoped PAT
curl -sS -X POST \
  -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4e-1 — Prophet Portfolio: engine + backtest validation",
    "head": "phase-4e-1-portfolio-engine",
    "base": "main",
    "body": "See briefs/phase-4e-1-pr-description.md for the full description.\n\n**Verdict: <SHIP | DON'\''T SHIP | SHIP WITH CAVEATS>**\n\nLayers active: N of 7\n\n[2-3 sentence summary]\n\nBranch: phase-4e-1-portfolio-engine. APP_VERSION: <0.17.0-alpha or 0.16.1-alpha>."
  }'
```

The PR description body should be a 1-paragraph summary that points
at `briefs/phase-4e-1-pr-description.md` for full detail.

---

# PART 7 — SMOKE TEST ON DEPLOY PREVIEW

After pushing + opening the PR, Netlify auto-builds a deploy preview.
Wait ~90s, then:

```bash
PR=<your PR number>
HOST="https://deploy-preview-${PR}--tradeiq-alpha.netlify.app"

# 1. Endpoint reachable + returns valid JSON
curl -sS "${HOST}/api/prophet-portfolio?universe=largecap" \
  | python3 -m json.tool | head -30
# Expected pre-cron: { "ok": true, "state": null, "swaps": [], "equityCurve": [], ... }

# 2. Bundle has the expected APP_VERSION
curl -sS "${HOST}/" -o /tmp/preview.html
grep -oE "0\.1[67]\.[0-9]+-alpha" /tmp/preview.html | head -1

# 3. The 405-on-POST check (the endpoint is GET-only)
curl -sS -X POST "${HOST}/api/prophet-portfolio?universe=largecap" -w "\nstatus:%{http_code}\n"
# Expected: status:405
```

The scheduled rebalance does NOT fire on deploy previews (Netlify cron
is production-only). First real state writes after merge when prod
cron fires Tuesday 21:00 UTC.

---

# PART 8 — HAND-OFF MESSAGE FORMAT

When the PR is mergeable, post a SINGLE message in this conversation
with EXACTLY this shape:

```
PR #<N> open: https://github.com/DavisDelivery/TradeIQ/pull/<N>

Verdict: <SHIP | DON'T SHIP | SHIP WITH CAVEATS>
Layers active: <N> of 7  (stubs: <list or "none">)

Numbers (Scenario A, composite as-is):
- Full-window excess vs SPY: <+X.X% | -X.X%>
- Rolling 1-year windows that beat SPY: <N>/<total>
- Worst rolling window: <-X.X% in <YYYY-MM>>
- Post-cost portfolio Sharpe: <X.XX> vs SPY Sharpe <X.XX>
- Style check (vs QQQ): portfolio <±X.X%> · QQQ <±X.X%>

Scenario B (active layers only, if any layer stub-returned):
- Full-window excess vs SPY: <±X.X%>
- Rolling 1-year windows that beat SPY: <N>/<total>
- Delta vs Scenario A: <±X.X pp>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing
- npm run build: clean
- Deploy preview smoke: <pass | n/a if W5 skipped>

W5 (live scheduled rebalance): <included | skipped per verdict>

Tests added: <N> (target was 15-25)
```

That's the message. Don't recap the brief, don't propose next phases,
don't apologize for any judgment calls. The numbers speak.

---

# PART 9 — FAILURE MODES TO AVOID

- **Cherry-picking the backtest start date.** If 2018 looks ugly,
  report it. Don't quietly start from 2019.
- **Skipping the style-factor decomposition.** "Beats SPY" without
  the QQQ/IWF comparison is incomplete. Chad will reject the PR.
- **Tweaking the rebalance rule mid-backtest based on what's working.**
  Overfitting via search. Build the rule per W3 verbatim, run the
  validation once, let the numbers speak. If it fails, propose v2 in
  the recommendation section — don't shotgun variants.
- **Skipping the layer audit (W0 step 7) because it's annoying.** It's
  the precondition the brief was updated to require. The audit table
  is the FIRST section of the report. Skipping it = PR rejected.
- **Skipping the decisionLog writer (W8) because no consumer exists.**
  Phase 5c will consume it. Every day without it is another day of
  missing training data. Land it dormant.
- **Touching `prophet-sieve` or `prophet-layers`.** Stable 4c-2 modules.
  Bug in them → surface to Chad, don't fix in your PR.
- **Quoting any literal API key / PAT / SA-JSON anywhere.** Repo has
  secret-scanning enabled; literal leak blocks merge.

---

# PART 10 — PARALLEL CONTEXT

Phase 5a is running in a separate executor session in parallel with
you. Their work is Python under `reports/phase-5a/` + `scripts/ml/`.
You do not touch their files; they do not touch yours.

Your W2 `RankingSignal` interface is the seam where Phase 5b will
later plug in any ML winner 5a surfaces. Build the interface clean
per the brief — `signalId` stamped on every decisionLog row is
non-negotiable; that's what 5c uses to correlate decisions with the
signal that produced them.

If 5a's findings recommend a winning ML model, Phase 5b creates
`mlRankingSignal` implementing the same `RankingSignal` interface —
zero refactor cost for you. Don't write any bridge code in 4e-1.

---

End of kickoff. Read `briefs/phase-4e-1-brief.md` (also embedded in
PART 3 above), then start with W0.
