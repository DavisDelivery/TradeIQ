# Phase 6 Executor Kickoff — Comprehensive Stock Detail Panel

> **For Chad:** paste the bootstrap block at the end of this file into
> a fresh Claude chat. The PAT is embedded inline. This is its own
> executor agent — NOT the W1b or W1c agents on the 4t-series branches.
> Phase 6 is a LARGE multi-PR product phase, NOT a one-shot kickoff.

---

You are an executor agent. Your single assignment is **Phase 6** of
the TradeIQ project — the Comprehensive Stock Detail Panel. The full
brief is at `briefs/phase-6-brief.md` in the repo. Read this kickoff
end-to-end, then read the brief, then start with PART 1.

**This is a multi-PR phase, NOT a single PR.** Each workstream ships
as its own PR. You do NOT try to land Phase 6 as one mega-PR.

**Scope discipline (read twice):**

- You build product UI + the backend endpoints feeding it.
- You do NOT modify any scoring math: Williams, Lynch, target
  composite, or any individual analyst formula. This phase
  *surfaces* existing scoring; it does not change it.
- You do NOT touch the backtest engine (`shared/backtest/*`) —
  Phase 4t territory.
- You do NOT touch the W1b russell2k path (PR #52, separate agent).
- You do NOT touch the W1c chronic-silent-analysts code (PR #53,
  separate agent).
- You do NOT add new dependencies without an orchestrator
  checkpoint — Recharts is the default chart library.
- You do NOT bloat snapshot endpoints (`target-board`,
  `williams-board`, `lynch-board`) with detail data. The on-demand
  per-ticker endpoints are the path (4u lesson).
- Each PR is ready-for-review (NOT draft) at hand-off.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. A React/Vite SPA backed by
TypeScript Netlify functions and Firestore. Three boards: Williams,
Lynch, target (composite). Owner: Chad Davis. Mobile-first iOS user
with a desktop docked panel (Phase 4k). Dark mode default, brand
blue `#1e5b92`, emerald accent `#14e89a`, IBM Plex Mono font.

## What Phase 6 is

Right now, when a user taps a stock on Williams or Lynch, the detail
panel is essentially empty — a score and a ticker, nothing else. The
target board has a shallow accordion from Phase 4q (analyst scores
with one-line rationale strings), but no charts, no metrics, no
catalysts, no risks. The app has been a screener with an output, not
a research tool with decision-support depth.

Phase 6 fixes that. Across all three boards, the stock detail panel
becomes a comprehensive view: a real strategy-specific **thesis
paragraph**, interactive **price + fundamental + relative-strength
charts**, a **key metrics panel** with sector-median context, a
**recent catalysts feed**, **falsifiable risk callouts**, and a
**deeper score breakdown** that exposes underlying numeric signals
(not just rationale strings).

The owner's direct framing was *"I'm trying to build the most
comprehensive personal trading app I humanly can, and there's not
enough information in this app in the places it should be. You're
not building this app like you are a savvy stock picker that needs
information at their fingertips, and is also a chief technical
officer who can build really intricate, highly detailed
applications."* That is the bar.

## The 5-workstream structure (each ships as its own PR)

- **PR-A (W1)**: Backend — `/api/williams-rationale`,
  `/api/lynch-rationale`, `/api/stock-detail` endpoints
- **PR-B (W2)**: Frontend — detail panel shell + thesis component +
  section stubs
- **PR-C (W3)**: Charts — price chart + relative strength chart
- **PR-D (W4)**: Charts — fundamental charts (revenue / EPS /
  margins)
- **PR-E (W5)**: Information panels — metrics + catalysts + risks +
  deepened score breakdown

Read `briefs/phase-6-brief.md` for the full design including the
ASCII layout mockup, the data shapes, and the visual design
principles. Do **not** start coding until you've read it
end-to-end.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -5
git config user.email "executor-phase6@tradeiq.local"
git config user.name "Executor Phase 6"

npm ci    # if it fails on cross-platform optional deps: npm install
npx tsc --noEmit
npm test
npm run build
```

If baseline fails, STOP and report. APP_VERSION bumps one patch per
PR (not per workstream within a PR; per PR).

**Environment note:** if commits fail from `/home/claude/TradeIQ`,
relocate to `/home/user/TradeIQ` or `/tmp`.

Read `briefs/phase-6-brief.md` after this kickoff. The brief is the
substantive design document; this kickoff is just the procedural
boot.

**Secrets:** GitHub PAT in the clone URL above. The deployed Netlify
functions have the data-provider API keys (Polygon, Finnhub, Quiver).
Local development can hit those endpoints through the dev server.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key files to read FIRST

Before any code, read:

- `briefs/phase-6-brief.md` — your full assignment
- `netlify/functions/target-rationale.ts` — the 4q pattern to mirror
  for Williams + Lynch rationale endpoints
- `src/components/AnalystContributions.jsx` — the 4q accordion UI
  pattern to extend
- `src/hooks/useTargetRationale.js` — the React Query hook pattern
- `src/lib/queryKeys.js` — query key registry
- `src/TargetBoardView.jsx` — target board UI (find how the detail
  panel is currently rendered for the target board)
- Williams + Lynch board view components — search the repo:
  `find src/ -name '*Williams*' -o -name '*Lynch*' -o -iname '*williams*' -o -iname '*lynch*'`
  Find the existing detail panel components for those boards; they
  are the ones you're replacing.
- `analysts/williams.ts` (or wherever Williams scoring lives) — find
  the per-component scoring; expose those components in the new
  rationale endpoint. Read-only modification target.
- `analysts/lynch.ts` (similar)
- `netlify.toml` — for the redirect blocks you'll add

## 2.2 Files you may modify (across all 5 PRs)

- New files per the brief's "Files most likely involved" section
- `netlify.toml` (3 new redirect blocks for the new endpoints)
- `src/lib/queryKeys.js` (add new query keys)
- Williams + Lynch board view components (wire the new panel in)
- `src/TargetBoardView.jsx` (extend or swap detail panel)
- `src/App.jsx` (APP_VERSION bump per PR — one patch each)

## 2.3 Files you may NOT modify (any workstream)

- Any analyst scoring math file (`analysts/*.ts` formulas — read-only)
- Backtest engine (`shared/backtest/*`)
- Recovery / reinvoke / sweep code (PR #51 territory)
- W1b russell2k path (PR #52 — separate agent)
- W1c chronic-silent code (PR #53 — separate agent)
- Snapshot endpoints (do not bloat with detail data)
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
- `package.json` (no new deps without orchestrator checkpoint)

---

# PART 3 — PR-A (W1): Backend rationale + detail endpoints

This is the foundational PR — everything else depends on its data.
~6-10 hour session.

## 3.1 What to build

Three new endpoints (mirror the 4q `target-rationale.ts` pattern):

- `GET /api/williams-rationale?ticker=X`
- `GET /api/lynch-rationale?ticker=X`
- `GET /api/stock-detail?ticker=X`

The first two return:
- Per-component score breakdown (Williams: 5-6 components; Lynch: 5
  components) — each with score, direction, weight, rationale,
  signals object (with numeric underlying values, not just strings)
- Synthesized thesis paragraph (server-generated, 2-3 sentences)
- Strategy-specific risk callouts (array of falsifiable trigger
  strings)

The third returns the comprehensive data bundle for the rest of the
panel — see the brief's W1.b section for the full TypeScript shape.

## 3.2 Helpers to create

- `netlify/functions/shared/sector-medians.ts` — `getSectorMedians(sector, metricList)` with cache
- `netlify/functions/shared/thesis-generation.ts` — strategy-specific thesis prose generators
- `netlify/functions/shared/risk-callouts.ts` — strategy-specific risk callout generators

## 3.3 Acceptance for PR-A

- All three endpoints respond with full shape; sample curl outputs
  for at least one ticker per board in the PR description.
- `_noData` / `_reason` shapes preserved (4q discipline).
- `tsc --noEmit` clean. Tests cover happy path + no-data + bad
  ticker.
- 3 new `[[redirects]]` blocks in `netlify.toml`.
- APP_VERSION bumped one patch.
- PR opened ready-for-review (not draft).

---

# PART 4 — PR-B (W2): Detail panel shell + thesis

~3-5 hour session.

## 4.1 What to build

- `src/components/StockDetailPanel.jsx` — top-level orchestrator;
  accepts `board` + `ticker`
- `src/components/StockDetailHero.jsx` — name, ticker, sector,
  price, day change, score
- `src/components/ThesisParagraph.jsx` — renders the thesis from the
  rationale endpoint
- `src/hooks/useStockDetail.js`, `useWilliamsRationale.js`,
  `useLynchRationale.js` — React Query hooks (session-memoized)
- Section stubs for the remaining areas (price chart placeholder,
  metrics placeholder, etc.) — actual content comes in PRs C-E

## 4.2 Layout

- **Mobile** (< 768px): single column, top-to-bottom scroll
- **Desktop docked panel** (Phase 4k): same single-column layout
  within the fixed-width docked panel
- **Desktop modal-view**: 2-column where it makes sense

Section order: Hero → Thesis → [Price chart] → [Metrics] → [Relative
strength] → [Fundamentals] → [Catalysts] → [Risks] → [Score
breakdown]. The bracketed sections are stubs in PR-B; their content
comes in later PRs.

## 4.3 Acceptance for PR-B

- Tapping a stock on Williams, Lynch, or target opens the new panel.
- Hero + thesis render correctly for at least one test ticker per
  board.
- Loading skeletons + error states correct on mobile and desktop
  docked.
- Mobile + desktop screenshots in PR description.
- APP_VERSION bumped.

---

# PART 5 — PR-C (W3): Price chart + relative strength chart

~5-8 hour session.

## 5.1 Price chart

- Time range selector: 1M / 3M / 6M / **1Y default** / 5Y / All
- 50-day and 200-day moving averages as overlays
- Strategy-specific entry/exit levels (Williams: 13-week RS
  breakeven price; Lynch: PEG=1.0 price level; target: skip)
- Earnings event markers on the date axis
- Library default: **Recharts**. If you genuinely need
  `lightweight-charts` for OHLC + crosshair quality, surface to
  orchestrator BEFORE adding the dep.

## 5.2 Relative strength chart

- Two lines: stock vs SPY, stock vs sector ETF
- 1Y default with range selector
- 0 line clearly drawn

Both charts: full-width on mobile, full-width-within-docked-panel on
desktop. Touch interactions work on mobile.

## 5.3 Acceptance for PR-C

- Both charts render correctly across all three boards.
- Range selector works.
- Mobile touch interactions work (tap to show tooltip; pinch-zoom OK
  if achievable; range selector is mandatory).
- Mobile + desktop screenshots in PR description.
- APP_VERSION bumped.

---

# PART 6 — PR-D (W4): Fundamental charts

~3-4 hour session.

## 6.1 What to build

`src/components/FundamentalCharts.jsx`

Three tabs:
- Revenue (5Y quarterly) — bar chart with YoY growth labels
- EPS (5Y quarterly) — bar chart
- Margins (5Y quarterly) — two lines (gross + op margin)

Default tab: Revenue. Library: Recharts.

## 6.2 Acceptance for PR-D

- All three tabs render with real 5Y quarterly data.
- Tab switching is smooth.
- Mobile + desktop screenshots.
- APP_VERSION bumped.

---

# PART 7 — PR-E (W5): Information panels (metrics + catalysts + risks + score breakdown)

~6-10 hour session. The largest content PR.

## 7.1 KeyMetricsPanel.jsx

- Mobile: 2-column rows
- Desktop docked: 2-column rows (panel is narrow)
- Desktop modal: 4-column grid
- Each metric: name + stock value (large, monospace, bold) + sector
  median ("sector: X") + color dot
- Groups: Valuation, Profitability, Financial health, Market

## 7.2 CatalystsFeed.jsx

Sections (collapsible accordion, expanded by default on mobile):
- Earnings (last result, next date)
- Insider (90d net, latest transaction)
- News (top 5 from last 30 days)
- Upcoming events

## 7.3 RiskCallouts.jsx

Bulleted list, red ✗ icon, falsifiable trigger strings from the
rationale endpoint. No hedging language.

## 7.4 ScoreBreakdown.jsx

Shared component for all three boards. Mirrors the 4q accordion
pattern but expands to show **numeric signal values** in the
expanded state (not just rationale strings). Replace
`AnalystContributions.jsx` OR keep both and have target use one,
Williams + Lynch use the new one. Recommended: one shared
`ScoreBreakdown.jsx` with a generic component shape; the brief
section W5.d has the TypeScript signature.

## 7.5 Acceptance for PR-E

- All four sub-components render with real data on all three boards.
- Score breakdown shows numeric signal values on expansion.
- Mobile + desktop screenshots.
- APP_VERSION bumped.

---

# PART 8 — CONVENTIONS

- TypeScript `strict: true`.
- React Query for fetching; session-memoize (`staleTime: Infinity`,
  `gcTime: Infinity`) for rationale endpoints; shorter TTL for
  stock-detail if it includes intraday data.
- Tailwind for styling; dark mode default.
- IBM Plex Mono for all numeric values.
- lucide-react icons; no emojis as semantic indicators.
- Color discipline (brief's "Visual design principles" section):
  emerald = favorable, red = unfavorable, amber = caution, brand
  blue = neutral information.
- No new dependencies without orchestrator checkpoint.

---

# PART 9 — HAND-OFF FORMAT

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
- <any honest flags — e.g. "deferred sector-median overlay on
  fundamentals to PR-D follow-up because the data wasn't
  available", etc.>

Acceptance: DEFERRED to orchestrator review + merge.
Next: PR-[next letter] — [next workstream]
```

---

# PART 10 — FAILURE MODES TO AVOID

- **Trying to land Phase 6 as one mega-PR.** Each workstream is its
  own PR. The discipline is non-negotiable.
- **Modifying scoring math.** This phase surfaces existing scoring;
  it doesn't change it. If you find yourself touching a `runX()`
  scoring function, STOP — you're out of scope.
- **Adding `lightweight-charts` (or any new dep) without an
  orchestrator checkpoint.** Recharts is default. If you need
  something else, ask first.
- **Bloating snapshot endpoints.** Detail data goes on the on-demand
  `/api/stock-detail` endpoint, not on the board snapshot.
- **Shipping desktop-only layouts.** Mobile must be first-class.
- **Shipping mobile-only layouts.** Desktop docked must be
  first-class too.
- **Vague "loading..." states.** Use real skeletons.
- **Misleading no-data UI.** No data = explicit "no data" with
  reason. Never a zero or placeholder that looks like real data.
- **Touching W1b, W1c, or 4t-recovery territory.** Out of scope.
- **Drafting PRs and leaving them in draft.** Final PRs are
  ready-for-review.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 6 of the TradeIQ project at
DavisDelivery/TradeIQ. This is its own phase — you do Phase 6 only.
The W1b agent (PR #52, russell2k), W1c agent (PR #53, earnings +
insider), and the 4t W2/W3 verdict are all in other hands; do not
interact with any of them.

This is the COMPREHENSIVE STOCK DETAIL PANEL phase. The current
Williams and Lynch detail panels are essentially empty. The target
panel has a shallow accordion from Phase 4q but no charts, metrics,
catalysts, or risks. The owner has been clear that the app needs
information depth — a real thesis paragraph, charts (price,
fundamental, relative strength), key metrics with sector-median
context, recent catalysts feed, falsifiable risk callouts, and a
deeper score breakdown showing numeric signal values.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-6-executor.md — your full procedural guide —
   then read briefs/phase-6-brief.md — the substantive design doc
   with layout mockup, data shapes, visual principles, and
   acceptance criteria.

This is a MULTI-PR phase. 5 workstreams, 5 PRs. Each ships
independently for incremental review:

- PR-A (W1): Backend rationale + detail endpoints
  (/api/williams-rationale, /api/lynch-rationale, /api/stock-detail)
- PR-B (W2): Frontend detail panel shell + thesis paragraph
- PR-C (W3): Price chart + relative strength chart
- PR-D (W4): Fundamental charts (revenue/EPS/margins)
- PR-E (W5): Information panels (metrics + catalysts + risks +
  deepened score breakdown)

Do NOT try to ship Phase 6 as one mega-PR. Do NOT modify any
scoring math (Williams, Lynch, target composite formulas are
read-only). Do NOT add new dependencies (Recharts is default; ask
orchestrator before adding lightweight-charts or anything else).
Do NOT bloat snapshot endpoints with detail data — the on-demand
per-ticker endpoints are the path. Do NOT touch W1b/W1c/4t-recovery
territory. Each PR opens ready-for-review (NOT draft). Each PR
includes mobile + desktop screenshots in the description.

Mobile is first-class. Desktop docked panel (from Phase 4k) is
first-class. Dark mode default, brand blue #1e5b92, emerald accent
#14e89a, IBM Plex Mono font, color as signal not decoration. No
emojis as semantic indicators.

The owner's framing was: "I'm trying to build the most
comprehensive personal trading app I humanly can. You're not
building this app like you are a savvy stock picker that needs
information at their fingertips, and is also a chief technical
officer who can build really intricate, highly detailed
applications." That is the bar — information at the user's
fingertips, with the technical depth of an intricate application.

If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ or /tmp. Start with PART 1 (cold start) once
you've read both files. Aim to ship PR-A in your first session;
subsequent PRs are subsequent sessions.
