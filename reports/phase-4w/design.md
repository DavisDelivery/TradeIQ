# Phase 4w W1 — design report

## Orchestrator decisions (locked during W1 partial review)

The W1 design was reviewed partially while plan access is still blocked.
Two decisions are locked; four remain deferred until post-upgrade probes
can resolve them.

- **Q2 — Cash flow scoping: DECIDED → Option 1 (build all three endpoint
  helpers).** Overrides the report's Option 2 recommendation below. The
  YAGNI argument (zero current cash-flow consumers) is acknowledged but
  overridden because: (a) the vendor migration is a one-time forcing
  function; (b) cash flow is domain-core (FCF, FCF yield, OCF margin,
  capex intensity for Williams/Lynch theses) even if not currently
  wired; (c) Phase 6 detail panel is a likely future consumer; (d) the
  marginal ~100 LOC is cheaper than a separate future migration. W2
  ships `fetchCashFlowStatements`.
- **Q5 — Probe endpoint: DECIDED → permanent.** `diag-fundamentals-v1.ts`
  + the netlify.toml redirect stay as gated diagnostic infrastructure
  (mirror of the W1c diag-insider-pit decision).
- **Q3 (equity field), Q4 (long_term_debt lease residual), Q6
  (historical depth): DEFERRED** — resolved by post-upgrade probes. See
  the updated probe plan in the Pre-W2 checklist below.

W2 estimate consequently fixes on **Option 1 (~415 LOC)**.

## STOP signal — plan-access prerequisite NOT cleared

Per kickoff PART 0: "If your first probe call to massive.com returns a
401/403 plan-access error, STOP and surface to orchestrator — the
prerequisite wasn't cleared."

**All three new Fundamentals endpoints return `403 NOT_AUTHORIZED`** on
the deployed Netlify environment's `POLYGON_API_KEY`. The legacy VX
endpoint returns `200` with valid data, so the API key itself is fine —
**the current Massive subscription does not include access to the three
new Fundamentals endpoints**. Migration is blocked until the plan
prerequisite is cleared.

Concrete probe evidence below; design content marked **PROVISIONAL**
where it depends on data I cannot fetch under the current plan. The
design is otherwise complete and ready to land as soon as the
prerequisite is met — W2 implementation does not require any further
discovery beyond field-name verification once we have access.

## Plan-access evidence

Four (ticker, periodEnd) probes via `/api/diag-fundamentals-v1` on
deploy-preview-54 (the W1 branch's Netlify preview, deployed
`POLYGON_API_KEY` in env):

```
NVDA / 2024-09-30
  balance-sheets:        403 NOT_AUTHORIZED
  cash-flow-statements:  403 NOT_AUTHORIZED
  income-statements:     403 NOT_AUTHORIZED
  vx-legacy:             200 — 5 results (most recent: NVDA Q2 FY25, end_date=2024-07-28)

NVDA / 2018-03-31
  All three new endpoints:  403 NOT_AUTHORIZED
  vx-legacy:                200 — 5 results (most recent: NVDA Q4 FY18, end_date=2018-01-28)

AAPL / 2018-03-31
  All three new endpoints:  403 NOT_AUTHORIZED
  vx-legacy:                200 — 5 results (most recent: AAPL Q2 FY18, end_date=2018-03-31, filed=2018-05-02)

MSFT / 2018-03-31
  All three new endpoints:  403 NOT_AUTHORIZED
  vx-legacy:                200 — 5 results (most recent: MSFT Q3 FY18, end_date=2018-03-31, filed=2018-04-26)
```

Raw `errorBody` on the 403s:
```json
{
  "status": "NOT_AUTHORIZED",
  "request_id": "...",
  "message": "You are not entitled to this data. Please upgrade your plan at https://massive.com/pricing"
}
```

Per the sunset notice:
> "Depending on your current plan, accessing the Fundamentals endpoints
> may require an upgrade or add-on. Individuals can access them on
> Stocks Advanced or the Stocks Financials Add-on. Organizations can
> access them on Stocks Business or the Stocks Financials for Business
> Add-on."

**Action required for the orchestrator**: upgrade to Stocks Advanced
(or add the Stocks Financials Add-on), then re-fire the probe via
`/api/diag-fundamentals-v1?ticker=NVDA&periodEnd=2024-09-30` to confirm
200 responses with sample data. Once confirmed, this report's
PROVISIONAL field mapping table gets verified against the live shape
(and any docs-vs-reality discrepancies are reconciled) before W2
implementation proceeds.

## Side finding (out of W1c scope, surface for awareness)

The probe on VX legacy returned **valid quarterly data for NVDA, AAPL,
and MSFT at end_date=2018-03-31** (and 2018-01-28 for NVDA's FY18 Q4).
The brief's framing —
> "Historical cliffs on fundamental (silent 2018-2021, active 2022+)…
> These are real provider-archive limits — Polygon's historical
> coverage matured at those dates."

— may not be the actual mechanism for the W1c-observed fundamental
silence in 2018-2021. VX has data going back at least to 2018-01.

Three alternative hypotheses for the W1c 2018-2021 fundamental cliff
that this probe surfaces:
- The `getFundamentals` filing-date filter
  (`filing_date.lte=asOfDate`) silently empties results when VX rows
  for early years have `filing_date: null` (probe shows NVDA Q4-FY18
  has `filing_date: null`). The defensive `estimateFilingDate`
  fallback at `data-provider.ts:135-144` is supposed to handle this,
  but the early-year cache poisoning from rate-limit failures
  (W1c-style) plus the `null` filing dates may have produced empty
  responses that got cached.
- The PIT cache held stale empty `FundamentalsSnapshot` shapes (mirror
  of the W1c insider cache-poisoning architecture). The migration to
  three new endpoints + `shouldPersist` opt-in fixes this for the new
  cache namespace; the existing `dataClass: 'fundamentals'` entries
  will be cleared by the cleanup script (W3) regardless.
- Massive's VX endpoint coverage for historical periods is plan-tier
  dependent (current plan may include only recent VX data even
  though paths exist). The probe HTTP 200 here doesn't necessarily
  mean every old query would also 200.

This is OUT OF SCOPE for Phase 4w (which is about migrating off the
sunsetting endpoint, not about fixing 2018-2021 silence). But: **if
the migration ALSO happens to dissolve the 2018-2021 fundamental
silence**, the brief's "side investigation worth running" yields a
real backtest unlock. Document the post-merge re-fire to test this.

## Probed endpoint shapes

### VX legacy — `vX/reference/financials` (200; will sunset June 22, 2026)

Probed: `GET /vX/reference/financials?ticker=NVDA&limit=5&timeframe=quarterly&order=desc&period_of_report_date.lte=2024-09-30&apiKey=...`

Top-level result row (14 fields):
```
acceptance_datetime, cik, company_name, end_date, filing_date,
financials, fiscal_period, fiscal_year, sic, source_filing_file_url,
source_filing_url, start_date, tickers, timeframe
```

Where `financials` is a nested object with sub-categories
(`balance_sheet`, `income_statement`, `cash_flow_statement`,
`comprehensive_income`), and each leaf is a wrapped value:
`{ value: number, unit: "USD", label: "...", order: number }`.

The `getFundamentals` consumer reads:
- `latest.financials.income_statement.revenues` (with `num()` unwrapping
  the `{value, unit}` shape)
- `latest.financials.income_statement.basic_earnings_per_share`
- `latest.financials.income_statement.gross_profit`
- `latest.financials.income_statement.operating_income_loss`
- `latest.financials.balance_sheet.long_term_debt`
- `latest.financials.balance_sheet.equity`
- `latest.end_date`, `latest.filing_date`, `latest.fiscal_period`

`getFundamentals` returns a `FundamentalsSnapshot` (flat numeric shape,
`revenue: number`, `eps: number`, `grossMargin: number`, etc.).

### Balance Sheets — `/stocks/financials/v1/balance-sheets` (PROVISIONAL — 403 on probe)

Per Massive docs (https://massive.com/docs/rest/stocks/fundamentals/balance-sheets):

URL params (consistent across all three new endpoints):
- `tickers` (plural; supports `.any_of`, `.all_of`, `.all_of` for batch
  multi-ticker queries — a step up from the VX single-ticker model)
- `period_end` (+ `.gt`, `.gte`, `.lt`, `.lte`) — report period end date
- `filing_date` (+ ops) — SEC filing date
- `fiscal_year` (+ ops) — numeric year
- `fiscal_quarter` (+ ops) — number 1-4 (note: VX used string `"Q1"`)
- `timeframe` — `quarterly`, `annual` (cash-flow also offers
  `trailing_twelve_months`)
- `limit` — default 100, max 50,000 (vs VX's smaller defaults)
- `sort` — comma-separated columns with `.asc`/`.desc` suffixes
- `cik` (+ ops) — SEC CIK identifier
- Pagination via `next_url`

Expected response (PROVISIONAL, docs-derived):
```json
{
  "request_id": "...",
  "status": "OK",
  "next_url": "...",
  "results": [
    {
      "tickers": ["NVDA"],
      "cik": "0001045810",
      "period_end": "2024-09-30",
      "filing_date": "...",
      "fiscal_year": 2025,
      "fiscal_quarter": 2,
      "timeframe": "quarterly",

      // Asset side
      "total_assets": ...,
      "total_current_assets": ...,
      "cash_and_equivalents": ...,
      "short_term_investments": ...,
      "receivables": ...,
      "inventories": ...,
      "other_current_assets": ...,
      "property_plant_equipment_net": ...,
      "goodwill": ...,
      "intangible_assets_net": ...,
      "other_assets": ...,

      // Liability side
      "total_liabilities": ...,
      "total_current_liabilities": ...,
      "accounts_payable": ...,
      "accrued_and_other_current_liabilities": ...,
      "debt_current": ...,
      "deferred_revenue_current": ...,
      "long_term_debt_and_capital_lease_obligations": ...,
      "other_noncurrent_liabilities": ...,
      "commitments_and_contingencies": ...,

      // Equity side
      "total_equity": ...,
      "total_equity_attributable_to_parent": ...,
      "common_stock": ...,
      "preferred_stock": ...,
      "additional_paid_in_capital": ...,
      "retained_earnings_deficit": ...,
      "accumulated_other_comprehensive_income": ...,
      "treasury_stock": ...,
      "other_equity": ...,
      "noncontrolling_interest": ...,

      "total_liabilities_and_equity": ...
    }
  ]
}
```

### Income Statements — `/stocks/financials/v1/income-statements` (PROVISIONAL — 403 on probe)

Expected response per docs:
```json
{
  "results": [
    {
      "tickers": ["NVDA"], "cik": "...", "period_end": "...",
      "filing_date": "...", "fiscal_year": 2025, "fiscal_quarter": 2,
      "timeframe": "quarterly",

      "revenue": ...,                                  // ← was VX's `revenues`
      "cost_of_revenue": ...,
      "gross_profit": ...,                             // ← same name as VX
      "operating_income": ...,                         // ← was VX's `operating_income_loss`
      "total_operating_expenses": ...,
      "research_development": ...,
      "selling_general_administrative": ...,
      "depreciation_depletion_amortization": ...,
      "other_operating_expenses": ...,
      "income_before_income_taxes": ...,
      "income_taxes": ...,
      "consolidated_net_income_loss": ...,
      "net_income_loss_attributable_common_shareholders": ...,
      "interest_income": ...,
      "interest_expense": ...,
      "other_income_expense": ...,
      "total_other_income_expense": ...,
      "ebitda": ...,
      "noncontrolling_interest": ...,
      "equity_in_affiliates": ...,
      "discontinued_operations": ...,
      "extraordinary_items": ...,
      "preferred_stock_dividends_declared": ...,
      "basic_earnings_per_share": ...,                 // ← same name as VX
      "basic_shares_outstanding": ...,
      "diluted_earnings_per_share": ...,
      "diluted_shares_outstanding": ...
    }
  ]
}
```

### Cash Flow Statements — `/stocks/financials/v1/cash-flow-statements` (PROVISIONAL — 403 on probe)

Expected response per docs:
```json
{
  "results": [
    {
      // metadata identical to other two
      "net_income": ...,
      "net_cash_from_operating_activities": ...,
      "cash_from_operating_activities_continuing_operations": ...,
      "net_cash_from_operating_activities_discontinued_operations": ...,
      "change_in_other_operating_assets_and_liabilities_net": ...,
      "depreciation_depletion_and_amortization": ...,
      "other_operating_activities": ...,
      "net_cash_from_investing_activities": ...,
      "net_cash_from_investing_activities_continuing_operations": ...,
      "net_cash_from_investing_activities_discontinued_operations": ...,
      "purchase_of_property_plant_and_equipment": ...,
      "sale_of_property_plant_and_equipment": ...,
      "other_investing_activities": ...,
      "net_cash_from_financing_activities": ...,
      "net_cash_from_financing_activities_continuing_operations": ...,
      "net_cash_from_financing_activities_discontinued_operations": ...,
      "long_term_debt_issuances_repayments": ...,
      "short_term_debt_issuances_repayments": ...,
      "dividends": ...,
      "other_financing_activities": ...,
      "change_in_cash_and_equivalents": ...,
      "effect_of_currency_exchange_rate": ...,
      "noncontrolling_interests": ...,
      "other_cash_adjustments": ...
    }
  ]
}
```

## Field mapping table (VX → new endpoints)

`getFundamentals` consumes these VX fields. The migration must produce
the same `FundamentalsSnapshot` shape from the new endpoint responses.

| VX path | Used for | New endpoint | New field path | Notes |
|---|---|---|---|---|
| `financials.income_statement.revenues` | `revenue`, `priorRevenue`, `revenueGrowthYoY`, `grossMargin`, `operatingMargin` | income-statements | `revenue` | **Name change**: `revenues` → `revenue` (singular). Wrapping changes from `{value, unit}` to bare number. |
| `financials.income_statement.basic_earnings_per_share` | `eps`, `priorEps`, `epsGrowthYoY`, `ttmEps`, `priorTtmEps` | income-statements | `basic_earnings_per_share` | Same name. Unwrapped. |
| `financials.income_statement.gross_profit` | `grossMargin`, `priorGrossMargin`, `priorGrossMarginYoY` | income-statements | `gross_profit` | Same name. Unwrapped. |
| `financials.income_statement.operating_income_loss` | `operatingMargin`, `priorOperatingMargin`, `priorOperatingMarginYoY` | income-statements | `operating_income` | **Name change**: VX's `_loss` suffix dropped. Semantically equivalent (the value is signed regardless). |
| `financials.balance_sheet.long_term_debt` | `debtToEquity` (numerator) | balance-sheets | `long_term_debt_and_capital_lease_obligations` | **Semantic change**: new field INCLUDES capital lease obligations. Pre-2019 ASC 842 adoption: VX's `long_term_debt` excluded operating leases; post-2019: both include them. May produce slight numerical divergence on pre-2019 data. Document as residual risk. |
| `financials.balance_sheet.equity` | `debtToEquity` (denominator) | balance-sheets | `total_equity_attributable_to_parent` (recommended) OR `total_equity` | **Decision**: prefer `total_equity_attributable_to_parent` so debtToEquity excludes minority interest (matches VX behaviour: VX's `equity` field is parent-only per Polygon's docs at audit time). Alternative `total_equity` includes minority interest. **Confirm exact VX semantics via the live probe once plan access is granted.** |
| `end_date` | `asOf` | balance-sheets, income-statements, cash-flow-statements (any will do, all three have it) | `period_end` | **Name change**: `end_date` → `period_end`. |
| `filing_date` | PIT cutoff filter (`filing_date.lte=asOfDate`) + `estimateFilingDate` fallback for null filing dates | all three new endpoints | `filing_date` | Same name. The new endpoints accept `filing_date.lte` query param natively (per docs); the in-memory `estimateFilingDate` fallback may still be needed if some historical rows have null `filing_date`. |
| `fiscal_period` (string `"Q1"`-`"Q4"`/`"FY"`) | `estimateFilingDate` (uses different lag for Q4/FY vs Q1-Q3) | all three new endpoints | `fiscal_quarter` (number 1-4) + need to derive FY status from `timeframe` (`"quarterly"` vs `"annual"`) | **Shape change**: string `"Q4"` → number `4` + `timeframe === "annual"` flag. Update `estimateFilingDate` accordingly. |

**No VX field has zero equivalent in the new endpoints for the
consumer-relevant subset.** All six `getFundamentals`-consumed numeric
fields and three metadata fields have a clean mapping. Confidence is
high; the only documented residual is the `long_term_debt` semantic
shift (lease-obligation inclusion) which is a real but bounded
divergence that affects only historical pre-2019 data.

**Open question for orchestrator on the equity-attribution choice
(`total_equity_attributable_to_parent` vs `total_equity`)**: must be
confirmed against a live VX probe for NVDA Q2 FY25, comparing VX's
`equity` value to the new endpoint's two equity fields. Cannot do
this until plan access is granted.

## Cash flow scoping — open question for orchestrator

**The current `getFundamentals` consumer chain uses ZERO fields from
the cash flow statement.** Confirmed by exhaustive grep over `netlify/`
and `src/`:

```
grep -rn "cash_flow\|cashFlow\|operating_cash\|net_cash\|
  operating_activities\|investing_activities\|financing_activities"
  netlify/functions/ src/  →  zero non-test matches
```

`FundamentalsSnapshot` exposes no cash-flow-derived field. `runFundamentals`
in `analysts/core.ts:7-58` consumes only `revenue`, `eps`, `gross_profit`,
`operating_income`, `long_term_debt`, `equity` — all from
balance-sheets + income-statements.

**Two scope options:**

- **Option 1 — Migrate all 3 endpoints (faithful to brief)**: ship
  `fetchBalanceSheets`, `fetchIncomeStatements`, `fetchCashFlowStatements`
  with full cache wrapping + `shouldPersist`. Cash-flow data flows
  through `getFundamentals` (or a sibling) for Phase 6 detail panel's
  potential consumption. Estimated W2: ~250 LOC + ~120 LOC tests.

- **Option 2 — Migrate only 2 endpoints (smallest deadline-safe scope)**:
  ship `fetchBalanceSheets` + `fetchIncomeStatements`. Cash flow gets a
  TODO + a one-line stub for future Phase 6 expansion. Estimated W2:
  ~180 LOC + ~80 LOC tests. **Reduces deadline risk; preserves the
  option to add cash flow trivially when Phase 6 calls for it.**

**Recommend Option 2** for deadline discipline. The cost to add cash
flow later is ~30 LOC + tests (one new fetch helper, one new cache
key). Phase 6 hasn't filed a need for it; surface to that phase if it
does.

If the orchestrator prefers Option 1 (future-proof, consistent
discipline): scope grows by ~70 LOC; June 22 deadline still
comfortable.

## Historical depth — PROVISIONAL pending plan access

Documentation claim: "Records date back to March 29, 2009" across
balance-sheets, cash-flow-statements, and income-statements on Stocks
Advanced or Stocks Financials Add-on plans.

If true, this would mean **the new endpoints reach DEEPER than the
VX endpoint's effective historical coverage on the current plan** (or
at minimum, match it). My partial probe on VX shows valid data for
NVDA Q4-FY18, AAPL Q2-FY18, MSFT Q3-FY18 — back to 2018-01. The new
endpoints' docs claim 2009-03-29 as the earliest record date — 9 more
years of history if true.

**Verification cannot proceed until plan access is granted.** Once
granted, re-run the probe across:
- `?ticker=NVDA&periodEnd=2024-09-30` (modern baseline; verify shape)
- `?ticker=AAPL&periodEnd=2018-03-31` (early backtest window)
- `?ticker=AAPL&periodEnd=2010-03-31` (deep history claim)
- `?ticker=BHC&periodEnd=2020-03-31` (a stock-comp-heavy / tax-line
  edge case to test the assembler under shape variation)

If the deep-history claim holds, post-merge re-fire of the sp500
composite backtest should show fundamental signals contributing in
2018-2021 (whereas the W1c-observed backtest had 100% silence in
2018-2021). That's a meaningful backtest unlock; the verdict report
should call it out.

## Cache key strategy — Option B (recommended)

Per brief §W1.d, two options for cache key layout:

- **Option A**: Keep `dataClass: 'fundamentals'`, tag with version (e.g.,
  `extra: 'v2:assembled-from-3'`). Old entries stranded. One cache
  read per `getFundamentals` call.
- **Option B**: Three new `dataClass` values (one per endpoint), each
  cached independently. Old `fundamentals` entries stranded. Three
  cache reads per `getFundamentals` call (or two, with Option 2 above
  scoping cash flow out).

**Recommend Option B.** Reasons:
1. **Independent retry surface**: if `balance-sheets` rate-limit-exhausts
   but `income-statements` succeeds, we cache the success and
   selectively retry the failure. Option A caches the whole assembly
   as one unit; partial-failure forces a full re-fetch.
2. **Future Phase 6 sharing**: Phase 6 stock-detail may want to render
   balance sheet history alone (not assembled fundamentals). Cached
   `dataClass: 'balance_sheets'` entries become re-usable; an
   `assembled-from-3` entry is not.
3. **Cache pollution containment**: with separate keys, a
   stale/poisoned entry on one endpoint doesn't poison the other two.
   Mirror of the W1c discipline ("Phase 4o W1's 'no silent []' intent
   undermined at the consumer boundary" — see
   `reports/phase-4t-w1c/diagnosis.md` § Addendum) at the cache layer.
4. **Cleanup script granularity**: the W3 script can selectively clear
   any one dataClass without touching the others. Eases the post-merge
   cutover (clear VX `fundamentals`; leave new entries intact even if
   they were primed during the pre-merge probe).

Three new cache key schemas:

```typescript
// Balance Sheets
{ provider: 'polygon', dataClass: 'balance_sheets',
  ticker, asOfDate, extra: 'lim=5:quarterly' }

// Income Statements
{ provider: 'polygon', dataClass: 'income_statements',
  ticker, asOfDate, extra: 'lim=5:quarterly' }

// Cash Flow Statements (if Option 1 above is chosen)
{ provider: 'polygon', dataClass: 'cash_flow_statements',
  ticker, asOfDate, extra: 'lim=5:quarterly' }
```

Mirrors `pit-cache.ts`'s existing key shape exactly; `pitCacheWrap`
needs no schema changes. Three new strings join the `PitDataClass`
union type in `pit-cache.ts:23-37` (separate from W1c's pit-cache.ts
changes — pure additive type extension, no functional collision).

## `shouldPersist` opt-in — yes for all (recommended)

Per W1c discipline (`reports/phase-4t-w1c/diagnosis.md` § Addendum):
"Phase 4o W1's 'no silent []' intent undermined at the consumer
boundary." The new fundamentals endpoints inherit the same rate-limit
failure surface as Finnhub `/stock/insider-transactions` — a
rate-limit-exhausted response that returns empty data must NOT be
cached as if it were verified-empty.

**Decision**: each of the new fetch helpers opts in:

```typescript
const balanceSheets = await pitCacheWrap(
  { provider: 'polygon', dataClass: 'balance_sheets', ticker, asOfDate, extra: 'lim=5:quarterly' },
  () => fetchBalanceSheetsWithStatus(ticker, opts).catch(() => null),
  { shouldPersist: (v) => v !== null },
);
```

WithStatus pattern: each `fetch*WithStatus` helper returns an envelope
shape `{ data, rateLimited, rateLimitExhausted, errorMessage? }`
(mirror of `getFinnhubInsiderTransactionsWithStatus`). The fetch
helper consumed by `getFundamentals` THROWS on
`rateLimitExhausted` or `errorMessage`; the `.catch(() => null)` in the
`pitCacheWrap` call turns the throw into null; the `shouldPersist`
predicate skips the cache write. Next call re-fetches.

This wiring depends on W1c W2 merging first (which adds `shouldPersist`
to `pitCacheWrap`). Per kickoff Prerequisite 2: W2 implementation waits
for that merge.

## Estimated W2 diff size

### Option 1 (3 endpoints — faithful to brief)
- `data-provider.ts`: ~220 LOC (3 WithStatus fetch helpers + assembler
  + refactored `getFundamentals` skeleton). New helpers each ~50 LOC
  (URL construction, parse-or-fallback, WithStatus envelope, error
  shape); assembler ~70 LOC.
- `pit-cache.ts`: ~3 LOC (add three new `PitDataClass` strings to the
  union type).
- `__tests__/`: ~140 LOC (per-helper unit tests, assembler unit test,
  integration test with golden-reference VX shape).
- `scripts/clear-stranded-vx-fundamentals-cache.ts`: ~50 LOC.
- `src/App.jsx`: APP_VERSION bump 0.19.8-alpha → 0.19.9-alpha (or
  whichever is current after W1c lands).

**Total: ~415 LOC.**

### Option 2 (2 endpoints — recommended)
- `data-provider.ts`: ~160 LOC (2 WithStatus fetch helpers + assembler
  + refactored `getFundamentals` skeleton).
- `pit-cache.ts`: ~2 LOC.
- `__tests__/`: ~100 LOC.
- `scripts/clear-stranded-vx-fundamentals-cache.ts`: ~50 LOC.
- `src/App.jsx`: APP_VERSION bump.

**Total: ~315 LOC.**

Both under any reasonable re-scope threshold; both ship-able in 3-5
hours of focused work post-W1c merge.

## Probe endpoint disposition — open question for orchestrator

The probe (`netlify/functions/diag-fundamentals-v1.ts` +
`netlify.toml` redirect) ships on this branch alongside `design.md` per
the W1c precedent. Per kickoff §W1.a option 2: "Or — alternative —
keep it as a permanent, gated diagnostic path (orchestrator's call at
review time)."

**Recommend permanent** (mirror the W1c diag-insider-pit decision).
Reasons:
1. The probe will be needed again at W2 to verify field-mapping reality
   against docs once plan access is granted.
2. The probe will be useful post-merge to verify any future fundamentals
   provider behaviour shift.
3. The "no silent provider behavior" discipline argues for
   always-available diagnostic surfaces. The probe answers
   "what is the new endpoint actually returning today for ticker T at
   periodEnd P?" — a question worth answering quickly any time
   downstream `getFundamentals` produces unexpected output.

If the orchestrator prefers removal: trivial to revert; one commit
deleting `diag-fundamentals-v1.ts` and the netlify.toml redirect rule
before W2 merges.

## Open questions summary

1. **Plan upgrade**: orchestrator confirms Stocks Advanced (or Stocks
   Financials Add-on) is added to the Massive subscription. Re-run
   probe to confirm 200 responses. Blocks W2.
2. **Cash flow scoping**: Option 1 (all 3) vs Option 2 (recommended, 2
   only). Affects ~70 LOC and one cache key. Decide before W2.
3. **Equity field choice**: `total_equity_attributable_to_parent` vs
   `total_equity` for the `debtToEquity` denominator. Resolved by
   side-by-side VX vs new probe once plan access granted; defaults
   to attributable-to-parent per VX precedent.
4. **`long_term_debt` semantic divergence**: new field includes
   capital lease obligations. Acceptable residual risk OR scope
   addition to compute `long_term_debt_and_capital_lease_obligations
   - capital_lease_obligations` from the underlying line items
   (probably not available as separate fields)? Document as residual
   risk + flag in `docs/POINT_IN_TIME_AUDIT.md`.
5. **Probe disposition**: permanent (recommended) vs remove-before-W2.
6. **Historical depth side-finding**: if the new endpoints' claimed
   2009 history holds, the W1c 2018-2021 fundamental cliff may
   dissolve as a side benefit. Verify post-merge with sp500 re-fire.

## Pre-W2 checklist (orchestrator-executed before W2 starts)

- [ ] Massive plan upgraded to Stocks Advanced (or Financials Add-on)
      — **BLOCKING; relayed to Chad**
- [ ] **Shape verification**: re-fire
      `GET /api/diag-fundamentals-v1?ticker=NVDA&periodEnd=2024-09-30`
      on deploy-preview-54 — confirm 200 with non-zero `resultCount` on
      all three new endpoints; reconcile docs-derived PROVISIONAL field
      shapes above against the live response.
- [ ] **Q3 equity field**: probe a minority-interest ticker — `GOOG`
      `&periodEnd=2024-09-30`. Capture both `total_equity` and
      `total_equity_attributable_to_parent`. Pick the field whose value
      matches current VX `getFundamentals` behaviour for the same
      ticker-period (compare against the VX `equity` value from the
      same probe response). Document in a design.md addendum.
- [ ] **Q4 long_term_debt lease residual**: probe `AAPL&periodEnd=2018-03-31`
      (pre-ASC-842). Capture the delta between VX
      `balance_sheet.long_term_debt` and the new endpoint's
      `long_term_debt_and_capital_lease_obligations`. If delta is
      small/zero → no action. If >5% of the long_term_debt value →
      surface; may need a transformation layer to back out
      lease-equivalents for pre-2019 backtest dates.
- [ ] **Q6 historical depth**: probe `NVDA` one quarter per year across
      2009→2018 on all three new endpoints. Document where the actual
      data cliff lands per endpoint. If deeper than VX-in-practice,
      that's the 4t backtest side-benefit unlock — note it for the
      verdict report.
- [ ] W1c W2 merged + post-merge insider cleanup + sp500 re-fire
      verification completed (PR #53 merge gate)
- [ ] Re-hand-off to orchestrator: updated design.md with captured
      shapes + resolved Q3/Q4/Q6; the three fundamental-cliff
      hypotheses stay documented for the 4t verdict reference.
- [ ] Orchestrator full design review + W2 authorisation (scope already
      fixed to Option 1; equity field + lease-residual action resolved
      by the probes above)

— Executor 4w
