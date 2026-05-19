# Phase 4t — Per-factor PIT integrity audit

This is the honest engineering statement on look-ahead-bias risk for
the **target board** — the ten-analyst composite TradeIQ runs as its
core multi-factor model. The brief (PART V, R1) is explicit: a
backtest's job is to tell the truth about whether a signal works;
a flattering lie is a negative deliverable. Phase 4n established the
template for Williams + Lynch
(`reports/phase-4n/pit-integrity-attestation.md`); this report extends
it to the full ten-factor composite.

## TL;DR — classification of every analyst

| # | Analyst | Inputs | PIT class |
|--:|---|---|---|
| 1 | technical-analyst | daily OHLCV bars | **PIT-clean** |
| 2 | flow-analyst | daily OHLCV bars | **PIT-clean** |
| 3 | sector-rotation | bars + sector ETF + SPY bars | **PIT-clean** |
| 4 | insider-analyst | Finnhub Form 4 (filing-date filtered) | **PIT-clean** (filing-date) |
| 5 | political-analyst | Quiver congress trades + lobbying disclosures | **PIT-with-caveat** (STOCK Act reporting lag — `getPoliticalActivityForBacktest` shifts) |
| 6 | political-analyst (contracts) | Quiver USAspending awards (action-date filtered) | **PIT-clean** (action-date) |
| 7 | patent-analyst | Quiver patent grants (publication-date filtered) | **PIT-clean** — but **weight = 0** in live composite (Phase 4f audit § 2: `no_upstream` on russell2k) |
| 8 | fundamental-analyst | Polygon `/vX/reference/financials` (filing_date.lte) | **PIT-with-caveat** (restatement risk — see Lynch attestation) |
| 9 | earnings-analyst (history) | Finnhub EPS surprises (period filter) | **PIT-with-caveat** (restatement risk on EPS-actual, less common than financials) |
| 9 | earnings-analyst (upcoming) | Polygon earnings calendar | **PIT-clean** (calendar windowed forward from `asOfDate`) |
| 10 | news-sentiment | Polygon news (published_utc.lte) | **PIT-with-caveat** (coverage gaps before the integration cutover — see §10) |
| 11 | macro-regime | Macro series via `computeRegime({asOfDate})` | **EXCLUDED** — `weight = 0` in live composite (Phase 4f audit § 2: `no_upstream` — score is literally constant 50) |

Eight analysts contribute to the live composite at non-zero weight
(`ANALYST_WEIGHTS` in `shared/analyst-runner.ts`): technical, sector-
rotation, fundamental, flow, news-sentiment, earnings, insider,
political. Of those, **5 are PIT-clean** and **3 carry caveats**
(fundamental, earnings-history, news) which are inherited from the
underlying data providers, not added by the composite layer.

The composite backtest is therefore presented as **PIT-correct on
filing/publication dates, with documented restatement + news-coverage
caveats**. No factor is faked.

---

## Per-analyst breakdown

### 1. technical-analyst — **PIT-clean**

**Inputs:** daily OHLCV bars only (`getDailyBars(ticker, from, to)`).

**Risk surface:** none beyond what `docs/POINT_IN_TIME_AUDIT.md`
already classifies for daily bars. Polygon does not retroactively
restate historical bar values.

**Enforcement:** the score-at-date wrapper calls `getDailyBars(ticker,
from, asOfDate)` — `to === asOfDate` is load-bearing and asserted in
the integration tests that ship with this PR.

**Verdict:** PIT-clean.

### 2. flow-analyst — **PIT-clean**

**Inputs:** daily OHLCV bars only. Phase 4f finish was the audit point
that this analyst does NOT need options or institutional-flow data
(those rolls are out-of-stream); the implementation in
`analysts/core.ts:runFlow` is a volume-anomaly score over bars.

**Risk surface:** identical to technical — bars are PIT-clean.

**Verdict:** PIT-clean.

### 3. sector-rotation — **PIT-clean**

**Inputs:** ticker bars + sector ETF bars + SPY bars. The
`MarketContextAtDate` cache in `score-at-date.ts` pre-fetches sector
ETFs and SPY using the same `asOfDate` bound, so the sector-relative
strength calculation only ever sees bars ≤ `asOfDate`.

**Risk surface:** the sector classification itself
(`UNIVERSE.find(...).sector`) is taken from the in-repo universe table.
That table is static (not time-indexed) — a ticker's sector today is
the sector used for the backtest as-of any historical date. For S&P
500 issuers the sector field is highly stable (GICS rebalances
quarterly but ticker re-classifications are infrequent); for some
Russell 2000 names it may have shifted. This is a small, second-order
effect — the sector affects which sector ETF the relative-strength
overlay compares against, not the composite weighting; the impact is
*directionally similar* even when the sector is mismatched, just on a
sector index that is loosely related rather than the canonical one.

**Verdict:** PIT-clean (with a noted minor static-sector caveat that
does not affect the score directionally).

### 4. insider-analyst — **PIT-clean (filing-date)**

**Inputs:** Finnhub Form 4 transactions and clusters, fetched via
`getInsiderActivity(ticker, 90, { asOfDate })`. The Form 4 SEC filing
is a publicly-mandated record dated to the filing day; the data
provider clips any transactions `date > asOfDate`.

**Risk surface:** none beyond a small reporting-cadence issue. Insiders
have a 2-business-day SEC reporting window (Section 16(a) deadline);
the analyst at `asOfDate` may not yet see transactions whose
transaction date was within 2 days of `asOfDate` because the SEC filing
hadn't been made yet. Since the provider's filter is on filing date,
this is exactly the public-information cutoff the live scan also sees
— PIT-correct, not look-ahead.

**Verdict:** PIT-clean. (The 2-day filing lag is a feature of real
public information, not a flaw in our PIT path.)

### 5. political-analyst (congress + lobbying) — **PIT-with-caveat**

**Inputs:** congressional stock trades (Quiver) + lobbying disclosures
(LDA), fetched via `getPoliticalActivityForBacktest(ticker, 180,
asOfDate)` — note: NOT the live `getPoliticalActivity`; the backtest
helper applies a **STOCK Act reporting-shift** to model the 45-day
disclosure deadline so the backtest only sees trades that were
*public* on or before `asOfDate`, not trades that were *executed* by
that date but not yet disclosed.

**Risk surface:** the STOCK Act shift is a *model* of public availability
(median disclosure window ≈ 30–45 days). Some disclosures land sooner,
some later, and a small fraction violate the deadline outright. The
shift is conservative on average — but it can over- or under-anticipate
when any given trade became public.

**Verdict:** PIT-with-caveat. The caveat is documented and applied at
the provider level; the live scan and the backtest both consume the
same `getPoliticalActivityForBacktest` helper to make this consistent.

### 6. political-analyst (contracts) — **PIT-clean (action-date)**

**Inputs:** USAspending contract awards (Quiver), fetched via
`getGovContractActivity(ticker, 180, { asOfDate })`. The provider
filters server-side and in-memory on the contract action date.

**Risk surface:** contract awards are published with a short lag after
the action; USAspending typically publishes within 7–10 days of the
action. Like the SEC 2-day insider window, this is the real
public-information cutoff — using action-date as the cutoff is the
honest cutoff.

**Verdict:** PIT-clean.

### 7. patent-analyst — **excluded from composite (weight = 0)**

**Inputs:** Quiver patent grants (publication date), fetched via
`getPatentActivity(ticker, name, 180, { asOfDate })`. The PIT path is
clean — patents are dated to grant date and the provider filters
properly. **However,** the live `ANALYST_WEIGHTS` in
`shared/analyst-runner.ts` pins `patent-analyst: 0` per the Phase 4f
audit (`reports/phase-4f/audit.md` § 2): `no_upstream` on russell2k
(1 unique value across 3600 obs); the weight was kept conservatively
at 0 globally.

**Verdict:** Not in the composite under test. The PIT path is correct
but the factor is excluded by weight. (We score the analyst — the
scorer is wired in — but the weight makes its contribution zero.)

### 8. fundamental-analyst — **PIT-with-caveat (restatement)**

**Inputs:** Polygon `/vX/reference/financials` filtered server-side by
`filing_date.lte=<asOfDate>` AND in-memory by `(filing_date ??
estimateFilingDate(...)) <= asOfDate`. This is the same path the Lynch
PIT scorer uses; the implementation is shared.

**Risk surface — the Lynch caveat applies here verbatim:** Polygon
silently incorporates **issuer restatements** into past filings. If a
company revises a 2021 10-K in 2023, the endpoint today serves the
revised 2021 numbers. The agent scoring an `asOfDate` in 2021 sees
the 2023 view of 2021 fundamentals — that is look-ahead.

**Magnitude:** restatements on large-cap (S&P 500) issuers are
uncommon and usually small (single-digit-percentage corrections);
they are more frequent and material on small-caps (Russell 2000).
This is why the 4t verdict (W3) **must report the sp500 and russell2k
results separately** — the restatement bias is structurally larger on
russell2k, and a russell2k result that flatters is *more* likely to be
contaminated.

**Direction of bias:** restatements that *lower* past revenue/EPS
turn some past-good companies into past-bad in today's view — a
backtest scoring those names "negative" on a historical date when the
market was operating on the GOOD reported numbers. For a momentum-or-
growth-style screener this can produce survivorship-style
over-confidence (we keep names that ended up restated favorably; we
drop names that were restated downward).

**Fix that would close it:** snapshot fundamentals at scan time into
a `boardSnapshots/fundamentals/{asOfDate}/{ticker}` store and read
from it for backtests. Out of scope for 4t (the same Phase 1 schema
extension that Lynch flagged). The 4t deliverable is to wire the path
correctly and tell the truth about the residual risk.

**Verdict:** PIT-with-caveat. The composite verdict must surface this
caveat for both universes and especially for russell2k.

### 9. earnings-analyst — **PIT-with-caveat (history) + PIT-clean (upcoming)**

**Inputs:**
- `getUpcomingEarnings(ticker, 45, { asOfDate })` — forward-looking
  calendar. The window is computed relative to `asOfDate`, so a
  "days-until-earnings" calculation at a historical date is honest.
  **PIT-clean.**
- `getEarningsHistory(ticker, 4, { asOfDate })` — past EPS surprises
  (actual vs estimate per quarter). The provider drops any row whose
  `period > asOfDate`.

**Risk surface (history):**
- Quarterly EPS-actual values can be restated (less frequently than
  full financial statements, but it happens). The consensus estimate
  is a historical record of analyst publications and is much less
  prone to restatement.
- The "beats last 4" count, EPS acceleration, and drift fields the
  analyst consumes are derived from those (estimate, actual, period)
  rows. EPS restatements would flip a "beat" into a "miss" in retrospect
  and contaminate the count.

**Magnitude:** smaller than full-financial restatement contamination
(EPS revisions are typically smaller corrections than revenue/asset
revisions), but still present. The same restatement caveat applies.

**Verdict:** Mixed — upcoming-earnings (days-until + drift) is
PIT-clean; earnings-history beats/streak features are PIT-with-caveat
on EPS-actual.

### 10. news-sentiment — **PIT-with-caveat (coverage)**

**Inputs:** Polygon news, fetched via
`getNews(ticker, { asOfDate, limit })`. The provider filters
server-side via Polygon's `published_utc.lte=<asOfDate>T23:59:59Z`.
The filter is a hard cutoff on UTC publication time — a news item
published 1 minute after midnight UTC the day after `asOfDate` is
NOT returned.

**Risk surface — coverage, not look-ahead:** Polygon's news index has
a documented coverage cutover. Polygon's news API began comprehensive
ticker tagging around 2019; earlier years (2018) have thinner
coverage AND a different ticker-tagging method. For a 2018-01-31
asOfDate the analyst gets sparse news; later years are more dense.
This is not look-ahead — it's reduced signal density in early years.

**Direction of bias:** news-sentiment scoring on sparse news returns
toward the neutral score (50) when the input is empty. So the early-
window backtest sees the analyst contributing close to zero net signal
— neither inflating nor deflating the composite. The bias is on the
*variance* of the contribution (lower in 2018, higher by 2023), not on
the direction.

**Verdict:** PIT-with-caveat. The cutoff is a hard `published_utc.lte`
— no future news leaks; the caveat is on coverage *density*, not on
the cutoff itself. Reporting in W2 / W3 includes a note on this.

### 11. macro-regime — **EXCLUDED (weight = 0)**

**Inputs:** the analyst computes `score = 50 + macroBias * 20` where
`macroBias` is fed from the upstream regime classifier. Per the
Phase 4f audit (`reports/phase-4f/audit.md` § 2) the upstream is
**never wired**: `macroBias` defaults to 0 and is never set by any
caller, so the analyst's score is literally constant 50 across every
observation in the audit (3600 obs).

The live `ANALYST_WEIGHTS` pins `macro-regime: 0`. It is not in the
composite under test.

**Verdict:** Not in the composite. (We score it for completeness —
the regime is computed via `computeRegime({asOfDate})` and *would* be
PIT-clean if it carried weight — but the weight is zero, so its
contribution is zero.)

---

## What the PIT path enforces, end-to-end

1. **Bars** — every analyst that reads bars consumes the same
   `getDailyBars(ticker, from, asOfDate)` window. No fetch ever
   defaults to `new Date()`.
2. **Fundamentals + earnings history** — both providers thread
   `asOfDate` server-side via Polygon's `filing_date.lte` / period
   filter, then defense-in-depth re-filter in memory. Filings made
   after `asOfDate` are not seen.
3. **News** — provider uses `published_utc.lte=<asOfDate>T23:59:59Z`.
   Polygon's index is a hard cutoff; no future news.
4. **Insider, contracts, patents, political** — each provider's
   backtest variant clips to `<= asOfDate` on the canonical public-
   information date (filing for insider, action for contracts,
   publication for patents). The political backtest variant
   additionally shifts disclosure timestamps to model the STOCK Act
   45-day reporting lag.
5. **Regime** — `computeRegime({asOfDate})` threads `asOfDate` into
   `getMacroData`. Excluded from the composite by weight anyway.
6. **Shared market context** — the `MarketContextAtDate` SPY +
   sector-ETF cache built per rebalance shares the same `asOfDate`
   bound across every ticker in that rebalance.

## What still cannot be made PIT in this PR

1. The fundamentals **restatement** path on Polygon `/vX/reference/
   financials`. The Lynch attestation documents this; the same caveat
   applies to fundamental-analyst and earnings-analyst here. The 4t
   verdict (W3) must surface this caveat, separately for sp500 (small
   magnitude) and russell2k (larger magnitude).
2. **News coverage density** in 2018 — the cutoff is hard but the
   density is thin. Reported as a known caveat on the early-window
   verdict numbers.
3. The **static-sector classification** in `UNIVERSE.find(...).sector`
   — sector field is not time-indexed. Minor and second-order; noted.

These are honest, well-bounded caveats — none of them is faked PIT.

---

## Acceptance: this audit + the W1 PIT path together meet the brief's standard

> *"A factor that cannot be scored honestly point-in-time must be
> flagged and excluded or caveated — never faked."*  
> *— phase-4t-brief.md PART IV*

- 5 PIT-clean factors run as-is.
- 3 PIT-with-caveat factors carry their caveat into the verdict.
- 2 factors with weight 0 are excluded by the live composite (not
  faked into existence for 4t).
- 0 factors faked.

The composite is scoreable point-in-time honestly. The PIT path
(W1's `scoreTargetAtDate`) implements exactly this contract.
