# Phase 3 Agent Brief — TradeIQ Point-in-Time Data Layer

You are the Phase 3 agent for TradeIQ. Your job is to land Phase 3: every external data source becomes "as-of" queryable, and a historical universe-history module gives you point-in-time index membership going back 5+ years. This is the foundation that lets Phase 4's backtest produce honest, look-ahead-bias-free numbers.

You have all credentials embedded below. Do not ask the user.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Netlify team ID.** `69c43f638748ee6e940f5f62`
**Currently live.** `0.11.1-alpha` (Phase 0 + Phase 1 + Phase 2 merged; CI gating, Sentry, snapshot-first boards, TanStack Query hooks, Zod boundaries, 127+ tests)
**Stack.** React 18 + Vite, TypeScript Netlify Functions, Tailwind, Firebase Firestore, Anthropic Opus 4.7, TanStack Query, Zod.

**Required state before you start.**
- Phase 0, Phase 1, Phase 2 must show `done` in `ORCHESTRATOR.md`
- 127+ tests passing on main
- All five providers (Polygon, Finnhub, Quiver, FRED, anthropic) wrapped through Zod schemas

If any of those aren't true, surface to user and stop.

---

## The big idea (read this paragraph slowly)

Phase 4 is the backtest. A backtest is dishonest if it uses today's restated fundamentals to "predict" 2024 outcomes — that's look-ahead bias, the single most common way ML/quant models look great in test and lose money in production. Polygon revises financials. Finnhub backfills recommendations. Quiver amends. Indices add and drop constituents constantly (survivorship bias). Phase 3's job is to make every data call answerable as a function of `asOfDate`: "what did this provider know on June 1, 2023?" — not "what does it know now?".

Where as-of is fundamentally not supported by the vendor (e.g., Finnhub recommendation history doesn't carry filing-time stamps), the workaround is to fall back to Phase 1 snapshots: those ARE timestamped historical records of "what we read on this date." Document this honestly in the audit doc instead of pretending PIT works when it doesn't.

This phase is mostly TypeScript backend work. No new UI surface in Phase 3. Frontend stays untouched.

### Conventions (apply to every workstream)

- **`asOfDate` format.** Always `YYYY-MM-DD` (10 chars). No timestamps, no timezones in the user-facing API.
- **`asOfDate` semantics.** Inclusive, end-of-day UTC. Anything filed/published/dated AT or BEFORE 23:59:59Z on that date is visible. Anything dated AFTER is hidden.
- **Implementation per provider.**
  - String comparison (`filing_date <= asOfDate`) works directly when both sides are `YYYY-MM-DD`.
  - For datetime fields (Polygon `published_utc`, Quiver timestamps), pass the API's native filter as `<param>.lte=<asOfDate>T23:59:59Z` to honor end-of-day. Do not strip the time portion — Polygon treats `published_utc.lte=2024-01-01` as midnight start of day, which silently excludes everything published on the 1st.
  - In-memory filtering uses the same convention: `event.timestamp <= asOfDate + 'T23:59:59.999Z'`.
- **Document the convention** in `docs/POINT_IN_TIME_AUDIT.md` once at the top so every code reviewer reads it before reviewing PIT changes.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

Existing Netlify env vars (reference only):
- `ANTHROPIC_API_KEY`, `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `QUIVER_API_KEY`
- `SENTRY_DSN`, `VITE_SENTRY_DSN`, `ANTHROPIC_DAILY_BUDGET_USD`
- `FIREBASE_SERVICE_ACCOUNT`

You will not create any new env vars in Phase 3.

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`, plus Netlify deploy/read connectors.

---

## Read these first (in order)

1. `ORCHESTRATOR.md` — Phase 3 spec is the master.
2. `briefs/phase-2-pr-description.md` — context on what Phase 2 produced (Zod schemas you'll build on).
3. `netlify/functions/shared/data-provider.ts` — Polygon + Finnhub + FRED entry points.
4. `netlify/functions/shared/insider-provider.ts`, `political-provider.ts`, `patent-provider.ts`, `govcontracts-provider.ts` — Quiver providers.
5. `netlify/functions/shared/schemas/*.ts` — existing Zod schemas. PIT changes propagate through these.
6. `netlify/functions/shared/snapshot-store.ts` — Phase 1's historical snapshot infrastructure. The fallback for non-PIT-capable data classes is to read from here.

Don't read `app/`, `dist/`, `node_modules/`, or any view file. They're irrelevant to Phase 3.

---

## Phase 3 scope (twelve workstreams)

Order matters. W1 first — you can't fix what you haven't audited.

---

### Workstream 1 — PIT audit doc

**File.** `docs/POINT_IN_TIME_AUDIT.md`

**Deliverable.** A single markdown doc. For every external data class the app consumes, answer three questions:

1. Does the vendor API support an "as-of" parameter natively?
2. If yes, how (which endpoint, which param)? If no, what's the workaround?
3. What's the residual risk if no clean workaround exists?

Data classes to audit (one row each):

| Provider | Data class | Endpoint | As-of supported? | Workaround | Residual risk |
|---|---|---|---|---|---|
| Polygon | Daily bars (OHLCV) | `/v2/aggs/ticker/{T}/range/1/day` | ? | ? | ? |
| Polygon | Quarterly fundamentals | `/vX/reference/financials` | ? | ? | ? |
| Polygon | News articles | `/v2/reference/news` | ? | ? | ? |
| Polygon | Ticker reference | `/v3/reference/tickers/{T}` | ? | ? | ? |
| Polygon | Active tickers (universe) | `/v3/reference/tickers?date=…` | ? | ? | ? |
| Finnhub | Earnings calendar | `/calendar/earnings` | ? | ? | ? |
| Finnhub | Earnings surprises | `/stock/earnings` | ? | ? | ? |
| Finnhub | Recommendation trends | `/stock/recommendation` | ? | ? | ? |
| Finnhub | Company profile | `/stock/profile2` | ? | ? | ? |
| Quiver | Insider trading | `/historical/insidertrading/{T}` | ? | ? | ? |
| Quiver | Congressional trading | `/historical/congresstrading/{T}` | ? | ? | ? |
| Quiver | Government contracts | `/historical/govcontracts/{T}` | ? | ? | ? |
| Quiver | Lobbying | `/historical/lobbying/{T}` | ? | ? | ? |
| Quiver | Patents | `/historical/patents/{T}` | ? | ? | ? |
| FRED | Economic series | `/fred/series/observations` | ? | ? | ? |

For each, hit the actual API with a test query and read the response. Note: FRED has a separate `vintage_dates` parameter that gives genuine PIT for revised macro series — call this out specifically.

The doc is a living artifact. When Phase 4 hits a PIT edge case, this doc gets updated.

**Also document.** Five-line "How to use this in code" appendix linking to the helper functions you build in W2-W7.

### Workstream 2 — Bars (PIT-safe by definition, just confirm)

**File.** `netlify/functions/shared/data-provider.ts`

Daily bars don't get revised after publication. The PIT-safety is built into the API itself — calling `/v2/aggs/ticker/AAPL/range/1/day/2020-01-01/2020-12-31` today returns the same OHLCV that was true on 2020-12-31.

**Action.** Add a `// PIT-safe: daily OHLCV does not revise after publication` comment to `getDailyBars`. No code change.

**Spot-check delisted ticker retention.** Backtest will request OHLCV on tickers that no longer exist. Polygon retains delisted bars but it's worth confirming. Hit `getDailyBars` against a known delisted ticker — `LEHMQ` (Lehman Brothers, delisted 2008) or `FRBA` (First Republic, delisted 2023) — for a date range while the company was active. Confirm bars come back. Document the verification in the audit doc with the ticker and date range you tested.

If delisted bars don't come back, that's a much bigger problem for Phase 4 than the PIT additions and needs to surface to user immediately.

Test confirms behavior in W11.

### Workstream 3 — Polygon fundamentals as-of

**File.** `netlify/functions/shared/data-provider.ts`, function `getFundamentals`.

**Vendor reality.** Polygon `/vX/reference/financials` returns filings with `filing_date` and `period_of_report_date`. As-of works by filtering response: only filings where `filing_date <= asOfDate` were public knowledge.

**Pattern.**
```ts
export async function getFundamentals(
  ticker: string,
  opts: { asOfDate?: string; limit?: number } = {}
): Promise<FundamentalFiling[]> {
  // ...existing fetch...
  const filings = parsed.results;
  if (opts.asOfDate) {
    return filings.filter(f => f.filing_date <= opts.asOfDate);
  }
  return filings;
}
```

**Critical detail.** Polygon revises restated financials by editing the same filing record. Even with `filing_date <= asOfDate` filtering, the values you read TODAY for a filing dated 2022-06-15 may differ from what was published on 2022-06-15. Document this in the audit doc as "residual risk: revisions to past filings are silently incorporated."

The closest real fix is to snapshot fundamentals into the Firestore snapshot store at Phase 1 scan time — that becomes the PIT-honest source for backtest. Wire this in W10.

### Workstream 4 — Polygon news as-of

**File.** `netlify/functions/shared/data-provider.ts`, function `getNews`.

**Vendor reality.** Polygon news has `published_utc`. PIT filter: `published_utc <= asOfDate`.

**Pattern.**
```ts
export async function getNews(
  ticker: string,
  opts: { asOfDate?: string; limit?: number } = {}
): Promise<NewsArticle[]> {
  // pass published_utc.lte to the API directly when asOfDate is set
  const url = opts.asOfDate
    ? `${base}?ticker=${ticker}&published_utc.lte=${opts.asOfDate}&limit=${opts.limit ?? 50}`
    : `${base}?ticker=${ticker}&limit=${opts.limit ?? 50}`;
  // ...
}
```

Use the API filter, not in-memory filtering — Polygon's news index is large and you don't want to pull GBs of irrelevant articles to filter client-side.

### Workstream 5 — Insider as-of

**File.** `netlify/functions/shared/insider-provider.ts`.

**Vendor reality.** Quiver insider trades have `Date` (transaction date) and `FilingDate`. The relevant PIT cutoff is `FilingDate` — the trade was only knowable to outsiders once the SEC filing was public.

**Pattern.**
```ts
export async function getInsiderTrades(
  ticker: string,
  opts: { asOfDate?: string } = {}
): Promise<InsiderTrade[]> {
  // ...existing fetch...
  if (opts.asOfDate) {
    return trades.filter(t => t.FilingDate <= opts.asOfDate);
  }
  return trades;
}
```

Note Finnhub also surfaces insider data via `/stock/insider-transactions`. If both providers contribute, filter both and merge.

### Workstream 6 — Recommendations (no native PIT — fallback to snapshot)

**File.** `netlify/functions/shared/data-provider.ts`, function `getRecommendations`.

**Vendor reality.** Finnhub `/stock/recommendation` returns a current snapshot of analyst ratings — strongBuy/buy/hold/sell/strongSell counts per period. No timestamp on when each rating was issued or revised. There is no clean PIT path.

**Workaround.** Don't try to fake it. When `asOfDate` is requested, read from Phase 1's snapshot store: query the most recent snapshot before `asOfDate` and pull the recommendation field from it.

**Pattern.**
```ts
export async function getRecommendations(
  ticker: string,
  opts: { asOfDate?: string } = {}
): Promise<RecommendationSnapshot[]> {
  if (opts.asOfDate) {
    // PIT path: read from snapshot store
    const snap = await snapshotBeforeDate('lynch', 'sp500', opts.asOfDate);
    if (!snap) return [];
    const row = snap.results.find((r: any) => r.ticker === ticker);
    return row?.recommendation ? [row.recommendation] : [];
  }
  // Live path: direct vendor call
  // ...existing fetch...
}
```

This requires `snapshotBeforeDate` helper in `snapshot-store.ts` — add it in W10.

Document this fallback honestly in the audit doc. Phase 4 backtest will only have rec data from when Phase 1 snapshots started accumulating. That's a known limitation.

### Workstream 7 — Quiver political / patents / contracts as-of

**Files.**
- `netlify/functions/shared/political-provider.ts` (congressional trading + lobbying)
- `netlify/functions/shared/patent-provider.ts`
- `netlify/functions/shared/govcontracts-provider.ts`

**Vendor reality.** All three Quiver datasets carry their own filing/issue date fields — `ReportDate` for congress, `Date` for patents, `Date` for contracts. PIT-filterable by date.

**Pattern.** Same shape as W5 — accept `asOfDate`, filter by the appropriate date field, document the field choice in code comments.

Each of these three providers gets `asOfDate?: string` on its public functions.

### Workstream 8 — FRED macro series with vintage_dates

**File.** `netlify/functions/shared/data-provider.ts` (FRED helper functions live alongside Polygon).

**Vendor reality.** This is the gold-standard PIT case. FRED's macro series (GDP, CPI, employment, payrolls, ISM, etc.) get heavily revised after initial release — sometimes years later. A backtest using TODAY'S GDP value to "predict" 2020 outcomes is silently using post-revision numbers that nobody actually had at the time. The St. Louis Fed publishes a `vintage_dates` parameter on `/fred/series/observations` that returns ONLY the data as it was published on or before the requested vintage date. Use it.

**Pattern.**
```ts
export async function getFredSeries(
  seriesId: string,
  opts: {
    asOfDate?: string;       // e.g., '2023-06-01'
    observationStart?: string;
    observationEnd?: string;
    limit?: number;
  } = {},
): Promise<FredObservation[]> {
  const params = new URLSearchParams({
    series_id: seriesId,
    api_key: process.env.FRED_API_KEY!,
    file_type: 'json',
  });
  if (opts.observationStart) params.set('observation_start', opts.observationStart);
  if (opts.observationEnd) params.set('observation_end', opts.observationEnd);
  if (opts.limit) params.set('limit', String(opts.limit));
  if (opts.asOfDate) {
    // PIT: return only the values FRED had published on or before asOfDate.
    // FRED's vintage_dates accepts a comma-separated list; pass just the
    // single asOfDate to get one consistent vintage.
    params.set('vintage_dates', opts.asOfDate);
  }

  const res = await fetch(`https://api.stlouisfed.org/fred/series/observations?${params}`);
  const json = await res.json();
  const parsed = FredSeriesObservationsSchema.safeParse(json);
  if (!parsed.success) {
    log.warn('schema_mismatch', { provider: 'fred', endpoint: 'observations', issues: parsed.error.issues.slice(0, 5) });
    return [];
  }
  return parsed.data.observations ?? [];
}
```

**Document in audit doc.** Add an explicit row noting FRED is the only data class with TRUE vintage-aware PIT support. Macro series have meaningful revision risk and this is the cleanest fix in the entire phase.

Test in W11: pull a known revised series like real GDP for a vintage prior to a known revision date, confirm value matches the historical-as-published value not today's restated value.

### Workstream 9 — Universe history (the heaviest piece)

**File.** `netlify/functions/shared/universe-history.ts`

**Goal.** Answer "was AAPL in the S&P 500 on 2018-03-15? Was XYZ in the Russell 2000 on 2022-06-30?" deterministically.

**Why.** Survivorship bias. If your backtest's universe is "current S&P 500 constituents," you're testing only the survivors of the last 5 years. The companies that got delisted, acquired, or dropped from the index don't appear — and they're disproportionately the losers. Your backtest will look better than reality.

**Approach.** Don't try to source perfect daily-resolution constituent history from scratch — that's a six-figure data product. Build month-end snapshots going back 5 years. Good enough for backtest at quarterly or monthly rebalance frequency, which is what TradeIQ actually trades.

**Per-index strategy:**

| Index | Source | Granularity |
|---|---|---|
| **S&P 500** | Wikipedia article on List_of_S%26P_500_companies — has a "Selected changes" section with adds/drops by date. Walk forward from current list, applying inverse changes per month-end. | Month-end, ≥ 5 years |
| **NDX (Nasdaq 100)** | Wikipedia article on NASDAQ-100 — has an "Annual changes" section. Same walk-back pattern. | Month-end, ≥ 5 years |
| **Dow** | 30 components, changes are big news, hand-curated list of changes is reliable. | Month-end, ≥ 10 years (small dataset) |
| **Russell 2000** | iShares IWM ETF holdings export — daily CSVs available going back years at https://www.ishares.com/us/products/239710/ishares-russell-2000-etf (download "Holdings" CSV per date). For PIT we sample one per month-end. | Month-end, ≥ 5 years |

**Output shape.** A static TypeScript file, generated once via a one-shot script, committed to the repo:

```ts
// netlify/functions/shared/universe-history.ts
//
// Auto-generated by scripts/generate-universe-history.ts.
// Do not hand-edit. Re-run the generator monthly to extend forward.
// Last regenerated: <DATE>

export interface UniverseSnapshot {
  date: string;             // YYYY-MM-DD, month-end
  index: 'sp500' | 'ndx' | 'dow' | 'russell2k';
  tickers: string[];        // sorted alphabetically
}

export const UNIVERSE_HISTORY: UniverseSnapshot[] = [
  { date: '2020-01-31', index: 'sp500', tickers: [...] },
  // ...
];

export function tickersInIndexOnDate(
  index: UniverseSnapshot['index'],
  date: string,
): string[] {
  // Find the latest snapshot ≤ date, return its tickers
  const candidate = UNIVERSE_HISTORY
    .filter(s => s.index === index && s.date <= date)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  return candidate?.tickers ?? [];
}

export function wasInIndexOnDate(
  ticker: string,
  index: UniverseSnapshot['index'],
  date: string,
): boolean {
  return tickersInIndexOnDate(index, date).includes(ticker);
}
```

**Generator script.** `scripts/generate-universe-history.ts` — a one-shot Node script that pulls each source, parses, validates, and writes the TS file. Document the runbook in `docs/UNIVERSE_HISTORY_RUNBOOK.md` so future-you can refresh it monthly.

**Acceptable shortcuts for Phase 3.** If iShares historical Russell holdings are too painful to scrape (PDFs in some periods), use what they expose as CSV from current snapshots and back-fill ≥ 2 years of monthly data, document the rest as "best-effort." Better to ship 24 months of solid Russell history than to block on perfect 5-year data.

### Workstream 10 — Snapshot store helpers for PIT fallback

**File.** `netlify/functions/shared/snapshot-store.ts`

**Add two helpers.**

```ts
/**
 * Find the most recent snapshot for (board, universe) generated on or before
 * the given date. Returns null if no such snapshot exists.
 *
 * Used by providers whose vendors don't natively support PIT, so we fall back
 * to "what we read on the most recent prior date."
 */
export async function snapshotBeforeDate(
  board: BoardName,
  universe: UniverseKey,
  asOfDate: string,
): Promise<BoardSnapshot | null>;

/**
 * Given a per-ticker field name, walk the snapshots for (board, universe)
 * and return that field's value at asOfDate (the latest snapshot ≤ asOfDate).
 * Convenience wrapper around snapshotBeforeDate.
 */
export async function fieldAtDate<T>(
  board: BoardName,
  universe: UniverseKey,
  ticker: string,
  field: string,
  asOfDate: string,
): Promise<T | null>;
```

These are how W6 falls back gracefully. They're also the foundation for Phase 4's backtest engine.

### Workstream 11 — Tests

For every provider function modified in W2–W10, add a PIT correctness test:

**Test pattern (illustrative).**
```ts
describe('getFundamentals PIT semantics', () => {
  it('filters out filings dated after asOfDate', async () => {
    // mock Polygon to return 4 filings: 2021-Q1, 2021-Q3, 2022-Q1, 2022-Q3
    const result = await getFundamentals('NVDA', { asOfDate: '2022-01-01' });
    expect(result).toHaveLength(2);  // only 2021-Q1 and 2021-Q3
    expect(result.every(f => f.filing_date <= '2022-01-01')).toBe(true);
  });
  it('returns all filings when asOfDate is omitted', async () => { ... });
});
```

Universe history needs its own tests:
- `wasInIndexOnDate('AAPL', 'sp500', '2010-01-01')` returns true (or null if before Phase 3 history starts — explicit either way)
- `wasInIndexOnDate('TSLA', 'sp500', '2018-01-01')` returns false (TSLA joined S&P 500 in late 2020)
- `wasInIndexOnDate('LEHM_DEFUNCT', 'sp500', '2007-01-01')` returns true if pre-2008 history is in scope

Aim for ≥ 28 new tests across all PIT additions (the extra 3 cover FRED vintage_dates and the delisted-ticker spot check). CI gates.

### Workstream 12 — APP_VERSION + ORCHESTRATOR status

Bump to `0.12.0-alpha` (minor bump for the new data layer). Update ORCHESTRATOR.md status table:

```
| 3 | Point-in-time data layer | done | 0.12.0-alpha | YYYY-MM-DD | All 5 providers as-of capable; universe history covers sp500/ndx/dow/russell2k month-end ≥ X years; PIT audit doc enumerates every data class with workarounds for non-PIT vendors |
```

---

## Standing rules (apply to every commit)

- ALWAYS bump `APP_VERSION` in `src/App.jsx`. Phase 3 ships `0.12.0-alpha`.
- Every data table column sortable via `useSortable` + `SortableTh`. (No new tables in Phase 3, but if you find yourself adding one — STOP, it's out of scope.)
- Anything to be copied into another tool/conversation goes in a markdown doc or code block. Never plain prose.
- **Critical data ingest preserves four layers** — particularly important here. PIT additions wrap existing functions; do not collapse "raw filings" to "the one we use." Backtest needs the full filing history for each call.
- Brand blue: `#1e5b92` (Davis Delivery family — TradeIQ stays neutral dark).
- CI must stay green throughout. Push commits per workstream so CI runs incrementally.

---

## Working tree setup

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-3-point-in-time-data
```

---

## Commit and PR protocol

Granular commits per workstream:

- `phase-3(audit): POINT_IN_TIME_AUDIT.md covers all 15 data classes + asOfDate convention`
- `phase-3(bars): confirm + comment Polygon daily bars are PIT-safe; verify delisted ticker retention`
- `phase-3(fundamentals): asOfDate param on getFundamentals + filing_date filter`
- `phase-3(news): asOfDate param on getNews via published_utc.lte`
- `phase-3(insider): asOfDate filter on insider trades by FilingDate`
- `phase-3(recommendations): snapshot-store fallback for non-PIT Finnhub recs`
- `phase-3(political,patents,contracts): asOfDate filters on Quiver providers`
- `phase-3(fred): vintage_dates support on getFredSeries for PIT macro`
- `phase-3(universe-history): scripts/generate-universe-history.ts + universe-history.ts (sp500, ndx, dow)`
- `phase-3(universe-history): russell2k month-end coverage ≥ 24 months`
- `phase-3(snapshot-store): snapshotBeforeDate + fieldAtDate helpers`
- `phase-3(tests): 25+ PIT correctness tests + universe-history tests`
- `phase-3(docs): UNIVERSE_HISTORY_RUNBOOK.md + audit doc finalization`
- `phase-3(version): bump 0.12.0-alpha + ORCHESTRATOR status update`

PR title: `Phase 3: Point-in-time data layer (v0.12.0-alpha)`

PR description (in `briefs/phase-3-pr-description.md` on the branch) must include:
- Confirmation Phase 0 + 1 + 2 done
- Per-provider audit summary (which support native PIT, which fall back to snapshots)
- Universe history coverage table (index × month-range × ticker count)
- Test count (existing + new)
- Known residual look-ahead-bias risks (be honest — Phase 4 will hit them)
- Smoke test plan for the agent merging this

---

## Status table update (do this last)

After deploy verifies live and version matches, edit `ORCHESTRATOR.md` Status table → Phase 3 row → `done`.

Direct push to main is fine for the status row (doc-only edit, standing convention).

---

## Success criteria (testable definition of done)

All must be true before marking Phase 3 done:

- [ ] `docs/POINT_IN_TIME_AUDIT.md` covers every provider × data class with Yes/No/Workaround per row
- [ ] `getFundamentals('NVDA', { asOfDate: '2023-06-01' })` returns only filings dated ≤ 2023-06-01 (verified by test)
- [ ] `getNews('AAPL', { asOfDate: '2024-01-01' })` returns only articles published_utc ≤ 2024-01-01 (verified by test)
- [ ] `getInsiderTrades('TSLA', { asOfDate: '2023-12-31' })` returns only filings dated ≤ 2023-12-31 (verified by test)
- [ ] `getRecommendations('MSFT', { asOfDate: '2023-06-01' })` falls back to snapshot store when PIT requested (verified by test with mocked snapshot)
- [ ] All three Quiver providers (political, patents, contracts) accept asOfDate
- [ ] `getFredSeries('GDP', { asOfDate: '<a date prior to a known FRED revision>' })` returns the unrevised value (verified by test against a known historical revision)
- [ ] `getDailyBars('LEHMQ', '2008-01-01', '2008-08-01')` returns bars for a delisted ticker (verified manually + documented in audit doc)
- [ ] `asOfDate` convention documented at top of `docs/POINT_IN_TIME_AUDIT.md` and consistent across all PIT additions
- [ ] `wasInIndexOnDate('AAPL', 'sp500', '2018-03-15')` returns true; ditto a known-out-of-index test
- [ ] Universe history covers sp500/ndx/dow ≥ 60 months and russell2k ≥ 24 months
- [ ] `snapshotBeforeDate` + `fieldAtDate` helpers exist and have tests
- [ ] `npm test` ≥ 155 tests, all green (127 baseline + 28 new)
- [ ] `npx tsc --noEmit` clean
- [ ] `npm run build` clean
- [ ] `APP_VERSION = 0.12.0-alpha`, verified live
- [ ] ORCHESTRATOR.md Status table shows Phase 3 as `done`

---

## What to do if blocked

- **Polygon endpoint not what the brief assumed.** Audit it, document actual behavior in PIT audit doc, adjust workstream accordingly. Don't fake PIT.
- **Russell 2000 historical iShares CSVs missing for some months.** Use what's available; document gaps in `UNIVERSE_HISTORY_RUNBOOK.md`. Don't synthesize fake data.
- **Wikipedia parsing breaks.** Sometimes Wikipedia table formats change. Try a Wayback Machine archived version. Failing that, hand-curate the deltas from the article history page and document.
- **Test count blocked by PIT-fallback test setup complexity.** PIT-fallback tests need a mock snapshot store. Use Vitest's `vi.mock()` to swap `snapshotBeforeDate` for a fixture. If the mocking infrastructure is too painful for one test, accept fewer tests but document why.
- **A vendor returns a field with inconsistent date format.** Normalize at parse time inside the existing Zod schema (use `.transform()`). Don't push the inconsistency upstream.
- **Hot PIT path caching.** Phase 4 backtest will call PIT functions like `getFundamentals('NVDA', { asOfDate: '2023-06-01' })` thousands of times across parameter sweeps. Every call hits the vendor — that's a rate-limit wall and a slow backtest. Phase 3 does NOT build this cache (Phase 4 territory), but: when adding `asOfDate` to a PIT function, structure the function so a future cache layer can wrap it cleanly. Specifically, ensure the `(provider, ticker, asOfDate, dataClass)` tuple is sufficient to identify the result — no hidden inputs from `Date.now()` or random IDs. Add a `// PIT-cacheable: keyed by (ticker, asOfDate)` comment so Phase 4 can find these spots fast.
- **Choosing which board's snapshot to read for recommendation fallback (W6).** The brief example used `('lynch', 'sp500')` arbitrarily. Investigate first: which boards' snapshot results actually persist a `recommendation` (or analyst-rating) field? Likely candidates are catalyst (uses Finnhub recs as a signal), lynch (broad fundamental scan), and possibly target-board. Pick the broadest-coverage board that genuinely persists this field. Document the choice in code comments AND in the audit doc. If NO board persists it cleanly, that's a real signal — write into the audit doc that recommendation PIT is unsupported until Phase 1's snapshot schema is extended (which would be a Phase 5 ML-prep task, not Phase 3).
- **Delisted ticker bars don't return.** If the W2 spot check on `LEHMQ` or `FRBA` comes back empty, this is a Phase 4-blocking issue, not a Phase 3 nuance. Surface to user immediately with the test results. Do not continue to W3+.

---

## Out of scope for Phase 3

- The backtest engine itself. Phase 4 territory.
- Snapshot replay against PIT data. Phase 4.
- Calibration / weight tuning / ML. Phase 5.
- New UI surfaces. None in Phase 3.
- Modifying scoring math, analyst weights, or composite. Locked.
- Changing snapshot schema (Phase 1 territory).
- Anything that touches the AI surfaces (research/prophet/chart-analysis Anthropic calls).

If you find yourself reaching into Phase 4+ work, stop and note in PR description.

---

## First actions

```bash
# 1. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-3-point-in-time-data

# 2. Confirm preconditions
grep "^| 0\|^| 1\|^| 2" ORCHESTRATOR.md
ls .github/workflows/
npm ci --silent
npm test 2>&1 | tail -3

# 3. Survey state
ls netlify/functions/shared/
wc -l netlify/functions/shared/*.ts | head

# 4. Workstream 1 — start the audit by hitting one endpoint per provider
# (you already have the API keys; document what each returns)
```

Then proceed: W1 (audit doc) → W2 (bars confirm + delisted spot-check) → W3-7 (Polygon/Finnhub/Quiver PIT additions) → W8 (FRED vintage_dates) → W9 (universe history — heaviest) → W10 (snapshot helpers) → W11 (tests) → W12 (version + status).

---

End of brief. Begin work.
