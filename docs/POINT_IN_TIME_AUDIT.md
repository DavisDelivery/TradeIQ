# Point-in-Time Audit

This document enumerates every external data class TradeIQ consumes and its
point-in-time (PIT) capability. Phase 4's backtest is only honest if every
data call can be answered as a function of `asOfDate` — "what did this
provider know on 2023-06-01?" — instead of "what does it know now?"

When a vendor doesn't natively support PIT, this doc records the workaround
or the residual look-ahead-bias risk that backtest code must compensate for.

This is a living doc. Update it whenever a vendor's PIT behavior changes or
a new data class is added.

---

## Conventions

These apply uniformly across every PIT-capable function in the codebase.

- **`asOfDate` format.** Always `YYYY-MM-DD` (10 chars). No timestamps or
  timezones in the user-facing API.
- **`asOfDate` semantics.** Inclusive, end-of-day UTC. Anything filed,
  published, or dated AT OR BEFORE 23:59:59.999Z on that date is visible.
  Anything dated AFTER is hidden.
- **Implementation per provider.**
  - For pure-date fields (`filing_date`, `Date`, `ReportDate`):
    string compare directly — `field <= asOfDate` works because both sides
    are `YYYY-MM-DD`.
  - For datetime fields (Polygon `published_utc`, FRED `realtime_*`):
    pass the API's native filter as `<param>.lte=<asOfDate>T23:59:59Z`
    when calling the vendor. Polygon at time of audit appears to treat
    `published_utc.lte=2024-01-01` as end-of-day inclusive (verified —
    articles from 2024-01-01T13:30:00Z came through), but we still pass
    the explicit `T23:59:59Z` form to make intent unambiguous and guard
    against vendor-side behavior changes.
  - For in-memory filtering of datetime values:
    `event.timestamp <= asOfDate + 'T23:59:59.999Z'`.
- **PIT-cacheable comments.** Every `asOfDate`-aware function carries a
  `// PIT-cacheable: keyed by (ticker, asOfDate)` (or similar) comment
  noting that the function's output is a pure function of its named inputs.
  Phase 4 will wrap these in a Firestore-backed cache; the comment is the
  marker so the cache layer can find them grep-fast.

---

## Capability matrix

| Provider | Data class                  | Endpoint                                | Native PIT?     | How / Workaround                                                                       | Residual risk                                                              |
| -------- | --------------------------- | --------------------------------------- | --------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Polygon  | Daily bars (OHLCV)          | `/v2/aggs/ticker/{T}/range/1/day`       | **Yes (implicit)** | Daily bars don't revise after publication. Calling for past ranges returns the same OHLCV that was true on those dates. | None for active tickers. **Delisted tickers**: verified retention for FRBA/FRC (2023 delistings) on current plan; LEHMQ (2008) returns NOT_AUTHORIZED — Polygon's plan tier doesn't reach 2008. Backtest scope ≤5 years should be safe. |
| Polygon  | Quarterly fundamentals      | `/vX/reference/financials`              | **Partial**     | Server accepts `filing_date.lte=<asOfDate>` and we additionally apply in-memory `filing_date <= asOfDate` filter for safety. **CAVEAT**: many 10-K (annual) filings ship with `filing_date: null` in the response — the in-memory filter would silently drop them. We fall back to estimating filing date from `end_date + ~75 days` for null values (typical 10-K SEC filing lag). | (1) Polygon SILENTLY incorporates restatement edits into past filings — even with PIT filtering, today's value for a filing dated 2022-06-15 may differ from 2022-06-15's value if it was later restated. The only true fix is snapshotting fundamentals into the boardSnapshots store at scan time (Phase 1 schema extension — out of scope for Phase 3, captured here as known residual risk). (2) The 75-day estimate for null `filing_date` values has up to ±30-day error; backtest should treat fundamentals filed within ~75 days of end_date as "approximately public." |
| Polygon  | News articles               | `/v2/reference/news`                    | **Yes**         | Native API filter: `published_utc.lte=<asOfDate>T23:59:59Z`. Server-side filtering — never filter client-side because Polygon's news index is multi-GB. | None significant. News is timestamped at publication and not retroactively edited. |
| Polygon  | Ticker reference            | `/v3/reference/tickers/{T}`             | **Partial**     | Endpoint accepts `date=<asOfDate>` for "was this ticker active on this date." Useful for universe composition. **CAVEAT**: response fields like `market_cap` and SIC are returned at TODAY's value, not the asOfDate value (verified — AAPL with date=2018-03-15 returned market_cap=$2.93T which is current, not the ~$900B that was true in March 2018). | Treat ticker reference as "did the ticker exist on this date" only. Never read `market_cap` or `sic_description` as PIT-correct. Use historical bars × historical shares-outstanding for PIT market cap. |
| Polygon  | Active tickers (universe)   | `/v3/reference/tickers?date=…`          | **Yes**         | The `active=true&date=<asOfDate>` filter returns the constituent set as of that date. Verified — AABA (Altaba) shows up active on 2018-03-15 despite later acquisition. Used as a fallback when `universe-history.ts` lacks coverage for an index. | Polygon doesn't model index membership directly — only "active equity ticker on US exchanges." Index history (S&P 500, NDX, Russell 2k) lives in `universe-history.ts` since Polygon's universe is too broad. |
| Finnhub  | Earnings calendar           | `/calendar/earnings`                    | **Yes**         | Native `from=<date>&to=<date>` filter. For PIT, set `to=<asOfDate>` to get only earnings announced on or before. | Finnhub's `epsActual` for past earnings reflects today's restated number if the company restated subsequent quarters. Rare for EPS but worth noting. |
| Finnhub  | Earnings surprises          | `/stock/earnings`                       | **Yes**         | Returns historical actual-vs-estimate per period. Each row has `period` (YYYY-MM-DD). PIT: filter `period <= asOfDate` in memory. | The `estimate` value reflects consensus AT THE TIME, but Finnhub's history doesn't carry estimate-revision dates — we get the final pre-earnings estimate. Backtest using estimates ≥1 day before earnings is approximately PIT-correct. |
| Finnhub  | Recommendation trends       | `/stock/recommendation`                 | **Partial (rolling)** | The endpoint returns the last ~4 monthly snapshots, each tagged with a `period` field (YYYY-MM-DD, the snapshot month-start). For asOfDate within ~4 months: filter live response by `period <= asOfDate`. For asOfDate older than 4 months: fall back to Phase 1 boardSnapshots (where the catalyst board persists rec data per scan). If neither path has data, return empty — DO NOT fabricate historical recs. | Phase 1 snapshots only started accumulating recently, so PIT for any asOfDate before that has no rec data. Acceptable for Phase 4's first iteration; Phase 5 can extend by snapshotting recs at higher cadence. |
| Finnhub  | Company profile             | `/stock/profile2`                       | **No**          | Returns current company profile (industry, market cap, share count, country). No historical version available from Finnhub. | Profile fields rarely change for established public companies (industry, country). Share count revisions are the most likely drift. Backtest treats profile as approximately stable over multi-year windows; flagged as residual risk. |
| Finnhub  | Insider transactions        | `/stock/insider-transactions`           | **Yes**         | API accepts `from=<date>&to=<date>`. We additionally apply in-memory `filingDate <= asOfDate` filter. The relevant PIT cutoff is `filingDate` (when the SEC Form 4 was public) NOT `transactionDate` (when the trade physically happened) — Form 4 has a 2-business-day filing requirement so the gap is small but matters. | Form 4s can be amended (Form 4/A); amendments overwrite the original record in Finnhub's response. Rare — the unamended path is the usual case. |
| Quiver   | Insider trading             | `/historical/insidertrading/{T}`        | **N/A**         | **Endpoint returns 404 on this account/plan** — the codebase already routes through Finnhub (`getFinnhubInsiderTransactions`) for insider data. See `insider-provider.ts` header comment. | None — Finnhub provides identical Form 4 coverage. |
| Quiver   | Congressional trading       | `/historical/senatetrading/{T}`, `/historical/housetrading/{T}` | **Approximate** | Each row has `Date` (transaction date) and `last_modified` (when Quiver last touched the record). Quiver does NOT expose the SEC EDGAR PTR (Periodic Transaction Report) filing date directly. PIT cutoff: filter `Date <= asOfDate`. **CAVEAT**: STOCK Act gives politicians 45 days to file post-trade, so a trade dated 2023-06-01 may not have been public until ~2023-07-15. For PIT honesty, Phase 4 should add a 45-day disclosure-lag buffer when consuming this dataset. | Filing-date drift up to 45 days. Backtest using a 45-day forward shift on `Date` approximates true public-knowledge date. |
| Quiver   | Government contracts        | `/historical/govcontractsall/{T}`       | **Yes**         | Each row has `Date` (Quiver's publication-side date, when contract entered USASpending.gov) and `action_date` (when the contract action physically occurred). Verified that `Date > action_date` typically (e.g., AAPL contract: action_date=2025-09-22, Date=2025-12-12 — a ~3 month publication lag). PIT cutoff: filter `Date <= asOfDate`, NOT `action_date`. | None significant if `Date` (not `action_date`) is the cutoff. |
| Quiver   | Lobbying                    | `/historical/lobbying/{T}`              | **Yes**         | LD-2 filings have quarterly cadence. Each row has `Date` (quarter end). PIT: filter `Date + lobbying disclosure deadline <= asOfDate`. LD-2 filings are due 20 days after quarter close, so a row dated 2023-09-30 was public ~2023-10-20. For Phase 3 we treat `Date` as the cutoff (small drift, conservative). | Up to ~20-day disclosure lag; in practice immaterial for quarterly cadence backtests. |
| Quiver   | Patents                     | `/historical/allpatents/{T}`            | **Yes (structural)** | Each row has `Date` (USPTO grant date) which is when the patent was granted and immediately public. PIT: filter `Date <= asOfDate`. **OBSERVATION**: Endpoint returns 0 rows for AAPL/NVDA/IBM/MSFT on this account at audit time — either the dataset is currently empty for these tickers or the endpoint has changed behavior. The PIT pattern still applies if/when data flows. | Empty endpoint is a coverage gap, not a PIT gap. Patent provider's `getPatentActivity` already handles empty paths gracefully. |
| FRED     | Economic series             | `/fred/series/observations`             | **Yes (gold standard)** | FRED's `vintage_dates=<asOfDate>` parameter returns ONLY the values FRED had published on or before that date. **Verified**: GDPC1 for 2022-Q4 — today=$24,055B; vintage_dates=2023-06-01 → $20,182B; vintage_dates=2024-06-01 → $21,989B. The differences reflect actual Bureau of Economic Analysis revisions. Without `vintage_dates`, a backtest secretly uses post-revision numbers. | None for vintage-date-aware reads. Without vintage_dates the macro layer carries a hidden ~3-9% revision drift on key series like GDP and CPI. |
| ETF sponsors | Universe constituents (SP500, Dow, NDX, Russell2k) | SSGA SPY/DIA xlsx, Invesco QQQ, iShares IWM csv | **Partial** | ETF sponsors are vendors of record for their respective indices, contractually obligated to track them accurately for billions in AUM. iShares IWM csv supports `asOfDate=YYYYMMDD` (verified 2022-01-31 onwards). SSGA SPY/DIA silently ignore `asOfDate` — current snapshot only. Invesco QQQ is SPA-only with no public CSV/xlsx endpoint discoverable. Wikipedia was the prior source for SP500/NDX historical depth; it has been decommissioned (no SLA, parse fragility, no audit trail) and the code paths ripped from the generator. See `docs/UNIVERSE_HISTORY_RUNBOOK.md` for the full rationale and refresh procedure. | (1) SP500/Dow historical depth limited to current SSGA snapshot — for deep history a paid vendor (Sharadar/Norgate/CRSP) is the correct escalation path. (2) NDX limited to `universe.ts` curated subset until Invesco QQQ becomes reachable. (3) Russell2k depth limited to iShares' archive (2022-01-31 onwards). Phase 4 backtests on Dow have full depth via the hand-curated history; SP500 backtests are constrained to current-period analysis until paid-vendor sourcing is approved. |

---

## How to use this in code

PIT-capable functions live in `netlify/functions/shared/`. Each accepts an
optional `asOfDate?: string` parameter with the conventions above:

| Function                                        | File                              | PIT field           | Behavior when `asOfDate` set                                               |
| ----------------------------------------------- | --------------------------------- | ------------------- | -------------------------------------------------------------------------- |
| `getDailyBars(ticker, from, to)`                | `data-provider.ts`                | n/a (range query)   | No-op — bars don't revise. Confirm comment in source.                      |
| `getFundamentals(ticker, { asOfDate })`         | `data-provider.ts`                | `filing_date`       | Server-side `filing_date.lte` filter + in-memory fallback for null filing_dates (estimate as `end_date + 75d`). |
| `getNews(ticker, { asOfDate })`                 | `data-provider.ts`                | `published_utc`     | Server-side `published_utc.lte=<asOfDate>T23:59:59Z`.                      |
| `getEarningsCalendarRange({ asOfDate })`        | `data-provider.ts`                | calendar `date`     | `to` query param set to `asOfDate`.                                        |
| `getEarningsHistory(ticker, { asOfDate })`      | `data-provider.ts`                | `period`            | In-memory `period <= asOfDate`.                                            |
| `getRecommendations(ticker, { asOfDate })`      | `data-provider.ts`                | `period`            | In-memory `period <= asOfDate` on live response (~4 months); fall back to snapshot store for older `asOfDate`. |
| `getFinnhubInsiderTransactions(ticker, { asOfDate })` | `data-provider.ts`         | `filingDate`        | In-memory `filingDate <= asOfDate`. Used by `getInsiderActivity`.          |
| `getInsiderActivity(ticker, { asOfDate })`      | `insider-provider.ts`             | `filingDate`        | Filters underlying transactions by `filingDate <= asOfDate`.               |
| `getPoliticalActivity(ticker, { asOfDate })`    | `political-provider.ts`           | `Date` (transaction)| In-memory filter; backtest should add 45-day buffer for STOCK Act lag.     |
| `getGovContractActivity(ticker, { asOfDate })`  | `govcontracts-provider.ts`        | `Date` (publication)| In-memory `Date <= asOfDate`.                                              |
| `getPatentActivity(ticker, name, { asOfDate })` | `patent-provider.ts`              | `Date` (grant)      | In-memory `Date <= asOfDate`.                                              |
| `getFredSeries(seriesId, { asOfDate })`         | `data-provider.ts`                | `vintage_dates`     | Native API param — gold-standard PIT.                                      |
| `snapshotBeforeDate(board, universe, asOfDate)` | `snapshot-store.ts`               | `generatedAt`       | Returns latest snapshot ≤ asOfDate; Phase 1 fallback for non-PIT vendors.  |
| `wasInIndexOnDate(ticker, index, date)`         | `universe-history.ts`             | month-end           | Returns boolean; corrects survivorship bias in backtest universe.          |

---

## Out-of-scope but documented

These are PIT concerns Phase 3 explicitly does NOT solve, captured here so
Phase 4 / Phase 5 can plan around them:

1. **Polygon fundamentals restatement drift.** Even with `filing_date.lte`
   filtering, today's response for a 2022 filing reflects any subsequent
   restatements. The proper fix is to extend Phase 1's snapshot schema to
   persist fundamentals at scan time. That's a Phase 1 territory change;
   Phase 3 leaves this as known residual risk.

2. **Finnhub recommendation history depth.** Live endpoint returns ~4
   months. PIT before that depends on Phase 1's accumulated snapshots,
   which only began recently. Phase 4 backtest should not extend rec-PIT
   data beyond available snapshot history.

3. **Quiver congressional disclosure lag.** STOCK Act gives 45 days; we
   filter on transaction date. **(Resolved Phase 4a)** The backtest
   engine threads political-data fetches through
   `getPoliticalActivityForBacktest(ticker, lookbackDays, asOfDate)`
   in `netlify/functions/shared/backtest/stock-act-shift.ts`, which
   shifts `asOfDate` back by `STOCK_ACT_LAG_DAYS = 45` before calling
   the provider. The conservative shift means a trade dated 2023-01-01
   first appears in the scorer's input at asOfDate ≥ 2023-02-15.

4. **Hot PIT path caching.** Phase 4 will call PIT functions thousands of
   times across parameter sweeps. Phase 3 marks every PIT function with
   `// PIT-cacheable: keyed by (...)` comments so a Firestore-backed cache
   layer can wrap them cleanly. **(Resolved Phase 4a)** Implemented in
   `netlify/functions/shared/pit-cache.ts` — Firestore-backed,
   stable-hash key derivation, `pitCacheWrap()` is the common idiom.
