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
