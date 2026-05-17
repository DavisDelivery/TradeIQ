# Phase 4j — Verification report

**Branch:** `claude/tradeiq-phase-4j-3F17K`
**Version:** `0.18.5-alpha` → `0.18.6-alpha`
**MODEL_VERSION:** unchanged
**New runtime dependency:** none (candlestick implemented via a recharts
custom shape on a `ComposedChart` rather than adding `lightweight-charts`)

---

## Pre-flight (baseline before any change)

```
git log --oneline -1
6ceb3fb phase-4j: decisions resolved + executor kickoff; capture phase 4k (desktop)

npx tsc --noEmit
(clean — no output)

npm test
Test Files  79 passed (79)
     Tests  746 passed (746)

npm run build
✓ built in 5.77s (no errors)
```

## Post-build verification (final)

```
npx tsc --noEmit
(clean — no output)

npm test
Test Files  84 passed (84)
     Tests  798 passed (798)
   Duration  17.40s

npm run build
dist/index.html                   0.86 kB │ gzip:   0.46 kB
dist/assets/index-Bq-QDhAw.css   30.89 kB │ gzip:   6.50 kB
dist/assets/index-67ogdhIm.js   967.10 kB │ gzip: 264.43 kB
✓ built in 5.83s
```

**Test delta: +52 (746 → 798)**, broken out below:

| Workstream | New tests | File |
|---|---|---|
| W1 | +9 (11 → 20) | `netlify/functions/shared/__tests__/ticker-reference.test.ts` |
| W2 endpoint | +7 | `netlify/functions/__tests__/ticker-info.test.ts` |
| W2 guardrail | +3 | `netlify/functions/__tests__/snapshot-pick-no-description.test.ts` |
| W3 endpoint | +16 | `netlify/functions/__tests__/price-history.test.ts` |
| W4 CompanyInfo | +9 | `src/__tests__/CompanyInfo.test.jsx` |
| W4 PriceChart | +8 | `src/__tests__/PriceChart.test.jsx` |
| **Total** | **+52** | |

Existing 746 tests all still pass — no regressions.

---

## Workstream-by-workstream

### W1 — Extend `ticker-reference.ts`

**Files:** `netlify/functions/shared/ticker-reference.ts` (+ tests).

Extended the existing Polygon `/v3/reference/tickers/{ticker}` call to
extract `description`, `homepage_url`, `total_employees`, `market_cap`,
`list_date`, `sic_description` (industry), and `branding.logo_url` /
`branding.icon_url`. Branding URLs get the Polygon API key appended so
the browser can render the logo (the branding endpoint returns 401
without the key).

New `getTickerInfo(ticker)` returns the full `TickerInfo` object;
existing `getTickerName(ticker)` keeps its 4h contract so the scan path
is unchanged.

**Cache-migration guard.** Bumped `SCHEMA_V` to 2. `getTickerInfo`
treats a doc with `schemaV < 2` (or absent — i.e. a 4h-era
`{name,fetchedAt}` doc) as a cache miss and refetches. Without this,
every already-cached russell2k ticker would show a permanently blank
description in the detail panel. The migration is **lazy** — only
triggered when a user opens the detail panel for that ticker — so a
single scan does not refetch thousands of docs at once.

`getTickerName` deliberately does NOT trigger the migration on the scan
hot path (it just needs the name, which 4h docs already carry).

### W2 — `/api/ticker-info` endpoint + 1-MiB guardrail

**Files:** `netlify/functions/ticker-info.ts`, two test files.

`GET /api/ticker-info?ticker=X` returns the full `TickerInfo` JSON
payload backed by `getTickerInfo`. Cache-first; one Polygon call per
true cache miss / migration refetch. 5-min `Cache-Control: max-age`
header so a repeat detail-panel open within the same session doesn't
re-hit the function.

**Architectural guardrail (the rule that matters).** The description is
**NOT** enriched onto snapshot picks — that's the trap 4e-1-infra and
4h had to engineer around. A ~500-char description × ~2,000 russell2k
picks would silently push the snapshot document past Firestore's 1 MiB
ceiling and break the terminal write.

A new structural test file (`snapshot-pick-no-description.test.ts`)
reads the `Target` interface and the scan-target / analyst-runner
sources at test time and asserts none declares a `description` field.
This will fail in CI if any future change re-introduces the field on the
pick, before the ceiling is hit in production.

### W3 — `/api/price-history` endpoint

**Files:** `netlify/functions/price-history.ts` + test.

`GET /api/price-history?ticker=X&range=R` (`R` ∈ `1M|6M|1Y|All`,
default `6M`) returns daily OHLCV bars mapped from
`getDailyBars(ticker, from, to)`. Range → `from` math:

| Range | from |
|---|---|
| `1M` | today − 30 days |
| `6M` | today − 182 days (default) |
| `1Y` | today − 365 days |
| `All` | `2000-01-01` (Polygon returns since-IPO for newer issuers) |

Per-ticker doc at `priceHistory/{ticker}` accumulates ranges via
`merge:true`. Same-day cached entries serve without re-fetching — daily
bars only change once a day, so this keeps Polygon calls bounded to ~one
per (ticker, range) per day even if Chad bounces between ranges
repeatedly.

Empty results (delisted, illiquid russell2k names) flow through as
`bars: []` so the UI can show its empty-state without breaking the
panel.

### W4 — Detail panel UI

**Files:** `src/components/CompanyInfo.jsx`, `src/components/PriceChart.jsx`,
`src/TargetBoardView.jsx` (wiring), `src/App.jsx` (APP_VERSION bump), two test files.

**CompanyInfo.** Logo (Polygon branding image; ticker-monogram fallback
when missing or the image errors), company name, industry, description
paragraph, and key facts (market cap formatted T/B/M, employee count
comma-grouped, listed year, homepage link). Stacks vertically on phone,
side-by-side logo + body on `sm:` and up. Graceful states for missing
description / empty key facts / endpoint errors.

**PriceChart.** Default 6M area chart of close price (emerald
`#14e89a` accent + linear-gradient fill), with a chart-type toggle
button to switch to a **candlestick** view. Candles are drawn via a
recharts custom `shape` on a `Bar` inside a `ComposedChart` — wick line
from high to low, body rectangle from open to close, emerald-up /
rose-down. **No new dependency added** — `lightweight-charts` was not
needed.

Range toggle `1M / 6M / 1Y / All` (default 6M, Chad's choice). Chart
container `h-56` on phone, `sm:h-64`, `md:h-72` on desktop — uses the
wider viewport. Loading skeleton, error message, and "no price history
for this range" empty state all shipped.

Both components wired into `TargetDetail` above the existing Thesis
block, so the panel now reads as "what is this company → what has the
stock done → what's the thesis → what do the analysts think."

---

## Acceptance checklist (post-merge, by the orchestrator)

The sandbox has no outbound network to the deploy, so live acceptance
is deferred per the brief. Checklist for the orchestrator to run
against production:

- [ ] Detail panel opens for a large-cap (e.g. FLEX, AAPL) and shows
      description, industry, logo, market cap, employees, list date,
      homepage link.
- [ ] Detail panel opens for a thin small-cap and either shows the same
      info or a graceful "description unavailable" / monogram fallback —
      never a crash or empty white box.
- [ ] Price chart renders at 6M by default; range buttons 1M / 6M / 1Y /
      All all switch and refetch.
- [ ] Chart-type toggle flips between area and candlestick views.
- [ ] Layout renders cleanly at phone width AND on a desktop viewport
      — the chart should not be capped at phone width on desktop.
- [ ] `/api/ticker-info` and `/api/price-history` both return under 2s
      on a warm cache.

---

## Known limitations / follow-ups

- **`All` range is bounded by Polygon plan tier.** The pre-~2003 history
  cap noted in `data-provider.ts` applies to `All` as well; in practice
  this means "All" for an older name like AAPL returns since-2003,
  not since-1980. The chart still renders correctly — just doesn't go
  back further than the plan supports.
- **No volume strip beneath the price.** The brief flagged volume as
  optional ("optional thin volume strip"); skipped for scope to keep the
  candlestick implementation tight. Easy follow-up if Chad wants it.
- **Logo URLs carry the Polygon API key.** Documented as acceptable in
  the brief — matches the existing Polygon-image pattern. A future
  proxy through a Netlify function would remove the key from the page
  source if that ever becomes a concern.
