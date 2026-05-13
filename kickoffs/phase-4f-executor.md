# Phase 4f Executor Kickoff — Stub-Analyst Audit + Repair + Institutional-Flow Data

> **For Chad:** paste this entire file as the opening message of a new
> Claude conversation. In your follow-up message, send the write-scoped
> GitHub PAT. The agent has everything else it needs after that.
>
> This kickoff is fully self-contained: cold-start commands, repo
> orientation, conventions, the complete Phase 4f brief embedded
> inline, code shape templates (audit script, root-cause taxonomy,
> institutional-flow signal interfaces, composite reweight math, UI
> badge component, pre/post backtest report template), conventions,
> PR commands, smoke test commands, hand-off format, failure modes.

---

You are an executor agent. Your single assignment is **Phase 4f —
Stub-Analyst Audit + Repair + Institutional-Flow Data** for the
TradeIQ project. The conversation you're reading right now is your
complete boot prompt. Do not ask Chad to explain TradeIQ or
re-summarize anything below — read end-to-end, then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. The system has two ranking
products: the **Target Board** (10 analyst personas vote, each
contributing a 0-100 score with a configured weight) and the
**Prophet Board** (7 quantitative layers — structure, momentum,
volume, volatility, relative strength, fundamental, catalyst —
composited via a hand-tuned weighted sum). Scheduled scans write
snapshots to Firestore; Netlify functions serve them to a React SPA.
Owner: Chad Davis. Stack: TypeScript Netlify functions + React 18 /
Vite SPA + Firestore + Polygon / Finnhub / Quiver / FRED data
providers + Anthropic Claude Opus 4.7 for narration. Phases ship
incrementally and merge into `main` after Chad reviews.

## Your assignment in two sentences

Audit every analyst across Target Board (10) and Prophet Board (7)
across both largecap and russell2k universes to identify which are
**stub-returning** (defaulting to the neutral midpoint instead of
computing real values), root-cause each stub, then either repair the
handler or remove the analyst from the composite with proportional
weight redistribution. In the same PR, integrate new institutional-
flow data (dark-pool prints, unusual options activity, block trades
from existing Polygon feeds) into the surviving Flow + Insider
analysts so they reflect real market-maker positioning signals.

The screenshot that triggered this phase showed five of ten Target
analysts on a sample ticker returning exactly 50 — totaling 44% of
the composite weight contributing no information. Same risk exists
for Prophet's 7 layers. The phase makes the entire scoring system
honest about no-data conditions and adds real signal where dishonest
stubs used to live.

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

# Confirm you landed on a current main. The kickoff was written
# against main at the SHA committed alongside this file. Newer is
# fine; if commits are missing, stop and surface to Chad.
git log --oneline -8
# Expected to include the recent 4f brief commit + parent kickoff +
# brief commits + earlier 4c-2 / 4c-1 merges.

# Identity for your commits
git config user.email "executor-4f@tradeiq.local"
git config user.name "Executor 4f"

# Install + verify baseline. The actual count depends on what 4e-1
# and 5a landed before you started; the value to pattern-match against
# is whatever `git log` shows the most recent merge commit reported.
npm ci
npx tsc --noEmit             # must be clean
npm test                     # must report all passing; capture the count
npm run build                # must complete cleanly

# Create your branch
git checkout -b phase-4f-stub-audit-repair
```

If any of the above fails, STOP and report to Chad with exact output.

## 1.2 Secrets handling

Chad provides the write-scoped GitHub PAT in his next message. Use it
ONLY for:
- The `git clone` command above (substitute into the URL)
- `git push origin phase-4f-stub-audit-repair`
- The GitHub-API PR-open `curl` command in PART 6

Never write the PAT to any file in the repo. Never commit it. Never
print it to logs.

### What you need vs. what Chad runs separately

Two distinct concerns, easy to conflate. Read carefully:

**For unit tests (`npm test`) — you do NOT need:**
- Firebase service account JSON. `npm test` uses mocked Firestore
  (see PART 4.1's audit-script template + the existing
  `snapshot-store-pit.test.ts` pattern). Tests pass without any
  credentials.
- Live Polygon/Quiver keys. Tests mock API responses per existing
  patterns.

**For the W1 audit's *real* findings — `FIREBASE_SERVICE_ACCOUNT` IS
required.** Mocked tests prove the audit script *works*; they don't
produce real findings. The audit script's actual run against
production Prophet + Target snapshots is what populates
`reports/phase-4f/audit.md` with the per-analyst stdev / pct-exactly-50
classifications that drive W2/W3/W5.

Chad's plan for that live run:
- If he provides `FIREBASE_SERVICE_ACCOUNT` in his next message
  (alongside the PAT), you run the audit live as part of W1.
- If he doesn't, you ship the audit script + tests, write
  `reports/phase-4f/audit.md` with **VERDICT: PENDING LIVE-DATA RUN**
  (same posture 4e-1's `backtest-validation.md` used), document
  precisely how Chad runs it, and STOP. Do NOT proceed to W2/W3/W5
  against mocked or synthesized classifications — those decisions
  are binding and must come from real data.

**For W6 (pre/post-4f backtest comparison):** this depends on 4e-1's
backtest harness. If 4e-1's full-window backtest is itself still
PENDING when you start W6, run `scripts/run-portfolio-backtest.ts`'s
`--demo` mode (4e-1 added this for pipeline verification against a
synthetic dataset) and clearly label W6's output as DEMO. The W6
report is a sanity check, not a binding gate (the brief says so),
but it must be honest about whether real-data was used.

**`POLYGON_API_KEY`** — used by the live scheduled
`scan-institutional-flow-largecap.ts` function in production after
merge. Already in Netlify env; you don't need it locally because
your tests mock Polygon responses (see PART 4 templates).

If you find yourself thinking "I need to hit live Polygon to validate
something the audit script depends on" — stop, write the concrete
question, ask Chad. Don't request keys speculatively.

---

# PART 2 — REPO ORIENTATION

## 2.1 Directory map

```
TradeIQ/
├── briefs/                          ← phase specs
│   ├── phase-4f-brief.md            ← embedded below in PART 3
│   ├── phase-4e-1-brief.md          ← 4e-1 — read for context on the rebalance rule's W4 backtest
│   ├── phase-4c-2-brief.md          ← 4c-2 — Prophet layers + sieve architecture; read for layer-compute patterns
│   └── phase-4f-pr-description.md   ← YOU WRITE THIS at end (W9)
├── kickoffs/
│   └── phase-4f-executor.md         ← this file
├── reports/
│   ├── phase-4e-1/                  ← 4e-1's outputs; § 0 layer audit table is REFERENCE if it exists
│   └── phase-4f/                    ← YOU CREATE
│       ├── audit.md                 ← W1+W2 output — the full audit table + per-stub diagnosis
│       └── backtest-comparison.md   ← W6 output — pre/post composite IC delta
├── netlify/
│   ├── functions/
│   │   ├── *.ts                     ← HTTP endpoints
│   │   ├── scan-*.ts                ← scheduled functions
│   │   ├── shared/                  ← reusable modules
│   │   │   ├── target-analysts/     ← Target Board's 10 analysts live here (verify path on clone)
│   │   │   │   └── (one .ts per analyst — your W3 edits these)
│   │   │   ├── prophet-layers.ts    ← Prophet's 7 layers + BASE_WEIGHTS + composeProphet
│   │   │   ├── institutional-flow/  ← NEW — YOUR W4 WORK
│   │   │   │   ├── types.ts         ← YOU CREATE
│   │   │   │   ├── dark-pool.ts     ← YOU CREATE
│   │   │   │   ├── options-unusual.ts ← YOU CREATE
│   │   │   │   ├── block-trades.ts  ← YOU CREATE
│   │   │   │   └── __tests__/       ← YOU CREATE
│   │   │   ├── snapshot-store.ts    ← read for sampling patterns (your audit script uses these)
│   │   │   ├── data-provider.ts     ← read for Polygon fetch patterns
│   │   │   ├── firebase-admin.ts    ← reference for Firestore mock pattern
│   │   │   └── __tests__/
│   │   ├── scan-target.ts           ← Target Board scheduled scanner; EDIT for null-skipping composeTarget
│   │   ├── scan-institutional-flow-largecap.ts ← YOU CREATE (W7)
│   │   └── __tests__/
├── src/
│   ├── App.jsx                      ← edit APP_VERSION → 0.18.0-alpha (W9)
│   ├── components/AnalystContributions.jsx  ← EDIT for LIVE/NO_DATA/REMOVED badges (W5)
│   │     (or wherever Target Board's contribution panel lives — verify on clone)
│   ├── lib/validateResponse.js      ← may need shape additions for new response fields
│   └── __tests__/                   ← edit for badge component tests
├── scripts/
│   ├── audit-stub-analysts.ts       ← YOU CREATE (W1)
│   └── backtest-pre-vs-post-4f.ts   ← YOU CREATE (W6)
├── netlify.toml                     ← edit: add redirect for scan-institutional-flow function
├── ORCHESTRATOR.md                  ← edit at end (W9)
└── HANDOFF.md                       ← orchestrator handoff (ignore)
```

## 2.2 Files you ARE allowed to touch

Creating:
- `scripts/audit-stub-analysts.ts`
- `scripts/backtest-pre-vs-post-4f.ts`
- `reports/phase-4f/audit.md`
- `reports/phase-4f/backtest-comparison.md`
- `netlify/functions/shared/institutional-flow/types.ts`
- `netlify/functions/shared/institutional-flow/dark-pool.ts`
- `netlify/functions/shared/institutional-flow/options-unusual.ts`
- `netlify/functions/shared/institutional-flow/block-trades.ts`
- `netlify/functions/shared/institutional-flow/__tests__/*.test.ts`
- `netlify/functions/scan-institutional-flow-largecap.ts`
- `netlify/functions/__tests__/scan-institutional-flow-largecap.test.ts`
- `briefs/phase-4f-pr-description.md`

Editing:
- `netlify/functions/shared/target-analysts/*.ts` — only the
  analysts your W1 audit classifies as needing repair (and not ALL
  of them — only the specific files touched by your W2 root-cause
  diagnosis)
- `netlify/functions/shared/prophet-layers.ts` — only the layers
  needing repair, plus `BASE_WEIGHTS` if any layer is removed in W5
- `netlify/functions/scan-target.ts` (or whichever module exposes
  `composeTarget`) — for the null-skipping composite math
- `src/components/AnalystContributions.jsx` — LIVE/NO_DATA/REMOVED badges
- `src/__tests__/AnalystContributions.test.jsx`
- `src/lib/validateResponse.js`
- `src/App.jsx` — APP_VERSION bump
- `netlify/functions/shared/model-version.ts` — MODEL_VERSION bump
- `netlify.toml`
- `ORCHESTRATOR.md`

## 2.3 Files you may NOT touch (PR will be rejected)

- Anything under `netlify/functions/shared/prophet-sieve/` — Phase
  4c-2; stable
- Anything under `netlify/functions/shared/backtest/` — Phase 4a;
  your W6 backtest harness CALLS this code, doesn't modify it
- Anything under `netlify/functions/shared/prophet-portfolio/` —
  Phase 4e-1; stable if landed
- `netlify/functions/shared/earnings-intel.ts` — Phase 4c-1; stable
- `netlify/functions/shared/narrative-generator.ts` — Phase 4c-1
- Any analyst or layer file that your W1 audit classifies as **Live**
  (i.e. don't touch what isn't broken)
- Anything under `reports/phase-5a/` or `scripts/ml/` — Phase 5a's
  territory
- `briefs/` — you write `phase-4f-pr-description.md`; you do not edit
  any other brief

---

# PART 3 — THE BRIEF (verbatim)

The rest of this part is the contents of `briefs/phase-4f-brief.md`
verbatim. Treat it as the spec. If anything below conflicts with PART
1/2 or PART 4-10, the brief wins.

═══════════════════════════════════════════════════════════════════════
BEGIN BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

# Phase 4f — Stub-analyst audit + repair + institutional-flow data

**Author:** orchestrator
**Target version:** `0.18.0-alpha` (composite reweights + new analyst inputs constitute a real scoring change)
**MODEL_VERSION:** bump to `2026.03.0` on merge — historical snapshots remain on `2026.02.0` for honest comparability.
**Dependencies:** Phase 4c-2 merged (Prophet layers); Quiver + Polygon API keys already provisioned in Netlify env.
**Relationship to 4e-1:** Phase 4e-1's W0 stub-layer audit covers Prophet-largecap only and produces a useful reference table if it lands first. **4f's W1 is methodologically independent and broader** — Target + Prophet across both largecap and russell2k universes — so 4f is not blocked on 4e-1. If 4e-1's audit table exists when 4f starts, treat it as one input informing the Prophet-largecap rows of your own audit; if not, generate the full data from scratch.
**Parallel-with:** none recommended. Run serially after 4e-1 + 5a primarily to avoid review-merge collisions on `prophet-layers.ts` (4f rewrites BASE_WEIGHTS; 4e-1 reads from it). Not a hard block.

---

## Why this exists

Chad's screenshot 2026-05-13 of the Target Board for ON (onsemi):

```
Insider    50  (14% weight)  ← stub
Political  50  (10% weight)  ← stub
Macro      50  ( 7% weight)  ← stub
Earnings   50  ( 7% weight)  ← stub
Patents    50  ( 6% weight)  ← stub
                ───────────
                44% dead weight
```

Five of ten Target analysts were returning the neutral midpoint (50)
instead of computing anything. The composite of 83 was being driven
entirely by the five working contributors (Technical 69, Sector 98,
Fundamental 28, Flow 58, News 71), with the dead weights diluting
whatever signal those produced. Chad's instinct that he's "not
getting the best possible candidates" is mathematically correct: with
44% of the composite carrying no information, the ranking is noisier
than it should be by exactly that fraction.

Same risk exists for Prophet's 7 layers — Phase 4e-1's W0 audit will
surface which Prophet layers are stub-returning; 4f acts on those
findings.

Phase 4f does two things together:
1. **Audit + repair** the stub-returning analysts/layers across both
   boards. Identify root cause for each; repair where possible; remove
   from composite where data is unrecoverable and redistribute weight.
2. **Add institutional-flow data** to the Flow + Insider analysts so
   they reflect actual market-maker / institutional positioning
   signals rather than stale stubs.

Both pieces live in one phase because they're the same problem viewed
from two angles: the system isn't using all the information it could
be. Splitting them produces two PRs that touch the same files.

---

## What "institutional flow" means here

Staged orders before execution are not knowable — institutions hide
pre-trade intent via iceberg orders, VWAP/TWAP slicing, and dark
pools. What IS knowable, all post-execution evidence of intent:

- **Dark pool prints** — off-exchange trades reported to FINRA TRF;
  the dark-pool-volume / total-volume ratio per ticker is the
  load-bearing institutional accumulation/distribution signal.
- **Unusual options activity** — block trades, sweeps, far-OTM size,
  open-interest jumps that signal directional bets.
- **Block trades on lit venues** — single prints ≥ 10,000 shares or
  > $200K notional.
- **Insider Form 4** — C-suite buys/sells, filed within 2 business
  days. Already in scope via Quiver but the screenshot suggests the
  Insider analyst isn't actually using this data.

Phase 4f integrates the first three from Polygon (we already have the
API key + data feeds) and verifies/repairs the Quiver Form 4 path.

---

## Operational context

- Repo: `DavisDelivery/TradeIQ`
- Netlify site: `tradeiq-alpha.netlify.app`
- Firebase project: `tradeiq-alpha`
- Polygon: already in Netlify env. Has both equity trade tape (for
  block trades + dark pool prints via TRF/D suffix) and options ticks.
- Quiver: already in Netlify env. Has insider transactions, lobbying,
  congressional trades.
- Finnhub: already in Netlify env. Has earnings surprises (used by
  Phase 4c-1).
- `GITHUB_PAT`: read-only PAT for cloning; Chad provides write-scoped
  PAT per session.
- Conventions: `tsc --noEmit`, `npm test`, `npm run build` clean
  before PR. APP_VERSION bump on merge.

---

## W0 — Preconditions

1. `git fetch origin && git log --oneline -5 origin/main` — confirm you're on a current main. 4e-1 and 5a being merged first is recommended for review-merge deconfliction (4f rewrites `BASE_WEIGHTS` in `prophet-layers.ts`) but neither is a hard methodological block on 4f.
2. `npm ci && npm test` — confirm baseline test count is current.
3. `npm run build` — clean.
4. If `reports/phase-4e-1/backtest-validation.md` exists on main, read its § 0 layer activity audit table. It covers Prophet-largecap only and is reference data for that one slice of your W1 audit — not a substitute for it. If the file doesn't exist, no problem; W1 generates the full dataset from scratch.
5. Read `netlify/functions/shared/prophet-layers.ts` end-to-end. Every Prophet layer's compute function lives here. Locate the default-return paths (`return { score: 50, pass: false, details: {} }` or equivalent) — these are the stub fallbacks the audit will catch.
6. Read the Target Board analyst modules under `netlify/functions/shared/target-analysts/` (or wherever Target's 10 analysts live — find via `grep -rE "Insider|Political|Macro|Patents" netlify/functions/shared/`).
7. Confirm Polygon dark-pool prints are visible in the equity trade feed: a sample `GET https://api.polygon.io/v3/trades/{ticker}` with recent date should show trades with TRF reporting venue codes in the `x` (exchange) field. Sanity-check that the TRF reporting venue codes you observe match what `dark-pool.ts` will filter on (W4a).

---

## W1 — Two-board audit + report

**Files:**
- `scripts/audit-stub-analysts.ts` — CLI that samples snapshots, computes per-analyst statistics
- `reports/phase-4f/audit.md` — output

Sample 90 days of recent snapshots for BOTH boards across BOTH
universes:
- Target Board, largecap (sp500 + ndx + dow)
- Target Board, russell2k
- Prophet, largecap
- Prophet, russell2k

For each board × universe × analyst|layer, compute:

| Statistic | Notes |
|-----------|-------|
| `count` | Total observations sampled |
| `mean` | Average score |
| `stdev` | Standard deviation |
| `pctExactly50` | % of rows where score === 50 exactly |
| `pctNull` | % of rows where score is null/undefined |
| `pctFailing` | % of rows where `pass === false` |
| `uniqueValues` | Count of distinct scores rounded to integer |

Verdict per analyst/layer:
- **Live**: stdev > 5 AND `pctExactly50` < 25%
- **Stub**: stdev < 2 OR `pctExactly50` > 60%
- **Degraded**: anything in between (worth a closer look but not
  conclusively dead)

The audit table is the first artifact of 4f. It goes into
`reports/phase-4f/audit.md` with a verdict line at the top:

```
Total analysts/layers reviewed: 17 (Target 10 + Prophet 7)
Live: N
Stub: N
Degraded: N
```

Followed by the full table and, per stub, a one-paragraph hypothesis
about root cause (W2 turns these hypotheses into traced root causes).

---

## W2 — Root cause classification

**Files:** continued work in `reports/phase-4f/audit.md`

For each stub or degraded analyst, classify root cause:

| Category | Description | Resolution path |
|----------|-------------|-----------------|
| `no_upstream` | Analyst depends on a data source that's missing, expired, or never wired (e.g. no Quiver subscription tier for that endpoint) | Either provision the upstream OR remove the analyst |
| `null_default` | Upstream returns null/empty and the handler catches it returning 50 instead of null/`pass: false` | Fix handler — score should be null/`pass: false` when no data, not 50 |
| `threshold_misconfig` | Analyst computes a real value but the threshold (e.g. "EPS surprise > 5% → bullish") is unreachable on the data we get | Re-tune threshold against observed distribution |
| `handler_bug` | Bug in the analyst's compute function — e.g. always returns the seed value before iteration runs | Fix the bug |
| `latency` | Upstream is correct but the analyst caches stale results and returns a stale 50 from days ago | Fix cache TTL or invalidation |

For each stub, the audit doc gets a section:

```markdown
### Insider (Target Board, 14% weight)
**Verdict:** Stub (stdev 0.4, 89% exactly 50)
**Root cause:** null_default — Quiver Insider Trades endpoint returns
empty array for ~70% of mid-cap and small-cap tickers; handler in
`netlify/functions/shared/target-analysts/insider.ts` returns
`{ score: 50, pass: false }` instead of `{ score: null, pass: false }`.
**Resolution path:** Either (a) fix handler to return null score when
no data (downstream composite would skip null-score analysts), or
(b) integrate Quiver's broader Insider Trading Sentiment dataset which
has coverage for most names, or (c) augment with Polygon block-trade
detection so the analyst has SOMETHING to score even when Form 4 data
is empty.
**Recommended:** (a) immediate (correctness) + (c) for coverage.
```

Once W2 is complete, each stub has a documented decision: repair
(category + plan), or remove (and weight redistribution).

---

## W3 — Repair the handler-bug + null-default stubs

**Files:** the actual analyst modules under
`netlify/functions/shared/target-analysts/` and the layer modules
under `netlify/functions/shared/prophet-layers.ts`.

For each stub classified as `null_default`, `handler_bug`,
`threshold_misconfig`, or `latency` in W2: fix the underlying code.
Patterns:

**Null-default fix:** an analyst that has no data to score should
return `{ score: null, pass: false, details: { reason: 'no_data' } }`
rather than `{ score: 50, pass: false }`. The composite function then
either skips that analyst (and renormalizes weights) or reports the
ticker as "not scoreable" — both are honest. Returning 50 is dishonest
because it appears to be a real evaluation.

**Composite reweighting on missing analysts:**
- Update `composeTarget` (or equivalent) to skip null-score analysts
  and proportionally rescale the surviving weights so they sum to 1.0.
- Stamp `_scoredAnalysts: ['Technical', 'Sector', ...]` on the
  composite output so the UI can show which analysts contributed.

**Tests:** add cases to the existing test files for each repaired
analyst:
- analyst with full data → real score
- analyst with empty data → null score, `pass: false`, reason recorded
- composite with one null analyst → weights rescaled correctly

---

## W4 — Institutional-flow data integration

**Files:**
- `netlify/functions/shared/institutional-flow/dark-pool.ts` (new)
- `netlify/functions/shared/institutional-flow/options-unusual.ts` (new)
- `netlify/functions/shared/institutional-flow/block-trades.ts` (new)
- `netlify/functions/shared/institutional-flow/__tests__/` (new)

### W4a — Dark pool ratio

Compute the dark-pool-volume / total-volume ratio for the last N
trading days per ticker. Polygon equity trades flag off-exchange
reporting via condition codes (typically 12, 14, 16, 37 for
ADF/TRF/Dark Pool ATS reporting) or the trade's `x` (exchange)
field being the TRF reporting venue (4 = NYSE TRF, 6 = NASDAQ TRF,
7 = FINRA ADF).

```ts
export interface DarkPoolSignal {
  ticker: string;
  asOfDate: string;
  darkPoolPct: number;          // 0-1, fraction of total volume off-exchange
  darkPoolPct5dAvg: number;     // 5-day rolling average
  darkPoolPct30dAvg: number;    // baseline
  zScore: number;               // (today - 30d avg) / 30d stdev
}

export async function computeDarkPoolSignal(
  ticker: string,
  asOfDate: string,
): Promise<DarkPoolSignal | null>;
```

Score interpretation: dark pool % significantly above its 30-day
baseline (z-score > 1.5) on a green day suggests institutional
accumulation; the same pattern on a red day suggests distribution.

Tests with synthetic Polygon trade data:
- All-lit trades → darkPoolPct ≈ 0
- All-dark trades → darkPoolPct ≈ 1
- Mixed: z-score computation matches hand calculation

### W4b — Unusual options activity

Pull Polygon options ticks for the last 5 trading days; flag:
- **Sweeps**: orders filled across ≥ 3 exchanges within 100ms (caller
  is willing to pay aggressive fill — usually a hedge fund taking
  liquidity for a directional bet)
- **Blocks**: single prints ≥ $500K notional premium
- **OI spikes**: open interest increase > 50% day-over-day on a strike
- **Volume / OI > 3**: unusual volume relative to standing open interest

```ts
export interface OptionsFlowSignal {
  ticker: string;
  asOfDate: string;
  bullishPremium: number;      // sum premium of bullish trades (calls bought, puts sold)
  bearishPremium: number;      // sum premium of bearish trades
  netDirectionalPremium: number; // bullish - bearish
  sweepCount: number;
  blockCount: number;
  oiSpikeStrikes: number;      // count of strikes with OI increases > 50%
  unusualScore: number;        // 0-100 composite (W3 spec)
}
```

Tests with synthetic Polygon options data:
- No unusual activity → unusualScore near 0
- High-premium bullish sweeps → bullishPremium > bearishPremium, score > 70
- Mixed activity → score reflects net positioning

### W4c — Block trades

Filter Polygon equity trades for size ≥ 10,000 shares OR notional
≥ $200K. Aggregate counts + total notional per day.

```ts
export interface BlockTradeSignal {
  ticker: string;
  asOfDate: string;
  blockCount: number;
  blockNotional: number;
  buySideEstimate: number;     // notional at-or-above ask
  sellSideEstimate: number;    // notional at-or-below bid
  buyMinusSell: number;
}
```

Tests:
- No blocks → all zero
- Buy-side blocks → buySideEstimate > sellSideEstimate
- Sell-side blocks → opposite

### W4d — Verify/repair the Quiver Form 4 insider path

Most likely already integrated but stub-returning per the screenshot.
Trace the data flow:
1. Quiver endpoint that returns insider transactions for a ticker
2. Handler that converts to a 0-100 score
3. Caching layer (if any)

For each step, log a sample request + response for a known-active
ticker (e.g. NVDA, AMD) and a typically-quiet ticker (e.g. KMB).
Identify whether the issue is:
- Quiver endpoint returning empty (→ check API tier / authentication)
- Handler logic returning 50 when data exists (→ fix handler)
- Cache serving stale 50 (→ fix cache)

Once fixed, the Insider analyst should produce a real score with
stdev > 10 across a sample of 50 tickers over 90 days. If it can't
reach that bar even after repair, classify as "remove" and
redistribute its 14% weight in W5.

---

## W5 — Composite reweighting + UI surfacing

**Files:**
- `netlify/functions/shared/scan-target.ts` (or wherever
  `composeTarget` lives) — update weight table
- `netlify/functions/shared/prophet-layers.ts` —
  `BASE_WEIGHTS` if any Prophet layer is removed
- `src/components/AnalystContributions.jsx` (or wherever the
  contributions UI lives) — surface which analysts are live vs
  removed vs stub
- `src/__tests__/AnalystContributions.test.jsx` — update

For each analyst/layer classified as "remove" in W2 (data
unrecoverable):
1. Set its weight in the BASE_WEIGHTS table to 0
2. Proportionally redistribute the freed weight across remaining
   analysts in the same category (technical vs fundamental vs flow vs
   catalyst)
3. Document the new weights in a table in `reports/phase-4f/audit.md`
   § "Final weight table"

For each analyst classified as "repair" and successfully repaired,
weights stay the same (the data is now real instead of stubbed).

**UI surfacing:** The contributions panel should show a small badge
on each analyst row indicating provenance:
- `LIVE` (green) — real signal computed
- `NO DATA` (gray) — data was missing; analyst contributed null,
  weight redistributed to peers (not 50 default)
- `REMOVED` (struck through) — analyst removed from the composite
  entirely (only for permanent removals)

The user should be able to see at a glance how much of the composite
is being driven by live data. The 44%-dead-weight problem should be
visually impossible to miss going forward.

---

## W6 — Backtest the change

**Files:**
- `scripts/backtest-pre-vs-post-4f.ts` — CLI that runs the same
  backtest config twice: once with pre-4f composite weights, once with
  post-4f. Output: a side-by-side comparison report
- `reports/phase-4f/backtest-comparison.md`

Run on:
- Same dates as 4e-1's backtest (2018-2026)
- Same universe (largecap)
- Same rebalance rule

Report: did the post-4f composite produce a better ranking signal?
The IC of the new composite should be higher than the pre-4f one, OR
at minimum equal — if it's substantially worse, something went wrong
in W3/W4/W5 and we surface that rather than ship.

This is not the binding verdict gate that 4e-1 had — it's a sanity
check. If the IC barely moved, we still ship (the original composite
had dishonest stubs; the new one is honest), but the report notes
that real-data inputs didn't dramatically improve ranking quality
yet. That's information for Phase 5a's interpretation of its findings.

### If 4e-1's backtest is still PENDING when you start W6

W6's pre/post comparison depends on 4e-1's harness
(`scripts/run-portfolio-backtest.ts`) running live against real
Polygon bars. If 4e-1's full-window backtest hasn't been populated
yet, you have two honest options:

- **(a) Run `--demo` mode** (4e-1 added this flag for pipeline
  verification). It runs the harness against a deterministic
  synthetic dataset. Mark the W6 report as DEMO at the top — the
  numbers prove the pre/post wiring works end-to-end but say
  nothing about whether the rule beats SPY in production. This
  matches the precedent 4e-1 set with its own demo-run.md.
- **(b) Skip the live run entirely.** Ship W3 + W4 + W5 with W6's
  report marked PENDING LIVE-DATA RUN, document the runbook (env
  vars + commands), and surface to Chad. The brief explicitly says
  W6 is a sanity check, not a gate — shipping without it is
  acceptable if Chad approves.

Do NOT synthesize IC numbers that look plausible. Either run real
data (if credentials are available), run `--demo` with the DEMO
label, or mark PENDING. The brief's intent is that W6 informs Phase
5a's interpretation; meaningless numbers in W6 actively harm that.

---

## W7 — Schedule the new institutional-flow scanners

**Files:**
- `netlify/functions/scan-institutional-flow-largecap.ts` — new
  scheduled function, daily after-hours

The dark-pool / options / block-trade signals are computed once per
day for the largecap universe and cached in Firestore under
`institutionalFlow/{universe}/{ticker}/{YYYY-MM-DD}`. The Target
Board scoring functions read from this cache instead of hitting
Polygon live (which would blow rate limits).

Schedule: `0 22 * * 1-5` (weekday 22:00 UTC, after market close).
Standard function (not background) — should run in under 5 min for
~200 largecap tickers using `mapWithConcurrency` at 8 parallel.

Russell2k version (`scan-institutional-flow-russell2k.ts`) wired
similarly but as a future Phase 4g if Russell scoring needs it; do
NOT build it in 4f. The Phase 4f scope is largecap-only to keep this
manageable.

---

## W8 — Tests + verification

- Each new module under `institutional-flow/` has its own
  `__tests__/` directory with ≥ 5 cases covering happy path, empty
  data, malformed Polygon response, rate-limit handling.
- The composite-reweighting logic gets a dedicated test verifying
  the rescale math: e.g. if 3 analysts with weights [0.14, 0.10, 0.07]
  are removed, the remaining 7 analysts' weights are rescaled
  proportionally so they sum to 1.0.
- The UI badge component (LIVE/NO DATA/REMOVED) has a snapshot test
  and a "renders all three states" test.
- The backtest comparison CLI runs end-to-end on a 1-year window
  before the full 2018-2026 sweep — fast sanity check.

Tests should grow the count by 50-80 (new analyst flow modules +
composite math + UI + integration).

---

## W9 — Version + ORCHESTRATOR + PR description

- `APP_VERSION` in `src/App.jsx`: `0.18.0-alpha`
- `MODEL_VERSION` in `netlify/functions/shared/model-version.ts`:
  `2026.03.0` (composite weights changed; historical snapshots on
  2026.02.0 remain valid as a separate version line)
- `ORCHESTRATOR.md`:
  - 4f row: `done`, summarize: # of stubs repaired, # removed,
    weight redistribution, IC change pre/post
  - Update the "Lessons learned" section to record the
    null-vs-50-default rule for future analyst additions
- PR description at `briefs/phase-4f-pr-description.md` —
  highlights what the audit found, what was repaired, what was
  removed, the IC delta, screenshots of the before/after UI
  contribution panel

---

## Verification (before opening PR)

1. `npx tsc --noEmit` — clean
2. `npm test` — passing, count grew by 50-80 from baseline
3. `npm run build` — clean
4. `scripts/audit-stub-analysts.ts` re-run on a fresh sample of
   snapshots produced post-4f — every analyst classified as "repair"
   in W2 now shows stdev > 5 AND pctExactly50 < 25% (i.e. is
   now `Live`)
5. `scripts/backtest-pre-vs-post-4f.ts` produces the comparison
   report; IC delta documented
6. Smoke test on deploy preview:
   - Load Target Board for a known-active ticker (NVDA, AMD)
   - Confirm the contributions panel shows real values across
     repaired analysts (not 50)
   - Confirm badges (LIVE / NO DATA / REMOVED) render correctly
   - Confirm composite math: sum of (analyst score × weight) for
     live analysts equals the displayed composite

---

## Out of scope (explicitly)

- **Russell2k institutional-flow scanning.** Polygon options coverage
  for sub-$2B-cap names is thin; dark-pool volume on illiquid Russell
  names is too small to be meaningful. Phase 4g if/when needed.
- **Third-party institutional-flow services** (Unusual Whales, Cheddar
  Flow, FlowAlgo). All can replace the home-rolled Polygon heuristics
  for $40-100/mo, but the priority in 4f is fixing what's broken
  using existing integrations. If post-4f the Flow analyst is still
  underpowered, Phase 4g evaluates adding a paid service.
- **Real-time intraday options/flow streaming.** Phase 4f computes
  daily after-close. Intraday is Phase 6+ territory.
- **Predictive modeling on institutional flow data.** The new
  signals are inputs to existing analysts; whether to train an ML
  model on them is Phase 5a's territory (if 5a is run after 4f, it
  will see the new signals as features automatically).
- **Re-deriving historical Target/Prophet snapshots with the new
  composite.** Snapshots remain on `2026.02.0`; new snapshots use
  `2026.03.0`. Don't backfill — comparing pre/post-4f signal quality
  requires the original noisy snapshots to exist.

---

## Files target

```
scripts/audit-stub-analysts.ts                                       NEW   ~120
scripts/backtest-pre-vs-post-4f.ts                                   NEW   ~150
reports/phase-4f/audit.md                                            NEW   ~300 (output)
reports/phase-4f/backtest-comparison.md                              NEW   ~150 (output)
netlify/functions/shared/institutional-flow/dark-pool.ts             NEW   ~150
netlify/functions/shared/institutional-flow/options-unusual.ts       NEW   ~220
netlify/functions/shared/institutional-flow/block-trades.ts          NEW   ~100
netlify/functions/shared/institutional-flow/types.ts                 NEW   ~80
netlify/functions/shared/institutional-flow/__tests__/*.test.ts      NEW   ~400
netlify/functions/shared/target-analysts/insider.ts                  EDIT  W3/W4d
netlify/functions/shared/target-analysts/political.ts                EDIT  W3 (repair or remove)
netlify/functions/shared/target-analysts/macro.ts                    EDIT  W3
netlify/functions/shared/target-analysts/patents.ts                  EDIT  W3 (likely remove)
netlify/functions/shared/target-analysts/earnings.ts                 EDIT  W3
netlify/functions/shared/target-analysts/flow.ts                     EDIT  W4a/b/c integration
netlify/functions/shared/prophet-layers.ts                           EDIT  W3 layer repairs + W5 reweight (BASE_WEIGHTS)
netlify/functions/shared/scan-target.ts                              EDIT  composeTarget reweighting + null handling
netlify/functions/scan-institutional-flow-largecap.ts                NEW   ~120
netlify/functions/__tests__/scan-institutional-flow-largecap.test.ts NEW   ~100
src/components/AnalystContributions.jsx                              EDIT  LIVE/NO DATA/REMOVED badges
src/__tests__/AnalystContributions.test.jsx                          EDIT  badge state coverage
netlify.toml                                                         EDIT  ~3 lines (one redirect for scan)
src/App.jsx                                                          EDIT  APP_VERSION → 0.18.0-alpha
netlify/functions/shared/model-version.ts                            EDIT  MODEL_VERSION → 2026.03.0
ORCHESTRATOR.md                                                      EDIT  4f row done; lessons learned
briefs/phase-4f-pr-description.md                                    NEW   ~200
```

~25 files, ~2400 net lines. Large PR. Split into two commit-groups in
the same branch is fine but a single PR — the audit + repair + data
integration are inseparable in review.

---

## Note to the executing agent

The temptation here is to ship the institutional-flow integrations
(W4) before completing the audit + repair (W1-W3). Don't. The audit
is what tells you which analysts need data vs which need handler fixes
vs which are unrecoverable. Adding dark-pool data to an analyst that
has a null-default bug just means the bug returns 50 with dark-pool
context attached — no actual improvement.

Order is:
1. Audit (W1-W2) — what's broken and why
2. Repair handlers (W3) — make the broken analysts honest about no-data
3. Add real data (W4) — give them institutional flow inputs
4. Reweight (W5) — proportionally rescale for any permanent removals
5. Backtest (W6) — confirm the new composite is at least as good

If you finish W1-W2 and find that all the Target stubs are actually
`no_upstream` (Quiver tier doesn't cover them, Polygon doesn't expose
the needed feed), the brief's W3-W4 collapses. Surface that to Chad
immediately — the right move would be to ship the audit + the
removals + the reweighting, defer the new-data integration to Phase
4g where it can be properly scoped against the right paid data
service.

Be honest in the audit. The screenshot showed 5 of 10 Target analysts
stubbed; if your audit on a wider sample shows 7 of 10 stubbed, write
that. If it shows 3 of 10, write that. The point is to know what we
have, not to confirm what we hoped to find.

═══════════════════════════════════════════════════════════════════════
END BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

---

# PART 4 — CODE SHAPE TEMPLATES

Starter shapes anchored to existing repo conventions. NOT complete
implementations — fill bodies and add fields the brief requires. The
W3 repair logic is **taxonomy-driven**: every action you take in W3
is selected from the table in § 4.2 based on what W1 produced for the
analyst in question. Do not skip to W3 with preconceived notions
about which analysts need fixing — let W1's output drive W3's edits.

## 4.1 Audit script — `scripts/audit-stub-analysts.ts` (W1)

```ts
#!/usr/bin/env tsx
/**
 * Phase 4f W1 — sample N days of recent snapshots across both boards
 * and both universes, compute per-analyst statistics, classify each
 * as Live / Stub / Degraded, emit a table to stdout AND write the
 * structured report to reports/phase-4f/audit.md.
 *
 * Usage:
 *   tsx scripts/audit-stub-analysts.ts --days 90 --out reports/phase-4f/audit.md
 */

import { promises as fs } from 'node:fs';
import { latestSnapshot, snapshotsAtOrBefore } from '../netlify/functions/shared/snapshot-store';

type Board = 'target' | 'prophet';
type Universe = 'largecap' | 'russell2k';

interface Observation {
  board: Board;
  universe: Universe;
  ticker: string;
  asOfDate: string;
  analystOrLayerName: string;
  score: number | null;     // null indicates a no-data analyst
  pass: boolean | undefined;
}

interface AnalystStats {
  board: Board;
  universe: Universe;
  name: string;
  count: number;
  mean: number;
  stdev: number;
  pctExactly50: number;
  pctNull: number;
  pctFailing: number;
  uniqueValues: number;
  verdict: 'Live' | 'Stub' | 'Degraded';
}

function classify(stats: Omit<AnalystStats, 'verdict'>): AnalystStats['verdict'] {
  if (stats.stdev < 2 || stats.pctExactly50 > 0.60) return 'Stub';
  if (stats.stdev > 5 && stats.pctExactly50 < 0.25) return 'Live';
  return 'Degraded';
}

async function sampleObservations(
  board: Board,
  universe: Universe,
  days: number,
): Promise<Observation[]> {
  // Walk snapshotsAtOrBefore for each day in the last N days; flatten
  // every (ticker, analyst/layer) row into Observation[]. Honor the
  // existing snapshot-store helpers — don't reach into Firestore directly.
  // TODO: implement using the existing snapshot-store API surface
  return [];
}

function computeStats(obs: Observation[], key: { board: Board; universe: Universe; name: string }): AnalystStats {
  const rows = obs.filter(
    (o) => o.board === key.board && o.universe === key.universe && o.analystOrLayerName === key.name,
  );
  const scores = rows.map((r) => r.score);
  const numericScores = scores.filter((s): s is number => typeof s === 'number');

  const mean = numericScores.length === 0
    ? 0
    : numericScores.reduce((a, b) => a + b, 0) / numericScores.length;
  const variance = numericScores.length === 0
    ? 0
    : numericScores.reduce((s, v) => s + (v - mean) ** 2, 0) / numericScores.length;
  const stdev = Math.sqrt(variance);

  const baseStats = {
    board: key.board,
    universe: key.universe,
    name: key.name,
    count: rows.length,
    mean,
    stdev,
    pctExactly50: numericScores.filter((s) => s === 50).length / Math.max(1, numericScores.length),
    pctNull: rows.filter((r) => r.score === null).length / Math.max(1, rows.length),
    pctFailing: rows.filter((r) => r.pass === false).length / Math.max(1, rows.length),
    uniqueValues: new Set(numericScores.map((s) => Math.round(s))).size,
  };
  return { ...baseStats, verdict: classify(baseStats) };
}

async function main() {
  const days = Number(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] ?? 90);
  const outPath = process.argv.find((a) => a.startsWith('--out='))?.split('=')[1]
    ?? 'reports/phase-4f/audit.md';

  // Sample all 4 board × universe combos
  const allObs: Observation[] = [];
  for (const board of ['target', 'prophet'] as Board[]) {
    for (const universe of ['largecap', 'russell2k'] as Universe[]) {
      const obs = await sampleObservations(board, universe, days);
      allObs.push(...obs);
    }
  }

  // Distinct analyst/layer names per board
  const distinctKeys = new Set<string>();
  for (const o of allObs) {
    distinctKeys.add(`${o.board}|${o.universe}|${o.analystOrLayerName}`);
  }

  const allStats: AnalystStats[] = [];
  for (const k of distinctKeys) {
    const [board, universe, name] = k.split('|') as [Board, Universe, string];
    allStats.push(computeStats(allObs, { board, universe, name }));
  }

  const live = allStats.filter((s) => s.verdict === 'Live');
  const stub = allStats.filter((s) => s.verdict === 'Stub');
  const degraded = allStats.filter((s) => s.verdict === 'Degraded');

  const md = renderMarkdown({ allStats, live, stub, degraded, days });
  await fs.mkdir('reports/phase-4f', { recursive: true });
  await fs.writeFile(outPath, md);
  console.log(`Wrote ${outPath}`);
  console.log(`Live: ${live.length}  Stub: ${stub.length}  Degraded: ${degraded.length}`);
}

function renderMarkdown(input: {
  allStats: AnalystStats[];
  live: AnalystStats[];
  stub: AnalystStats[];
  degraded: AnalystStats[];
  days: number;
}): string {
  // TODO: render the table per the template in § 4.4
  return '';
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

## 4.2 Root-cause taxonomy — drives every W3 decision

Every analyst/layer your W1 classifies as **Stub** OR **Degraded** gets a
root-cause classification in W2. The classification dictates the W3
action. **You do not decide based on the analyst's name; you decide
based on the root cause.**

| W2 root cause | What it looks like in the code | W3 action | W5 reweight needed? |
|---|---|---|---|
| `null_default` | Handler catches a null/empty upstream response and returns `{ score: 50, pass: false }` instead of `{ score: null, pass: false }` | Fix handler: when the upstream is empty, return `score: null` with `details.reason: 'no_data'`. Composite skips null scores. | No (weight stays; composite math handles null). |
| `handler_bug` | Compute function returns the seed value (typically the midpoint or zero) before the actual scoring loop executes. Often visible as `let score = 50; ... if (condition) score = realValue; return { score };` where `condition` is never true. | Fix the bug per the diagnosis written in your W2 entry. Add a regression test that constructs a real input and verifies the score is no longer 50. | No. |
| `threshold_misconfig` | Analyst computes a real value but the discretization threshold is unreachable on the data we receive. E.g. an analyst that maps "EPS surprise > 5%" to a score boost where Finnhub returns the surprise as a decimal (0.05) so the threshold never fires. | Re-tune the threshold against the observed distribution from W1. Document the old vs new threshold in your W2 entry and in the audit doc. Add a regression test for the new threshold. | No. |
| `latency` | Cache TTL is much longer than the data refresh cadence, so stale 50s persist for days. Visible as scores that never change even when the underlying data does. | Fix the cache TTL or invalidation. Add a test that confirms a write to the upstream causes the next score read to return the new value. | No. |
| `no_upstream` | The analyst is wired but the upstream data source either never returns useful data (wrong tier, deprecated endpoint, restricted feed) OR returns data for a slice of the universe so narrow it's effectively useless. | If the upstream issue is fixable in this PR (e.g. switch to a different free endpoint), repair. If not, **mark for permanent removal** — set its weight to 0 in `BASE_WEIGHTS` in W5 and redistribute its weight to peers per the rescale math in § 4.5. | YES. |

If your W2 diagnosis suggests a 6th category not in this table —
surface to Chad with one specific question + two concrete options.
Do not invent a new category and proceed silently.

## 4.3 Per-stub diagnosis section template — write one per stub in `audit.md`

```markdown
### <Analyst name> (<board>, <weight>% of <board> composite)

**Verdict:** <Stub | Degraded>  (stdev <X.XX>, <YY>% exactly 50, <ZZ>% null)
**Root cause:** <null_default | handler_bug | threshold_misconfig | latency | no_upstream>

**Evidence:**
- File: `<path/to/analyst.ts>`
- Line(s): <N-M> where the default-50 return / buggy code / stale-cache path lives
- Sample observation: `<ticker> on <date> returned score=<X>, expected approximately <Y> based on <data we saw upstream>`

**Resolution path:** <one paragraph describing the fix that will be
applied in W3 OR the removal that will be applied in W5>

**Predicted post-repair stdev:** <estimate based on the data we expect
to flow through after the fix; this becomes the verification target>
```

Write one such section per stub or degraded analyst, in order of
weight contribution (largest weight first). The audit doc becomes
the canonical record of what was wrong, what was done, and what to
expect.

## 4.4 Audit table format — for `reports/phase-4f/audit.md`

```markdown
# Phase 4f — Stub-Analyst Audit (Run YYYY-MM-DD)

**Sample window:** last <N> days of snapshots
**Coverage:** Target Board × {largecap, russell2k}, Prophet Board × {largecap, russell2k}
**Total observations:** <N> rows

## Summary

- Total analysts/layers reviewed: <N>
- Live: <N>
- Stub: <N>
- Degraded: <N>
- Weighted % of composite affected (Target): <XX.X>%
- Weighted % of composite affected (Prophet): <XX.X>%

## Target Board — largecap

| Analyst | Weight | Mean | StDev | % =50 | % null | Unique | Verdict |
|---------|------:|-----:|------:|------:|-------:|-------:|---------|
| Technical | 15% | | | | | | Live | Stub | Degraded |
| Sector    |  8% | | | | | | |
| Fundamental | 13% | | | | | | |
| Flow | 10% | | | | | | |
| News | 10% | | | | | | |
| Earnings | 7% | | | | | | |
| Macro | 7% | | | | | | |
| Insider | 14% | | | | | | |
| Patents | 6% | | | | | | |
| Political | 10% | | | | | | |

## Target Board — russell2k

[same shape]

## Prophet Board — largecap

| Layer | Weight | Mean | StDev | % =50 | % null | Unique | Verdict |
|-------|------:|-----:|------:|------:|-------:|-------:|---------|
| structure        | 11% | | | | | | |
| momentum         |  9% | | | | | | |
| volume           | 10% | | | | | | |
| volatility       |  6% | | | | | | |
| relativeStrength |  9% | | | | | | |
| fundamental      | 25% | | | | | | |
| catalyst         | 30% | | | | | | |

## Prophet Board — russell2k

[same shape]

## Per-stub diagnosis

[One section per stub or degraded analyst, following § 4.3 template,
sorted by weight descending]

## Final weight table (post-W5 reweighting)

[Fill in only after W5 is complete. Show before/after for any board
where weights changed.]
```

## 4.5 Composite reweight math — null-skipping + permanent removal

Two cases to handle in `composeTarget` (and equivalently
`composeProphet`):

**Case 1: Analyst returns null score on this ticker (no-data condition)**

The analyst is still in `BASE_WEIGHTS` with its original weight.
At score-time, the composite function:
1. Collects scores for all analysts in the table
2. Identifies which scores are non-null
3. Rescales the weights of the non-null analysts so they sum to 1.0
4. Computes the weighted average over the non-null subset
5. Stamps `_scoredAnalysts: ['Technical', 'Sector', ...]` on the
   output so the UI knows which contributed

```ts
export function composeWithNullSkipping(
  scores: Record<string, number | null>,
  weights: Record<string, number>,
): { composite: number; scoredAnalysts: string[] } {
  const live = Object.entries(scores).filter(([, s]) => s !== null && s !== undefined);
  if (live.length === 0) {
    return { composite: 50, scoredAnalysts: [] }; // truly no data anywhere
  }
  const totalWeight = live.reduce((sum, [name]) => sum + (weights[name] ?? 0), 0);
  if (totalWeight === 0) {
    return { composite: 50, scoredAnalysts: live.map(([n]) => n) };
  }
  const weighted = live.reduce(
    (sum, [name, score]) => sum + ((score as number) * (weights[name] ?? 0)) / totalWeight,
    0,
  );
  return { composite: weighted, scoredAnalysts: live.map(([n]) => n) };
}
```

**Case 2: Analyst is permanently removed (no_upstream in W2, removed in W5)**

Set its weight in `BASE_WEIGHTS` to 0. Then proportionally redistribute
the freed weight across the analysts in the **same category** (Target's
analysts cluster by intent — Technical/Sector are technical, Earnings/
Fundamental are fundamentals, Flow/News/Insider are flow, Patents/
Political/Macro are catalyst). Prefer redistribution within category
to preserve the composite's design intent.

```ts
export function redistributeWeight(
  weights: Record<string, number>,
  category: Record<string, string>, // analyst → category
): Record<string, number> {
  // Find zeroed analysts and the freed weight per category
  const freedByCat: Record<string, number> = {};
  for (const [name, w] of Object.entries(weights)) {
    if (w === 0) {
      const cat = category[name];
      freedByCat[cat] = (freedByCat[cat] ?? 0) + 0; // contributes 0 here; the original weight already gone
    }
  }
  // Original weights snapshot read from BASE_WEIGHTS history or
  // committed as a constant before the removal commit
  // Proceed with proportional redistribution
  // ... implementation per W5 brief instructions
  return weights;
}
```

Test cases (in `__tests__/composite-reweight.test.ts`):
- One analyst null → its weight is excluded from numerator + denominator;
  surviving analysts' weights rescale so they sum to 1.0
- All analysts null → composite = 50, `scoredAnalysts: []`
- One analyst permanently removed (weight=0) AND one returns null →
  both excluded; rest rescaled
- Verify the weighted sum: hand-compute the expected composite for a
  3-analyst test case and assert numeric equality (within 1e-9)

## 4.6 Institutional-flow signal interfaces (W4)

```ts
// netlify/functions/shared/institutional-flow/types.ts

export interface DarkPoolSignal {
  ticker: string;
  asOfDate: string;
  darkPoolPct: number;          // 0-1, dark / total volume
  darkPoolPct5dAvg: number;
  darkPoolPct30dAvg: number;
  zScore: number;               // (today - 30d avg) / 30d stdev
  rawDarkVolume: number;
  rawTotalVolume: number;
}

export interface OptionsFlowSignal {
  ticker: string;
  asOfDate: string;
  bullishPremium: number;       // sum premium of bullish trades (calls bought, puts sold) — dollars
  bearishPremium: number;
  netDirectionalPremium: number; // bullish - bearish
  sweepCount: number;
  blockCount: number;
  oiSpikeStrikes: number;
  unusualScore: number;         // 0-100; the analyst consumes this
}

export interface BlockTradeSignal {
  ticker: string;
  asOfDate: string;
  blockCount: number;
  blockNotional: number;        // total $ notional of block trades
  buySideEstimate: number;      // notional at-or-above ask
  sellSideEstimate: number;     // notional at-or-below bid
  buyMinusSell: number;
}
```

Each module exports a single async function:

```ts
// dark-pool.ts
export async function computeDarkPoolSignal(
  ticker: string,
  asOfDate: string,
): Promise<DarkPoolSignal | null>;

// options-unusual.ts
export async function computeOptionsFlowSignal(
  ticker: string,
  asOfDate: string,
): Promise<OptionsFlowSignal | null>;

// block-trades.ts
export async function computeBlockTradeSignal(
  ticker: string,
  asOfDate: string,
): Promise<BlockTradeSignal | null>;
```

These are pure-ish: they hit Polygon, but always with a date param;
no live-now-only paths. The scheduled scanner in W7 calls each one
once per day per ticker; the results cache to Firestore under
`institutionalFlow/{universe}/{ticker}/{YYYY-MM-DD}`.

The repaired Flow + Insider analysts in W3 read FROM the cache, not
directly from Polygon, so live scoring stays fast.

## 4.7 Polygon trade-data essentials (for W4a, W4c)

The `GET /v3/trades/{ticker}` endpoint returns trades with `x`
(exchange code) field. Map by checking Polygon's reference data
endpoint `GET /v3/reference/exchanges` to determine which codes
represent TRF / FINRA off-exchange reporting venues. The exact set
of codes may shift; canonical practice is to:

1. On first run of W4a, hit `/v3/reference/exchanges` once
2. Identify the venues with `type: 'TRF'` or `type: 'ATS'` (ATS =
   alternative trading system, includes most dark pools)
3. Cache that mapping in a constant; treat any trade reported at
   one of those venues as dark/off-exchange

Don't hardcode `[4, 6, 7]` blindly — verify on clone what your actual
account sees today.

## 4.8 Pre/post backtest comparison report template

```markdown
# Phase 4f — Pre vs Post Backtest Comparison

**Window:** YYYY-MM-DD to YYYY-MM-DD
**Universe:** largecap (S&P 500 + NDX + Dow)
**Pre-4f composite:** weighted from main as of <pre-4f commit SHA>
**Post-4f composite:** weighted from this branch as of <head SHA>
**Rebalance rule:** same as Phase 4e-1 W3 (or whatever lives in the
backtest engine config today)

## Summary

| Metric | Pre-4f | Post-4f | Delta |
|--------|------:|-------:|------:|
| Full-window IC (rank) | | | |
| Rolling 1-year window IC mean | | | |
| % of 1-year windows beating SPY | | | |
| Total swap count | | | |
| Avg hold days | | | |

## What changed in the composite

| Analyst/Layer | Pre weight | Post weight | Repair action | Live in post? |
|---------------|-----------:|------------:|---------------|:-------------:|
| <name>        | <X%>      | <Y%>       | <action>      | Y / N         |

## Honest reading

[If IC improved, document. If IC barely moved, document: the
composite is now honest about no-data conditions even if real-data
inputs didn't dramatically improve ranking quality yet. If IC got
WORSE, surface immediately to Chad — something in W3/W4/W5 went
wrong and we don't ship until it's resolved.]
```

## 4.9 UI badge component (W5 — `AnalystContributions.jsx`)

```jsx
function StatusBadge({ status }) {
  // status ∈ {'live' | 'no_data' | 'removed'}
  const config = {
    live:     { label: 'LIVE',     cls: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30' },
    no_data:  { label: 'NO DATA',  cls: 'text-neutral-500 bg-neutral-500/10 border-neutral-500/20' },
    removed:  { label: 'REMOVED',  cls: 'text-neutral-600 bg-neutral-700/10 border-neutral-700/30 line-through' },
  }[status];
  if (!config) return null;
  return (
    <span className={`px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-widest border ${config.cls}`}>
      {config.label}
    </span>
  );
}
```

Test cases:
- All three statuses render with correct label + class
- `null` / `undefined` status renders nothing
- Snapshot test pinning the markup so a future regression on the
  font/border styling gets caught

The badge sits next to each analyst's name in the contribution panel.
If `composite._scoredAnalysts` includes the analyst's name → LIVE.
If the analyst is in the weight table but returned null this snapshot
→ NO DATA. If the analyst is removed entirely (weight = 0) → REMOVED.

---

# PART 5 — CONVENTIONS + GOTCHAS

## 5.1 Commit cadence + messages

One commit per workstream. Suggested sequence:

1. `phase-4f: W1 audit script + first audit run`
2. `phase-4f: W1+W2 audit doc with per-stub diagnoses`
3. `phase-4f: W3 handler repairs (null-default + handler-bug)`
4. `phase-4f: W3 threshold + latency repairs`
5. `phase-4f: W4a dark-pool signal + tests`
6. `phase-4f: W4b options-unusual signal + tests`
7. `phase-4f: W4c block-trades signal + tests`
8. `phase-4f: W4d Quiver Form 4 insider path verified/repaired`
9. `phase-4f: W5 composeWithNullSkipping + weight redistribution`
10. `phase-4f: W5 UI badges (LIVE / NO DATA / REMOVED)`
11. `phase-4f: W6 backtest comparison + report`
12. `phase-4f: W7 scan-institutional-flow-largecap scheduled function`
13. `phase-4f: W9 APP_VERSION + MODEL_VERSION + ORCHESTRATOR + PR description`

Match the commit-message style on `main` (`git log --oneline -20`).
Body: 2-5 short paragraphs explaining what + why. Don't write essays;
don't one-line either.

## 5.2 Branch + push hygiene

Branch: `phase-4f-stub-audit-repair`. Single branch. Push ONCE when
ready for PR. `git rebase -i origin/main` to clean local history
before pushing if needed.

## 5.3 APP_VERSION + MODEL_VERSION rules

- `APP_VERSION` in `src/App.jsx`: bump to `0.18.0-alpha`
- `MODEL_VERSION` in `netlify/functions/shared/model-version.ts`:
  bump to `2026.03.0`
- DO NOT backfill historical snapshots with the new MODEL_VERSION.
  The point of the version bump is to keep pre-4f scores comparable
  to themselves and post-4f scores comparable to themselves; mixing
  them would erase the comparison W6 is designed to make.

## 5.4 Netlify gotchas — read or you'll repeat them

These bit prior phases:

- **Method-conditioned redirects are silently dropped.** Do NOT try
  `from = "/api/x" [method] "POST"` in `netlify.toml`. Either gate
  inside the function or use distinct paths.
- **The `-background.ts` filename suffix gives a 15-min container
  even when invoked via HTTP** (not just via cron). Your
  institutional-flow scanner is NOT background — it runs in ≤5 min
  for ~200 largecap tickers using `mapWithConcurrency` at 8 parallel.
  Don't name it with `-background` suffix.
- **Always smoke-test new redirects on the deploy preview before
  merge.** Routing bugs that ship to prod are expensive to roll back.

## 5.5 Test conventions

- Runner: `vitest`. Tests live under `__tests__/` next to the code.
- `.test.ts` (functions) / `.test.jsx` (React).
- `npm test` runs everything; `npx vitest run <path>` runs a subset.
- Mock Polygon via direct fetch mocking; don't actually network.
- Mock Firestore via the in-memory pattern from
  `snapshot-store-pit.test.ts`.
- New tests should grow count by 50-80.

## 5.6 TypeScript

- `strict: true` is on. No `any` without inline justification.
- `npx tsc --noEmit` must pass before each commit.
- Exported functions: explicit types. Internal helpers: inferred OK.

## 5.7 Polygon API conventions

- Rate limit: 5 calls/sec on the default tier; 100 calls/sec on
  paid tiers. Chad is on a paid tier in production but your local
  audit can hit limits if not careful.
- Always use the existing `data-provider.ts` rate-limit wrapper if
  one exists; inspect that file before raw-fetching Polygon yourself.
- Some endpoints paginate; respect the `next_url` field. Don't
  truncate at page 1 silently.

---

# PART 6 — OPENING THE PR

## 6.1 Push the branch

```bash
git push -u origin phase-4f-stub-audit-repair
```

## 6.2 Open the PR via GitHub API

```bash
# Substitute <PAT>
curl -sS -X POST \
  -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4f — Stub-analyst audit + repair + institutional-flow data",
    "head": "phase-4f-stub-audit-repair",
    "base": "main",
    "body": "See briefs/phase-4f-pr-description.md for the full description.\n\n**Audit:** <N> stubs found across Target + Prophet. <X> repaired, <Y> permanently removed and weight-redistributed. <Z> degraded analysts re-tuned.\n\n**Composite delta:** pre-4f IC <X.XXX> → post-4f IC <Y.YYY>\n\n**New institutional-flow modules:** dark-pool, options-unusual, block-trades\n\n**Versions:** APP_VERSION 0.18.0-alpha, MODEL_VERSION 2026.03.0"
  }'
```

---

# PART 7 — SMOKE TEST ON DEPLOY PREVIEW

After pushing + opening the PR, Netlify auto-builds a deploy preview.
Wait ~90s, then:

```bash
PR=<your PR number>
HOST="https://deploy-preview-${PR}--tradeiq-alpha.netlify.app"

# 1. Bundle has the expected APP_VERSION
curl -sS "${HOST}/" -o /tmp/preview.html
grep -oE "0\.18\.[0-9]+-alpha" /tmp/preview.html | head -1

# 2. Target Board endpoint still serves
curl -sS "${HOST}/api/target?universe=largecap&limit=5" \
  | python3 -m json.tool | head -50
# Look for: _scoredAnalysts field on each pick; composite values that
# aren't all 83-ish (a sign that null-skipping is working)

# 3. The new institutional-flow scan endpoint (if you wired a
#    manual trigger; the scheduled fire happens in prod only)
curl -sS "${HOST}/api/institutional-flow?ticker=NVDA" \
  | python3 -m json.tool

# 4. Open the deploy preview UI for a known-active ticker (NVDA, AMD):
#    confirm the contributions panel shows
#    (a) real values (not 50) on the repaired analysts
#    (b) LIVE badges next to live analysts
#    (c) NO DATA badges next to analysts that genuinely have no data
#       for this ticker
#    (d) REMOVED badges (strike-through) for permanently-removed analysts
```

Scheduled functions don't fire on deploy previews (Netlify cron is
production-only). First real institutional-flow snapshot writes after
merge when prod cron fires at 22:00 UTC next weekday.

---

# PART 8 — HAND-OFF MESSAGE FORMAT

When the PR is mergeable, post a SINGLE message in this conversation
with EXACTLY this shape:

```
PR #<N> open: https://github.com/DavisDelivery/TradeIQ/pull/<N>

Audit summary (W1 + W2):
- Total analysts/layers reviewed: <N>
- Live: <N>
- Stub: <N>
- Degraded: <N>
- Weighted % of Target composite affected: <XX.X>%
- Weighted % of Prophet composite affected: <XX.X>%

W3 repairs applied:
- null_default fixes: <N>
- handler_bug fixes: <N>
- threshold_misconfig retunes: <N>
- latency fixes: <N>

W5 permanent removals:
- <N> analyst(s)/layer(s) removed with weight redistribution
- Weight redistribution details in reports/phase-4f/audit.md § Final weight table

W4 institutional-flow modules (new):
- dark-pool: implemented + tested
- options-unusual: implemented + tested
- block-trades: implemented + tested
- Quiver Form 4 insider path: <verified | repaired>

W6 backtest comparison:
- Pre-4f composite IC: <X.XXX>
- Post-4f composite IC: <Y.YYY>
- Delta: <±X.XXX>
- Honest read: <1-sentence interpretation>

Verification:
- npx tsc --noEmit: clean
- npm test: <N> passing  (baseline was <M>)
- npm run build: clean
- Deploy preview smoke: pass
- Re-run of audit script on post-4f snapshots: every repaired analyst
  now classified Live (stdev > 5, % exactly 50 < 25%)

Versions: APP_VERSION 0.18.0-alpha, MODEL_VERSION 2026.03.0
```

That's the message. Don't recap the brief, don't propose next phases,
don't apologize for any judgment calls. The numbers speak.

---

# PART 9 — FAILURE MODES TO AVOID

- **Skipping W1 and going straight to W4 because dark-pool feels more
  interesting.** The audit is what tells you which analysts need real
  data vs which need handler fixes vs which are unrecoverable. Adding
  dark-pool data to an analyst that has a null-default bug just means
  the bug returns 50 with dark-pool context attached. Order is W1 →
  W2 → W3 → W4 → W5 → W6.
- **Producing fake W1 audit findings against mocked data.** Mocked
  Firestore in `npm test` proves the audit script works; it does NOT
  produce real classifications. If Chad has not provided
  `FIREBASE_SERVICE_ACCOUNT` by the time you're ready to run W1
  live, the audit doc is **PENDING LIVE-DATA RUN** — write the
  script, write the tests, document the gap, hand off. Synthesizing
  "8 of 17 analysts are Stub" against fixture data and then doing
  W3 repairs on those imaginary findings is exactly the dishonesty
  W3 exists to remove. 4e-1 set this precedent — read its
  `reports/phase-4e-1/backtest-validation.md` for the PENDING posture
  if you're unsure how to write it.
- **Hardcoding specific analyst names into your W3 logic.** W3
  decisions come from the W2 root-cause classifications, not from
  the orchestrator's pre-conceived list. If your W1 audit classifies
  all 5 Target analysts Chad's screenshot showed as `no_upstream`,
  you remove and reweight; if it classifies them all as `null_default`,
  you repair handlers. Both are valid outcomes of the same brief.
- **Inventing a 6th root-cause category and proceeding silently.**
  Surface to Chad with one question + two options.
- **Quietly raising the Stub/Live thresholds because too many analysts
  failed the test.** The thresholds (stdev > 5 AND % exactly 50 < 25%
  for Live; stdev < 2 OR % exactly 50 > 60% for Stub) are calibrated
  to catch real dishonesty. If 8 of 10 Target analysts come out Stub,
  that's information for Chad, not a reason to retune the test.
- **Re-deriving historical snapshots with the new MODEL_VERSION.**
  Don't backfill. Pre/post comparison in W6 requires the original
  noisy snapshots to exist.
- **Touching analysts/layers your W1 classified as Live.** If it's not
  broken, don't touch it. The PR diff should reflect a tight,
  surgical set of edits scoped to what W1+W2 identified.
- **Returning to 50 as a "graceful fallback" anywhere.** The whole
  point of W3 is to make missing-data conditions honest. If a
  computation can't produce a real score, return null. The composite
  function handles null-skipping. Never default to 50.
- **Quoting any literal API key / PAT / SA-JSON anywhere in committed
  code.** Repo has secret-scanning enabled; literal leak blocks merge.

---

# PART 10 — PARALLEL CONTEXT

Phase 4f is **not run in parallel** with anything currently active.
Phase 4e-1 (Prophet Portfolio engine) and Phase 5a (ML discovery) are
both expected to be merged before you start, primarily to avoid
review-merge collisions on `prophet-layers.ts` (4f rewrites
`BASE_WEIGHTS`; 4e-1 reads from it via the RankingSignal).

If 4e-1 has already merged when you start, its
`reports/phase-4e-1/backtest-validation.md` § 0 layer activity audit
table is reference data for the Prophet-largecap rows of your own W1
audit — one input among four (you also audit Prophet-russell2k,
Target-largecap, Target-russell2k). Don't treat 4e-1's table as a
substitute for W1; the methodology is broader and the audit doc you
produce is the canonical record.

If 4e-1 has NOT yet merged when you start (and Chad has explicitly
OK'd starting 4f early), W1 generates the full data from scratch
without any reference inputs. The result is the same; just more work
in W1.

Phase 4f's outputs feed forward:
- Phase 4e-2 (the UI tab on the portfolio engine) will surface the
  LIVE/NO_DATA/REMOVED badges from W5 if it inherits the contribution
  panel from Target Board's pattern
- Phase 5a's re-run (if any) will train on snapshots produced under
  MODEL_VERSION 2026.03.0; the honest no-data null-skipping should
  materially change which features matter
- Phase 5b (deploying any ML winner from 5a) plugs into the same
  `RankingSignal` interface 4e-1 built; that interface is unchanged
  by 4f

---

End of kickoff. Read `briefs/phase-4f-brief.md` (also embedded in
PART 3 above), then start with W0.
