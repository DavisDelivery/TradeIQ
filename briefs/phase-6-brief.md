# Phase 6 — Comprehensive Stock Detail Panel

> **For the executor:** this brief is your full assignment. Read it
> end-to-end before any code. The companion kickoff at
> `kickoffs/phase-6-executor.md` is your paste-and-go boot prompt.
> This is a LARGE multi-workstream product phase. Each workstream
> ships as its own PR for incremental review and shipping. Do NOT
> try to land it as one mega-PR.

---

## TL;DR

When the user taps a stock on the Williams or Lynch boards, the
detail panel is essentially empty — a score and a ticker, no thesis,
no charts, no metrics, nothing. The target board panel got a
shallow accordion (Phase 4q) but no charts, no metrics, no
catalysts, no risks. The app has been a screener with an output, not
a research tool with a decision-support view.

Phase 6 fixes that. Across all three boards (Williams, Lynch, target),
the stock detail panel becomes a comprehensive view that lets the
user make or refute a thesis in under 30 seconds: a real strategy-
specific thesis paragraph, interactive price + fundamental +
relative-strength charts, a key metrics panel with sector-median
context, a recent catalysts feed, falsifiable risk callouts, and a
deeper score breakdown that exposes the underlying signals (not just
rationale strings).

5 workstreams, ~7 PRs, mobile-first AND desktop-rich. Both layouts
are first-class.

---

## Context — why this phase exists

The owner's direct framing: *"I'm trying to build the most
comprehensive personal trading app I humanly can, and there's not
enough information in this app in the places it should be. You're not
building this app like you are a savvy stock picker that needs
information at their fingertips, and is also a chief technical
officer who can build really intricate, highly detailed
applications."*

That is the bar. Two roles to inhabit:

1. **The savvy stock picker who knows what info matters** —
   what's the thesis, what are the signals, what would break it,
   what's the chart telling you, how does this compare to its sector,
   what's the next catalyst, is anyone with information selling?
2. **The CTO who builds intricate, highly detailed applications** —
   information density without clutter, hierarchy that respects scan
   patterns, mobile and desktop both first-class, performant data
   loading, robust error states, accessible interactions.

The previous orientation — quant verification rigor (4q, 4r, 4s, 4t,
4u) — produced honest backtest infrastructure. That work continues
in W1b and W1c (separate agents, separate problems, do not touch).
Phase 6 is the missing other half: the actual product the user
opens every day to research and decide.

---

## What already exists (read-only baseline)

### Backend

- `GET /api/target-rationale?ticker=X` (Phase 4q, merged PR #50) —
  the model to follow. Live recompute via `runAnalystsForTicker`,
  returns per-analyst score, direction, weight, confidence, rationale
  string, and signals object (including `_noData`/`_reason`).
- `GET /api/target-board` — returns the target board snapshot.
- `GET /api/ticker-info?ticker=X` — basic ticker info.
- `GET /api/price-history` — price history endpoint (probe to confirm
  exact shape and date-range parameters).
- `GET /api/backtest-runs/...` — backtest run family (not relevant
  to this phase).
- Existing data providers in `netlify/functions/shared/`:
  - `data-provider.ts` → `getFundamentals`, `getEarningsHistory`,
    `getUpcomingEarnings`, `getNews`, etc.
  - `insider-provider.ts` → `getInsiderActivity`
  - `political-provider.ts` → `getPoliticalActivity`
  - `patent-provider.ts` → `getPatentActivity`
  - `earnings-intel.ts` → `getEarningsIntel`
- Williams + Lynch scoring lives in their respective modules
  (likely `analysts/williams.ts` and `analysts/lynch.ts` or similar;
  search the repo to confirm).

### Frontend

- `src/components/AnalystContributions.jsx` — the 4q accordion
  pattern. Uses React Query via `src/lib/queryKeys.js`, session-
  memoized (`staleTime/gcTime: Infinity`). Inline accordion with
  `<button>` + `aria-expanded` + humanized signals table.
- `src/hooks/useTargetRationale.js` — the hook pattern to mirror.
- `src/TargetBoardView.jsx` — target board UI.
- The target-board detail panel renders on mobile (modal) AND
  desktop (Phase 4k docked panel). Both must remain first-class.
- Williams + Lynch board view components — find them (likely
  `WilliamsBoardView.jsx`, `LynchBoardView.jsx`); their detail
  panels are the ones currently empty.
- Tailwind for styling, dark mode default, IBM Plex Mono font,
  brand blue `#1e5b92`, emerald accent `#14e89a`. The visual
  language is dark + monospace + emerald accent — keep that.

### Dependencies already in the project

- React Query (TanStack Query) — use it; do not add new fetching
  libraries.
- Recharts — primary charting library for non-OHLC charts.
- `lucide-react` for icons.
- `mathjs`, `lodash` for utilities if needed.
- Possibly `lightweight-charts` (verify in `package.json`). If not
  present and you genuinely need OHLC + crosshair quality for the
  price chart, surface to orchestrator BEFORE adding the dep —
  it's a meaningful new dependency worth a 60-second sanity check.

---

## The vision — what the comprehensive detail panel does

When the user taps a stock on Williams, Lynch, or target:

```
┌─────────────────────────────────────────────────────────┐
│  HERO        AAPL  Apple Inc.  ·  Technology            │
│              $238.42  +1.4%   ·  Lynch score 87  long   │
├─────────────────────────────────────────────────────────┤
│  THESIS                                                 │
│  Fast-grower thesis — EPS growth 28%, PEG 0.92,         │
│  debt/equity 1.42 (below sector median 1.85), net       │
│  insider buying $84M over the last 90 days. The         │
│  Lynch screen captures Apple as a reasonably-priced     │
│  compounder with cash-rich fundamentals.                │
├─────────────────────────────────────────────────────────┤
│  PRICE CHART                              1Y default    │
│  [interactive chart, 50/200 MA, earnings markers,       │
│   strategy levels overlaid]            [1M 3M 6M 1Y 5Y] │
├─────────────────────────────────────────────────────────┤
│  KEY METRICS                          vs sector median  │
│  P/E         29.4    sector 26.1   ●                    │
│  P/S          8.1    sector  4.2   ●                    │
│  EV/EBITDA   22.8    sector 18.5   ●                    │
│  Debt/Eq     1.42    sector  1.85  ●                    │
│  ROE         147%    sector  18%   ●                    │
│  Op Margin   31.2%   sector 22.4%  ●                    │
│  Div Yield   0.5%    sector  1.2%  ●                    │
│  Short Int   0.8%    sector  2.1%  ●                    │
├─────────────────────────────────────────────────────────┤
│  RELATIVE STRENGTH                                      │
│  [chart: AAPL vs SPY and vs XLK over 1Y]                │
├─────────────────────────────────────────────────────────┤
│  FUNDAMENTALS         [Revenue | EPS | Margins]         │
│  [chart for selected metric over 5Y]                    │
├─────────────────────────────────────────────────────────┤
│  CATALYSTS                                              │
│  · Q4 FY24 earnings   2025-02-15 (in 28d)               │
│    Street EPS estimate $2.35                            │
│  · Q3 FY24 earnings   2024-11-01                        │
│    EPS $2.20 vs $2.10 est (+4.7%), stock +1.8%          │
│  · Insider:  CFO sold $12.4M on 2024-11-15 (Form 4)     │
│  · News (3): [headline 1]  [headline 2]  [headline 3]   │
├─────────────────────────────────────────────────────────┤
│  RISK CALLOUTS                                          │
│  ✗ Thesis breaks if EPS growth falls below 15%          │
│  ✗ Thesis breaks if PEG rises above 1.5                 │
│  ✗ Caution if insider net selling pattern resumes        │
├─────────────────────────────────────────────────────────┤
│  SCORE BREAKDOWN                                  ▾     │
│  Growth        92  ▾  EPS growth 28%, rev growth 19%    │
│  PEG           88  ▾  PEG 0.92 (favorable < 1.0)        │
│  Debt          84  ▾  D/E 1.42 vs sector median 1.85    │
│  Insider       78  ▾  net $84M buys, 0 cluster sells    │
│  Sector        65  ▾  Technology +6.2% vs SPY (leading) │
└─────────────────────────────────────────────────────────┘
```

The above is illustrative — exact layout is the executor's design
work within the visual principles below. Mobile compresses this into
a scrollable single column with the same content order. Desktop
docked panel expands to 2-column layout where it makes sense (charts
full-width, metrics + catalysts side-by-side).

The 30-second scan path:
1. **Hero** tells the user *what* and *how does the strategy rate it*
2. **Thesis** tells *why* in plain English
3. **Price chart** tells *what's the setup look like*
4. **Key metrics** tells *how does this compare to its sector*
5. Below the fold: catalysts, risks, score breakdown for deeper dig

---

## Workstreams (each ships as its own PR)

### W1 — Backend: rationale endpoints + detail data API

**Two parts.** Both ship in one PR (call it PR-A).

#### W1.a — Williams + Lynch rationale endpoints

Mirror the 4q `/api/target-rationale` pattern exactly:

- `GET /api/williams-rationale?ticker=X` → returns:
  - Per-component score breakdown (momentum, value, sector, etc.) —
    each with score, direction, weight, rationale string, signals
    object (with numeric underlying values)
  - The synthesized **thesis paragraph** (2-3 sentences) generated
    server-side from the strongest signals
  - Strategy-specific **risk callouts** (array of falsifiable
    trigger strings)
- `GET /api/lynch-rationale?ticker=X` → same shape, Lynch components
  (growth, PEG, debt/equity, insider, sector)
- Both: live recompute (no snapshot bloat — Phase 4u lesson)
- Both: add `[[redirects]]` blocks in `netlify.toml`
- Both: live unit tests against the data layer (mocked providers)

**The thesis paragraph generation** is strategy-aware code on the
server side. Examples (use these as the spec, refine the prose):

- Williams thesis template (when signals fire): *"Momentum-value
  combo firing — 13-week RS [+18%] vs SPY, P/E [11.2] below sector
  median [18.4], in a leading sector ([Energy] +6.2% vs SPY).
  Williams's value screen captures this name as cheap with relative
  strength behind it."* Variant when only momentum fires, when only
  value, etc.
- Lynch thesis template: *"Fast-grower thesis — EPS growth [32%],
  PEG [0.8], debt/equity [0.6] below sector median [1.4], [net
  insider buying $5M] over the last 90 days. Lynch's screen captures
  this as growth at a reasonable price with insider conviction."*
  Variants for slow-grower, stalwart, etc.

The thesis function returns plain text (or markdown). The strategy
files (`analysts/williams.ts`, `analysts/lynch.ts` or wherever the
scoring lives) get a new `generateThesis()` companion that consumes
the same scored signals.

**The risk callouts** are an array of falsifiable trigger strings,
strategy-specific:

- Williams: `["If 13-week RS turns negative for 4+ weeks, momentum
  leg breaks", "If P/E expands above sector median, value leg
  weakens", "If sector relative strength inverts, sector tailwind
  gone"]`
- Lynch: `["If EPS growth falls below 15%, fast-grower thesis
  breaks", "If PEG rises above 1.5, no longer growth at reasonable
  price", "If debt/equity exceeds sector median, financial
  flexibility reduced", "If insider pattern flips to net selling,
  conviction signal breaks"]`
- Target (composite): top-3 analyst flip triggers from the analysts
  currently driving the score

#### W1.b — Comprehensive stock detail data endpoint

`GET /api/stock-detail?ticker=X` returns a bundle for the rest of
the panel beyond the rationale:

```typescript
{
  ticker: string,
  name: string,
  sector: string,
  price: number,
  dayChangePct: number,
  marketCap: number,

  metrics: {
    valuation: { pe, ps, evEbitda, pb },
    profitability: { grossMargin, opMargin, roe, roa },
    health: { debtEquity, currentRatio, interestCoverage },
    market: { beta, shortInterest, dividendYield, range52w: {low, high, currentPctile} },
  },

  sectorMedians: {
    // same shape as metrics, sector-median values for context
  },

  catalysts: {
    lastEarnings: { date, epsActual, epsEstimate, surprisePct, priceReactionPct },
    nextEarnings: { date, daysUntil, epsEstimate },
    news: Array<{ headline, source, date, url, sentiment }>,  // last 30d, top 5
    insider: { net90dDollarVolume, last: { role, action, dollarValue, date } },
    upcomingEvents: Array<{ type, date, description }>,
  },

  fundamentalsHistory: {
    quarterly: Array<{ period, revenue, eps, grossMargin, opMargin }>,  // last 20q ≈ 5y
  },

  relativeStrength: {
    vsSpy: Array<{ date, cumulativeOutperformancePct }>,
    vsSector: Array<{ date, cumulativeOutperformancePct }>,
  },
}
```

Source: aggregate from existing providers. Likely needs a small new
helper `getSectorMedians(sector, metricList)` that computes medians
from the universe at the live price (cached for ~1h to avoid recompute
on every detail-panel open — coordinate cache via React Query's
session memoization).

**No board snapshot bloat** — this endpoint is on-demand per ticker,
session-memoized in the SPA (Phase 4u lesson, again).

### W2 — Frontend: detail panel shell + thesis component

Ships as PR-B.

#### Components

- `StockDetailPanel.jsx` — top-level orchestrator. Accepts `board`
  (`'williams' | 'lynch' | 'target'`) and `ticker`. Determines
  which rationale endpoint to call.
- `StockDetailHero.jsx` — name, ticker, sector, price, day change,
  board-specific score badge.
- `ThesisParagraph.jsx` — renders the thesis from the rationale
  endpoint. Plain text or markdown.
- `useStockDetail.js` — React Query hook for `/api/stock-detail`,
  session-memoized.
- `useWilliamsRationale.js` / `useLynchRationale.js` — mirror
  `useTargetRationale`.

#### Layout

- **Mobile** (< 768px): single column, sections stack vertically.
  Top-to-bottom scroll. Charts use full width. Score breakdown
  remains accordion-collapsed by default.
- **Desktop docked panel** (Phase 4k): the docked panel is fixed
  width (~440-520px); within it the layout stays mostly single-
  column but with denser typography and visible-by-default
  sub-sections. The desktop modal-view (when not docked) gets
  2-column layout where it makes sense.
- Section order, top to bottom: Hero → Thesis → Price chart → Key
  metrics → Relative strength → Fundamentals → Catalysts → Risk
  callouts → Score breakdown.

#### Acceptance for W2

- Tapping a stock on Williams, Lynch, or target opens the panel
  with the hero + thesis paragraph + a stub for each section below.
- The thesis paragraph renders correctly for at least one specific
  test ticker per board (smoke test).
- Mobile and desktop docked both render without layout breakage.
- Loading states (skeleton) on each section while data fetches.
- Error states (graceful: "Couldn't load — tap to retry") on failure.

### W3 — Frontend: charts (price + relative strength)

Ships as PR-C.

#### W3.a — Interactive price chart

Component: `PriceChart.jsx`

Library decision: start with **Recharts** (already in deps). The
price chart is a `LineChart` with overlays. If you find that
Recharts cannot deliver crosshair + tooltip + zoom UX that feels
*responsive on mobile*, surface to orchestrator before adding
`lightweight-charts` as a new dep — that's a meaningful dep
addition worth a 60-second checkpoint.

Features:
- Time range selector: 1M / 3M / 6M / **1Y (default)** / 5Y / All
- 50-day and 200-day moving averages as overlay lines (toggleable)
- Strategy-specific entry/exit levels marked horizontally on the
  chart:
  - Williams: the 13-week RS breakeven (price level where RS hits 0
    based on current SPY)
  - Lynch: the PEG=1.0 price level (price at which PEG would equal 1
    given current EPS growth)
  - Target: not applicable; skip the level overlay for target
- Earnings event markers (small dots on the date axis at earnings
  dates)
- Mobile: tap to show tooltip with date + price; pinch-zoom OK if
  Recharts supports it cleanly (otherwise the range selector is
  sufficient)
- Desktop: hover crosshair with tooltip; scroll-wheel zoom OK if
  feasible

Data: existing `/api/price-history` (probe its shape and date-range
params; extend if needed to include MA values OR compute MAs
client-side from the price series).

#### W3.b — Relative strength chart

Component: `RelativeStrengthChart.jsx`

Two lines on one chart:
- Stock cumulative return vs SPY (over time)
- Stock cumulative return vs sector ETF (over time)

X axis: time, 1Y default with range selector.
Y axis: percentage outperformance, 0 line clearly drawn.
Emerald-green line for SPY comparison, brand-blue line for sector.

Data: comes from `/api/stock-detail`'s `relativeStrength` field.

### W4 — Frontend: fundamental charts

Ships as PR-D.

Component: `FundamentalCharts.jsx`

Three charts behind a tab selector at the top:
- **Revenue** (5Y, quarterly): bar chart with quarter-over-quarter
  values, YoY % growth labels above each bar
- **EPS** (5Y, quarterly): bar chart
- **Margins** (5Y, quarterly): two lines on one chart — gross margin
  and operating margin

Default tab: Revenue.

Data: `/api/stock-detail`'s `fundamentalsHistory.quarterly` field.

Sector median overlay is *optional* for this workstream — defer if
data costs are high. Surface to orchestrator if including it would
require a new aggregation endpoint.

### W5 — Frontend: information panels (metrics + catalysts + risks + score breakdown)

Ships as PR-E.

#### W5.a — Key metrics panel

Component: `KeyMetricsPanel.jsx`

Layout:
- **Mobile**: 2-column rows, metric name + value/median stacked
- **Desktop docked**: same as mobile (the docked panel is narrow)
- **Desktop modal-view** (if any): 4-column grid

For each metric, render:
- Metric name (label)
- Stock value (large, monospace font, bold)
- Sector median (smaller, beneath: "sector: X")
- Color indicator dot: emerald if favorable vs median, amber if
  slightly unfavorable, red if significantly unfavorable. Favorable
  direction is metric-specific (low P/E favorable, high ROE
  favorable, etc.)

Groups:
- Valuation (P/E, P/S, EV/EBITDA, P/B)
- Profitability (gross margin, op margin, ROE, ROA)
- Financial health (debt/equity, current ratio, interest coverage)
- Market (beta, short interest, dividend yield, 52w range position)

Group headers as small caps section dividers.

Data: `/api/stock-detail`'s `metrics` + `sectorMedians` fields.

#### W5.b — Catalysts feed

Component: `CatalystsFeed.jsx`

Time-ordered list, newest first. Sections:
- **Earnings** — last earnings result (date, EPS actual vs est,
  surprise %, stock reaction %), next earnings date (with countdown
  in days), Street EPS estimate.
- **Insider** — net 90d dollar volume, most recent transaction
  detail (role, action, amount, date).
- **News** — last 30d, top 5 by relevance. Each item: headline,
  source, date, link icon. Sentiment indicator (positive/negative/
  neutral) if available.
- **Upcoming events** — ex-dividend, splits, conferences.

Each section is collapsible (accordion) but expanded by default on
mobile (to show value at a glance) and expanded on desktop.

Data: `/api/stock-detail`'s `catalysts` field.

#### W5.c — Risk callouts

Component: `RiskCallouts.jsx`

Bulleted list, no nesting. Each item:
- Red ✗ icon
- Falsifiable trigger string from the rationale endpoint
- Optional severity indicator (none for now; keep it simple)

Style: dense, scannable, terse. No hedging. *"If EPS growth falls
below 15%, the fast-grower thesis breaks."* Not *"the thesis might
weaken if growth slows somewhat."*

Data: rationale endpoint's `riskCallouts` array.

#### W5.d — Score breakdown deepening

Extend `AnalystContributions.jsx` (Phase 4q) OR create board-specific
variants. Recommended: create one shared component
`ScoreBreakdown.jsx` that consumes a generic per-component shape:

```typescript
type ScoreComponent = {
  name: string;
  score: number;
  weight: number;
  direction: 'long' | 'short' | 'neutral';
  rationale: string;
  signals: Record<string, number | string | boolean>;  // numeric values exposed
  noData?: boolean;
  noDataReason?: string;
};
```

The component renders the accordion (mirroring the 4q UI pattern)
and works for Williams (5-6 components), Lynch (5 components), and
target (10 analysts). Expanding a row shows the signals as a
humanized key/value table with **numeric values**, not just the
rationale string (which was the 4q shallow limit).

Numeric value example for Lynch / Growth row expanded:
- EPS growth (3y CAGR): 28.3%
- Revenue growth (3y CAGR): 19.1%
- Quarter-on-quarter EPS: +12.4%

Numeric value example for Williams / Momentum row expanded:
- 13-week relative strength: +18.4%
- 26-week relative strength: +12.1%
- Above 50-day MA: yes
- Above 200-day MA: yes

Removed-from-composite rows (weight = 0): non-expandable, greyed.
Mirror the 4q pattern.

### Optional later workstream — W6 deferred to a follow-up phase

Things explicitly NOT in Phase 6's scope but worth logging as
follow-ups:

- Custom watchlist UI (the user can mark stocks across boards)
- Comparison view (side-by-side two stocks)
- Historical view of a stock's score over time
- Export to PDF / share thesis link
- Mobile push notification on catalyst trigger

These are real product directions. Surface to orchestrator if any
become urgent during Phase 6 work.

---

## Visual design principles

- **Dark mode default.** Brand blue `#1e5b92`, emerald accent
  `#14e89a`. IBM Plex Mono font.
- **Information density without clutter.** A trader's screen, not a
  consumer app. Comfortable but tight spacing. Real data is the
  hero, not whitespace.
- **Monospace for numbers.** All numeric values in IBM Plex Mono so
  they align visually in lists and tables.
- **Color as signal, not decoration.** Emerald = favorable / long /
  positive. Red = unfavorable / risk / negative. Amber = caution /
  neutral-with-flag. Brand blue = neutral information / navigation.
  No purple unless it carries semantic weight.
- **Mobile-first AND desktop-rich.** Both layouts are first-class.
  Don't ship a phone-only design that scales up awkwardly OR a
  desktop-only design that hides content on mobile.
- **Performance matters.** Charts must not block initial paint.
  Lazy-load below-the-fold sections. Show skeletons during fetch.
  Each endpoint is independent — one slow fetch should not block
  the others.
- **No emojis as semantic indicators.** Use lucide-react icons or
  Tailwind glyphs. Emojis are for casual UI, not a research tool.
- **Falsifiable language in risk callouts.** No hedging. Concrete
  trigger conditions.

---

## Acceptance criteria

### Per-workstream

- **W1**: rationale endpoints respond with the full per-component
  breakdown + thesis + risk callouts. `tsc --noEmit` clean. Tests
  cover the happy path + no-data state + bad-ticker error. Sample
  curl response committed to brief or PR description for one ticker
  per board.
- **W2**: detail panel renders for each board with hero + thesis +
  stubs for below sections. Loading and error states correct on
  both mobile and desktop docked panel.
- **W3**: price chart renders with MA overlays + strategy level +
  earnings markers; relative strength chart renders with SPY + sector
  comparisons. Both responsive.
- **W4**: fundamental tabs (Revenue/EPS/Margins) render with 5Y
  quarterly data.
- **W5**: metrics panel, catalysts feed, risk callouts, and score
  breakdown all render with real data. Score breakdown shows
  numeric signal values on expansion (not just rationale strings).

### Phase-level

- All five PRs merge into main without regression to existing
  functionality (target board still works, the 4q endpoint still
  works).
- Each PR's checks green (tsc, tests, Netlify build).
- APP_VERSION bumped one patch per PR.
- MODEL_VERSION unchanged across Phase 6 (no scoring math changes).
- The user can tap a Williams or Lynch stock, see a thesis paragraph,
  see a price chart, see key metrics with sector context, see
  catalysts, see risks, expand the score breakdown — all in one
  scroll/tap session.

---

## Out of scope (explicit)

- Changes to scoring math (analyst formulas, Williams/Lynch
  algorithms, composite logic). Phase 6 surfaces existing scoring;
  doesn't modify it.
- The W1b russell2k coverage gap (separate agent, PR #52).
- The W1c chronic-silent-analysts fix (separate agent, PR #53).
- The 4t verdict report.
- Phase 4v earnings overhaul (planned, pending 4t verdict).
- Phase 5a ML pipeline (separate track).
- New data providers or external API integrations beyond what's
  already wired.
- Backtest engine changes.
- Custom watchlist UI, comparison view, historical score view,
  share/export features (logged as follow-up phase candidates).

---

## Disciplines

- **One workstream, one PR.** Do NOT try to land Phase 6 as a single
  mega-PR. Each workstream ships independently for review.
- **Mobile-first development.** Build mobile layout first, then
  desktop docked. Never the inverse.
- **Honest no-data states.** When a metric, catalyst, or signal
  isn't available, render explicit "no data" UI — never a misleading
  zero or placeholder. The 4q greyed/italic pattern is the model.
- **No new dependencies without a checkpoint.** If you want to add
  `lightweight-charts` (for price chart quality) or any other new
  library, surface to orchestrator FIRST. Recharts is the default.
- **No regressions on existing UI.** The target board's 4q
  accordion still works after Phase 6. The Williams + Lynch board
  list views still work.
- **Performance is part of correctness.** A panel that takes 8
  seconds to fully load is broken even if it's pixel-perfect.
- **Honest reporting.** If you can't deliver a workstream as drawn
  in the brief — e.g., the data isn't there, the chart library
  can't do what's needed — say so honestly. Don't ship a
  half-working version and call it done.

---

## Reference state

### Phase status this brief assumes

- 4q (clickable rationale, target board): MERGED + VERIFIED, PR #50
- 4r/4s/4u: MERGED
- 4t W1: MERGED, PR #48 (PIT scoring path for target board)
- 4t-recovery: MERGED, PR #51
- 4t W2/W3 (verdict): backtest data available, verdict pending
- 4t W1b (russell2k UNIVERSE_HISTORY): PR #52 draft, separate agent
- 4t W1c (chronic-silent earnings + insider): PR #53 draft, separate
  agent (earnings fix authorised, insider awaiting probe)
- 4v (earnings overhaul): PLANNED, pending 4t verdict
- 5a (ML pipeline): scaffolding only, awaiting training data

### Files most likely involved

#### Backend (W1)
- New: `netlify/functions/williams-rationale.ts`
- New: `netlify/functions/lynch-rationale.ts`
- New: `netlify/functions/stock-detail.ts`
- New helpers: `netlify/functions/shared/sector-medians.ts`,
  `netlify/functions/shared/thesis-generation.ts`,
  `netlify/functions/shared/risk-callouts.ts`
- Modify: `netlify.toml` (3 new redirect blocks)
- Modify: `netlify/functions/shared/analyst-runner.ts` ONLY if
  needed to expose Williams/Lynch per-component scoring (additive
  function, do not change existing scoring).
- Read-only references:
  - `netlify/functions/target-rationale.ts` (4q endpoint — pattern
    to mirror)
  - Williams scoring file (probably `analysts/williams.ts` or
    similar — find it)
  - Lynch scoring file (probably `analysts/lynch.ts` or similar)

#### Frontend (W2-W5)
- New: `src/components/StockDetailPanel.jsx`
- New: `src/components/StockDetailHero.jsx`
- New: `src/components/ThesisParagraph.jsx`
- New: `src/components/PriceChart.jsx`
- New: `src/components/RelativeStrengthChart.jsx`
- New: `src/components/FundamentalCharts.jsx`
- New: `src/components/KeyMetricsPanel.jsx`
- New: `src/components/CatalystsFeed.jsx`
- New: `src/components/RiskCallouts.jsx`
- New: `src/components/ScoreBreakdown.jsx` (or extend
  `AnalystContributions.jsx`)
- New hooks: `src/hooks/useWilliamsRationale.js`,
  `useLynchRationale.js`, `useStockDetail.js`
- Modify: `src/lib/queryKeys.js` (add new query keys)
- Modify: Williams + Lynch board view components (wire the panel in;
  find them in repo)
- Modify: `src/TargetBoardView.jsx` if needed to swap in the new
  `StockDetailPanel` (or extend the existing component to use the
  new shared score breakdown)
- Modify: `src/App.jsx` (APP_VERSION bump per PR)

#### Files you may NOT modify (in any workstream)

- Any analyst scoring file (`analysts/*.ts`, `analysts/core.ts`,
  `analysts/williams.ts`, `analysts/lynch.ts` math itself —
  read-only)
- Backtest engine (`shared/backtest/*`) — Phase 4t territory
- Recovery / reinvoke / sweep code (PR #51 territory)
- W1b russell2k path or W1c chronic-silent code (separate agents)
- Snapshot endpoints (`target-board`, `williams-board`,
  `lynch-board`) — do not bloat snapshots with detail data; the
  on-demand endpoints are the path
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
- `package.json` (no new deps without orchestrator checkpoint)

---

## Recommended sequencing + PR breakdown

**PR-A (W1)**: Backend rationale + detail endpoints.
- Most foundational; everything depends on this data being
  available.
- ~600-900 LOC depending on thesis/risk generation complexity.
- ~6-10 hour session.

**PR-B (W2)**: Detail panel shell + thesis component + section
stubs.
- Unblocks all subsequent visual work.
- ~400-600 LOC.
- ~3-5 hour session.

**PR-C (W3)**: Price chart + relative strength chart.
- Most visually impactful; ship early to validate chart UX.
- ~500-800 LOC depending on chart polish.
- ~5-8 hour session.

**PR-D (W4)**: Fundamental charts.
- ~300-500 LOC.
- ~3-4 hour session.

**PR-E (W5)**: Metrics panel + catalysts + risks + score breakdown.
- Largest content workstream; ships the rest of the panel.
- ~700-1100 LOC.
- ~6-10 hour session.

Total estimated effort: 23-37 hours of agent work across 5 PRs.

If you find a workstream is significantly larger than estimated,
STOP and surface to orchestrator — the brief may need re-scoping.

---

## Hand-off format

After each PR opens (ready-for-review, NOT draft):

```
PHASE 6 PR-[A/B/C/D/E] — [workstream name] — PR #N open:
  https://github.com/DavisDelivery/TradeIQ/pull/N

Summary:
- <one-line per major change>

Endpoints / components added:
- <list>

Verification:
- tsc --noEmit: clean
- npm test: <count>
- build: clean
- Mobile rendered correctly: <yes/no — screenshots in PR description>
- Desktop docked rendered correctly: <yes/no>

Notes / caveats:
- <any honest flags>

Acceptance: DEFERRED to orchestrator review + merge.
Next: PR-[next letter] — [next workstream]
```

Each PR must be opened **ready-for-review** (not draft) and include
at least one mobile screenshot + one desktop screenshot in the PR
description.

---

## Session size estimate

This is a multi-PR phase. Each PR is a session of its own. Do NOT
attempt to land more than one PR per session — chunking matters for
review quality.

If at any point a workstream surfaces a design question with
multiple valid answers (e.g., "should the catalysts feed be one
section or three sub-sections?"), STOP and surface to orchestrator
before deciding. The orchestrator will route to the owner.
