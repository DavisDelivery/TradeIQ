# Phase 4j — Detail panel enrichment: company description + price chart

**Author:** orchestrator (CTO + CFO combined voice, per the house style set
by the 4h brief — though 4j is a smaller, cheaper phase and the financial
section says so honestly rather than manufacturing a cost story)
**Target version:** `0.18.6-alpha` (additive UI + two read endpoints; no
scoring-math change)
**MODEL_VERSION:** unchanged.
**Dependencies:** Phase 4h (merged `c3f822b`) — supplies `ticker-reference.ts`,
which 4j extends. `data-provider.ts` already exposes `getDailyBars` — the
price-chart data source. Polygon API key already provisioned. No new
third-party services, no new subscriptions.
**Parallel-with:** safe alongside anything — 4j touches the detail panel
and two new endpoints, disjoint from scan/backtest/analyst code.
**Estimated effort:** one executor agent session, ~2–3 hours, plus ~30 min
orchestrator review/merge/verify.

---

## Executive summary — the decision and the ask

The TradeIQ stock detail panel today shows an analyst-agreement radar, a
contributions list, and an attribution chart — a rich view of *what the
analysts think*, but nothing about *what the company is* or *what the
stock has done*. Opening FLEX tells you six analysts scored it 87, but
not that FLEX is Flex Ltd., a multinational electronics contract
manufacturer, nor what its price has done over the last six months.

For the core workflow — deciding whether a pick is worth acting on —
that's a real gap. A composite score with no company context and no
price history is half a decision.

Phase 4j closes it with two additions: a **company description + key
facts** block, and a **price chart**. Both ride on infrastructure
already in the repo — the description extends Phase 4h's
`ticker-reference` module (same Polygon call, more fields extracted),
and the price chart wraps `getDailyBars`, which `data-provider.ts`
already implements.

**The financial case is trivial and that's the honest framing.** 4j
adds no background functions, no scheduled functions, no new compute
class, and effectively no recurring API cost — the description's
Polygon call is already paid for by 4h, and price history is one
cached call per stock viewed per day. Build cost is one short agent
session. This is a cheap, high-leverage UX upgrade. Approve.

---

# PART I — THE PROBLEM

Surfaced 2026-05-17 from Chad's screenshot of the FLEX detail panel,
with two direct questions: "where are charts on this stock" and "where
is a description of the company."

### Gap 1 — no company description

The detail panel never tells you what the company *is*. There is an
on-demand "Generate brief with Claude" button (`ResearchPanel`), but
that produces a *news-focused* AI brief — last-7-days headlines plus
price context — not a stable "this is what the company does"
description. A user evaluating an unfamiliar small-cap ticker has no
passive, instant answer to "what is this company."

### Gap 2 — no price chart

The detail panel has two charts — the analyst-agreement radar and the
attribution bar chart — but **no stock price chart**. The current price
and day change are shown (`$137.86 -4.0%`), but not the trend. "Is this
stock near a high or a low? Has it been falling for a month or just
today?" — unanswerable from the panel.

### Why these two are one phase

Both are detail-panel enrichment, both are read-path, both ship in the
same file (`TargetBoardView.jsx`) plus small backend support. One phase,
one PR, one review.

### Explicitly out of scope

- The earnings analyst's narrow design and the removed patent analyst
  (also raised in the same conversation) are **analyst-depth work**, a
  separate and larger effort. 4j is detail-panel display only — it does
  not touch scoring.
- Real-time / streaming quotes. The chart is daily bars; the existing
  current-price field is unchanged.
- Company logos — see Open Decisions.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

What already exists, and what 4j therefore does NOT have to build:

| Capability | Status | 4j's use of it |
|---|---|---|
| `ticker-reference.ts` (Phase 4h) | Calls Polygon `/v3/reference/tickers/{ticker}`, extracts only `name`, caches `{name, fetchedAt}` at `tickerReference/{ticker}` | Extend it — the same call already returns `description`, `homepage_url`, `total_employees`, `market_cap`, `list_date`, `sic_description` |
| `data-provider.ts` `getDailyBars(ticker, from, to)` | Hits Polygon `/v2/aggs/.../range/1/day/...`, returns `Bar[]` | Wrap it in a price-history read endpoint |
| `research.ts` endpoint | On-demand AI news brief | Untouched — 4j's description is a different, passive thing |
| Detail panel (`TargetBoardView.jsx`) | Radar + contributions + attribution + `ResearchPanel` | Add a company-info block + a price chart |
| `recharts` | Already a dependency (radar, attribution) | Reuse for the price chart |

The headline: **4j builds almost no new infrastructure.** The Polygon
endpoints are already integrated; the work is extracting more from
responses already being fetched, two thin read endpoints, and UI.

---

# PART III — FINANCIAL ANALYSIS (CFO)

This section is short because the honest answer is short: **4j is
cheap.** A CFO's job here is to confirm there is no hidden cost — not
to inflate a small one.

### Run cost — effectively zero incremental

- **Company description:** Polygon `/v3/reference/tickers` is *already
  called* by Phase 4h's `ticker-reference` for every scanned ticker.
  4j extracts additional fields from the **same response** — zero new
  API calls for any ticker already cached. For a detail-panel view of
  a ticker not yet cached, one call, then cached effectively forever
  (company reference data doesn't change).
- **Price chart:** one Polygon aggregates call per ticker per day
  viewed, cached in Firestore (`priceHistory/{ticker}`, refreshed
  daily). If Chad views ~20 distinct stocks a day, that's ~20 cached
  calls/day — trivial against any Polygon plan's rate limit.
- **No new Netlify background or scheduled functions.** The two new
  endpoints are ordinary synchronous functions: fast (<2s), cheap,
  metered like any other request. No new compute class, no 15-minute
  jobs, nothing resembling the scan/backtest cost profile.
- **Firestore:** two small cache collections; per-ticker docs measured
  in kilobytes.

There is no monthly run-rate line item here worth modelling. 4j does
not move the infrastructure bill.

### Build cost

One executor agent session, ~2–3 hours (smaller than 4h — no
checkpoint-resume, no scheduling, no atomic-swap complexity). ~30 min
orchestrator review/merge/verify. No new vendors, services, or
subscriptions.

### Value

The detail panel becomes a place where a pick can actually be
*evaluated* — what the company does, what the stock has done — not just
a readout of analyst scores. That's a direct upgrade to the single most
important screen in the core workflow. High leverage for a near-zero
cost. Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Four workstreams, one PR. Order **W1 → W2 → W3 → W4** — backend first,
UI last (W4 depends on both endpoints).

### W1 — Extend `ticker-reference.ts` to full company info

- Extend `fetchFromPolygon` to extract, in addition to `name`:
  `description`, `homepage_url`, `total_employees`, `market_cap`,
  `list_date`, `sic_description` (industry).
- Extend the `TickerReferenceDoc` schema and the cached document at
  `tickerReference/{ticker}`.
- **Cache-migration guard:** documents cached by Phase 4h hold only
  `{ name, fetchedAt }`. A doc lacking `description` must be treated as
  a **cache miss** and re-fetched (or add a `schemaV` field and refetch
  on version mismatch). Otherwise old entries silently never gain the
  new fields.
- Keep the existing `getTickerName` behavior intact (other callers
  depend on it); add a new `getTickerInfo(ticker)` that returns the
  full object.

### W2 — `/api/ticker-info` read endpoint

- New endpoint `GET /api/ticker-info?ticker=X` → returns
  `{ ticker, name, description, homepageUrl, employees, marketCap,
  listDate, industry }`.
- Reads the `tickerReference/{ticker}` cache; fetches + caches on miss.
- The detail panel calls it on open.
- **Architectural guardrail (critical):** the description is **NOT**
  enriched onto snapshot picks. A description paragraph × ~2,000
  russell2k picks would add ~1 MB to a snapshot document and risk
  Firestore's 1 MiB ceiling — the same trap 4e-1-infra and 4h had to
  engineer around. `name` and `sector` are short and stay on the pick
  (4h did that correctly); `description` is long and is fetched
  **on-demand per detail-panel open**. Do not put it on the pick.

### W3 — `/api/price-history` read endpoint

- New endpoint `GET /api/price-history?ticker=X&range=1M|6M|1Y|All` →
  returns daily bars `[{ date, close, ... }]` for the range.
- Wraps the existing `getDailyBars(ticker, from, to)` from
  `data-provider.ts` — compute `from`/`to` from the `range` param.
- Cache per ticker per day: `priceHistory/{ticker}` with a date stamp;
  serve cached if the stamp is today, otherwise refetch. Daily bars
  only change once a day, so this keeps Polygon calls minimal.
- Handle empty/sparse results gracefully (delisted or illiquid
  russell2k names may return little or nothing).

### W4 — Detail panel UI

- **`CompanyInfo` block** — renders the W2 fields: company **logo**
  (Polygon `branding.logo_url`, API key appended; ticker-monogram
  fallback when absent), company name, industry, a short description
  paragraph, key facts (employees, market cap, IPO/list date) and a
  homepage link. Place it near the top of the panel (around the
  existing Thesis block) so it reads as context before the analyst
  detail. Graceful "description unavailable" state for tickers Polygon
  doesn't cover.
- **`PriceChart` component** — a new `src/components/PriceChart.jsx`.
  Default view is an **area/line chart of closing price** with a range
  toggle: **1M / 6M / 1Y / All** (default 6M). Plus a **chart-type
  toggle button** to switch to **candlestick** — implemented via a
  recharts custom shape or `lightweight-charts` (agent's call; the
  area chart is the baseline must-have, candlestick is the toggle-on
  view). Optional thin volume strip beneath. Loading + empty states
  required.
- Wire both into the detail panel in `TargetBoardView.jsx`. Respect the
  existing visual system (dark theme, emerald `#14e89a` accent, IBM
  Plex Mono labels). **Responsive — must render well on BOTH phone and
  desktop.** Chad uses TradeIQ on a phone today and increasingly on
  desktop; the chart should use the wider viewport when present rather
  than being capped at phone width. (A full desktop-optimized layout is
  Phase 4k; 4j just ensures these new components are not mobile-locked.)

---

# PART V — ARCHITECTURE DETAIL (CTO)

### The one rule that matters: description is on-demand, not on the pick

`name` + `sector` (short) ride on every snapshot pick — Phase 4h did
this correctly. `description` (a paragraph) must NOT. The snapshot
document already carries up to ~2,000 picks for russell2k; a ~400–600
character description per pick would add roughly a megabyte and push
the document toward Firestore's 1 MiB hard ceiling — silently breaking
the terminal snapshot write. The description is fetched by the detail
panel via `/api/ticker-info` only when a user opens a specific stock.
This keeps snapshots lean and only ever fetches descriptions for the
handful of stocks actually inspected.

### Cache shapes

```
tickerReference/{ticker}   (extended from Phase 4h)
  name, description, homepageUrl, employees, marketCap,
  listDate, industry, schemaV, fetchedAt
  — effectively immutable; refetch only on schemaV bump

priceHistory/{ticker}      (new)
  range-keyed daily bars + a date stamp
  — refetch when the stamp is older than today
```

### Endpoint behavior

Both new endpoints are ordinary synchronous Netlify functions, cache-
first, sub-2-second, with graceful empty-state responses. No background
execution, no scheduling, no cursor/resume machinery — this is plain
read-path code.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Description enriched onto picks → snapshot hits 1 MiB ceiling | Medium if mis-built | Terminal snapshot write fails silently | Hard rule: description is on-demand via `/api/ticker-info`, never on the pick. Stated in W2 + PART V. |
| R2 | Polygon `description` empty for some tickers (small-caps, new issuers) | Medium | Blank block | Graceful "description unavailable" UI; never break the panel. |
| R3 | Price history sparse/empty for delisted or illiquid names | Medium | Empty chart | Handle empty `getDailyBars` result; show "price history unavailable." |
| R4 | Phase 4h cache docs lack `description`, never refreshed | High if unguarded | Description permanently blank for already-cached tickers | Treat a doc missing `description` (or with an old `schemaV`) as a cache miss → refetch. |
| R5 | recharts candlestick fight | Low | Wasted effort | Use an area/line close-price chart — simpler, better on mobile, no library fight. |
| R6 | Chart renders poorly on a narrow phone screen | Medium | Core-user UX regression | Mobile-first build + responsive container; verify on a phone-width viewport in acceptance. |
| R7 | Price-history endpoint uncached → Polygon rate pressure | Low | Throttling | Per-ticker-per-day Firestore cache; daily bars change once a day. |

No cost-overrun risk worth listing — 4j adds no metered compute class.

---

# PART VII — ACCEPTANCE CRITERIA

A build passes when **all** hold:

1. Opening a stock detail panel shows a company description + key facts
   (name, industry, employees, market cap, IPO/list date, homepage),
   or a graceful "unavailable" state for tickers Polygon doesn't cover.
2. A price chart renders in the detail panel with a working range
   toggle (1M / 6M / 1Y).
3. Snapshot pick schema is **unchanged** — `description` is served by
   `/api/ticker-info`, not stored on picks. (Verify the snapshot
   writer was not modified.)
4. `/api/ticker-info` and `/api/price-history` both return in < 2
   seconds and serve from cache on a repeat call.
5. The detail panel renders cleanly at phone-width (mobile-first).
6. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
7. New tests cover: ticker-info cache hit/miss + the 4h-doc migration
   refetch, price-history range math + cache, empty-result handling
   for both endpoints.

Live verification deferred to post-merge — the orchestrator opens the
detail panel for several tickers (a large-cap and a thin small-cap) and
confirms criteria 1–5 against production.

---

# PART VIII — ROLLOUT PLAN

1. Agent ships W1–W4 as one PR; CI green; orchestrator reviews the W2
   guardrail (description NOT on picks) and the W4 mobile rendering
   specifically.
2. Merge. Netlify deploys (~3 min).
3. Orchestrator opens the detail panel for a large-cap (e.g. FLEX) and
   a thin small-cap; confirms description, key facts, and the price
   chart render, including graceful states.
4. Update `ORCHESTRATOR.md` 4j row to done.

Rollback is clean — 4j is purely additive (two new endpoints, new UI
blocks). Reverting the PR removes the additions; nothing else depends
on them and no data migration is involved.

---

# PART IX — DECISIONS (resolved by Chad 2026-05-17)

1. **Chart ranges — DECIDED: default 6M; toggle 1M / 6M / 1Y / All.**
   "All" fetches max available daily history (since IPO for newer
   names) — the `/api/price-history` endpoint takes a far-back `from`
   date for that range and returns whatever Polygon has.

2. **Chart type — DECIDED: area/line chart default, with a toggle
   button to switch to candlestick.** The area chart is the must-have
   baseline. Candlestick is a real deliverable, not optional —
   implemented via a recharts custom shape OR a lightweight charting
   library (`lightweight-charts`), agent's call. If candlestick proves
   a large lift, the agent ships the area chart solid and flags
   candlestick in the hand-off rather than letting the phase balloon —
   but the intent is both.

3. **Company logos — DECIDED: include them.** Polygon's
   `branding.logo_url` / `icon_url` require the API key appended to the
   URL. Render the logo in the `CompanyInfo` block; graceful fallback
   (ticker monogram) when absent.

4. **Key facts — DECIDED: show all of them** — description, industry,
   employees, market cap, IPO/list date, homepage link. Every field is
   in the one Polygon call already being made.

**Additional direction (2026-05-17):** Chad will be using TradeIQ on
desktop, and wants a dedicated desktop layout designed next (captured
as Phase 4k — separate brief). 4j's W4 is therefore built **responsive
— working well on both phone and desktop**, not mobile-only. The price
chart in particular should use the wider desktop viewport when present.

---

*End of brief. Phase 4j is unblocked and fully specified. Executor
kickoff: `kickoffs/phase-4j-executor.md`.*
