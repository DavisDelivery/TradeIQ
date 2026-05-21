# Phase 4w — Massive Financials VX Endpoint Migration

> **For the executor:** this brief replaces the stub at this same
> path. Read it end-to-end before any code. The companion kickoff at
> `kickoffs/phase-4w-executor.md` is your paste-and-go boot prompt.
>
> **THIS PHASE HAS A HARD DEADLINE: Monday, June 22, 2026.** That is
> the day Massive sunsets the endpoint the `fundamental` analyst
> depends on. Internal target: merge to main by **early June** to
> leave 2-3 weeks of buffer for post-migration verification.

---

## TL;DR

Massive (TradeIQ's fundamentals data vendor) is sunsetting the
**Financials VX endpoint** on **Monday, June 22, 2026**. The endpoint
was deprecated 2025-09-20; sunset is the hard kill. Account
triggered the notice email 2026-05-21 because TradeIQ has been
actively using the endpoint within the last 30 days.

The migration replaces one endpoint with **three new Fundamentals
endpoints** (Balance Sheets, Cash Flow Statements, Income Statements).
The work happens entirely inside the `getFundamentals` abstraction in
`netlify/functions/shared/data-provider.ts` — replace the VX call
with three parallel calls, assemble responses into the existing
return shape so consumers don't change.

Estimated effort: **200-400 LOC including tests + cleanup script.**
~5-10 hour total session. Single branch, ~2 PRs (W1 diagnosis-only
first, then W2+W3 combined).

**Side investigation worth running**: the new endpoints may have
deeper historical coverage. If yes, this migration also dissolves the
2018-2021 fundamental cliff (100% silent attributed to provider
history limits at VX) as a side benefit.

---

## Hard prerequisites (must clear BEFORE W2/W3 starts)

### Prerequisite 1 — Plan-access verification (Chad action, 5 min)

The sunset notice states:
> "Depending on your current plan, accessing the Fundamentals
> endpoints may require an upgrade or add-on. Individuals can access
> them on Stocks Advanced or the Stocks Financials Add-on.
> Organizations can access them on Stocks Business or the Stocks
> Financials for Business Add-on."

**Chad must verify his Massive subscription covers the new
endpoints** before this brief is greenlit for kickoff. Path: log into
massive.com (or the polygon.io dashboard if Massive is a Polygon
rebrand), check subscription tier, confirm coverage.

If the current plan doesn't cover: upgrade, add the Financials
Add-on, OR escalate to find an alternative fundamentals provider.

**The W1 probe will fail immediately if the plan doesn't cover the
new endpoints.** Save the orchestrator a wasted session — confirm
plan access first.

### Prerequisite 2 — W1c merge (for W2/W3 only)

W2 + W3 modify `data-provider.ts` — the same file W1c is currently
shipping changes to (earnings URL routing + asOfDate threading). To
avoid merge conflicts, W2/W3 starts AFTER W1c W2 PR merges and the
post-merge cleanup + sp500 re-fire verification completes.

**W1 (probe + design) is read-only research** — it can proceed
anytime after Prerequisite 1, even while W1c is still in flight. The
agent should explicitly NOT modify any code during W1.

---

## Context

### What's affected

**Code site:** `netlify/functions/shared/data-provider.ts` →
`getFundamentals(ticker, opts)`. This is the abstraction that today
calls the Financials VX endpoint. All consumers route through this
function:

- The `fundamental` analyst (`analysts/core.ts` → `runFundamentals`)
- Phase 6's `/api/stock-detail` endpoint (in flight; consumes
  fundamentals for key metrics + fundamentals chart history)
- Any other call site found during the W1 audit

### Functional impact if not done

- **Live target board scoring**: the fundamental layer returns
  `_noData` for every ticker after June 22. Composite drops one
  active factor.
- **Backtest**: same failure mode. The coverage chart's "14-47%
  silent fundamental in 2022-2024" goes to **100% silent across all
  dates, including live**.
- **Phase 6 detail panels**: key metrics + fundamentals charts go
  blank.
- **Composite active-factor count drops**: 2022-2024 goes from 5 →
  4. The whole 4t verdict reframe depends on accurate
  active-factor accounting; this is a real regression on the active
  metrics.

### What W1c is auditing in parallel

The W1c agent committed (in their W2 plan acknowledgement) to
auditing `getFundamentals` for **two patterns** during their W2
implementation:

1. **URL construction**: does the provider URL apply the asOfDate
   filter, or does it return current-time data that gets locally
   post-filtered to empty?
2. **WithStatus discard**: does the consumer boundary swallow
   rateLimitExhausted/errorMessage and return empty
   indistinguishably from verified-no-data?

If either is found in `getFundamentals`, W1c surfaces it to the
orchestrator BEFORE applying any silent fix (per the diagnose-before-fix
discipline). Findings may pre-inform Phase 4w's W1 — the orchestrator
will relay them. The agent should **explicitly read the W1c PR**
(diff + any audit-finding callouts) before starting W1 probe work.

If W1c's audit finds that `getFundamentals` has the URL construction
bug AT THE VX ENDPOINT (i.e., not using asOfDate-based filtering), that
becomes a moot point post-Phase-4w because we're migrating off VX
entirely. But it's useful diagnostic context for understanding what
went wrong historically with the fundamental coverage cliff.

---

## The migration target

Massive's notice replaces the single Financials VX endpoint with:

- **Balance Sheets** — assets, liabilities, equity at a point in
  time
- **Cash Flow Statements** — operating/investing/financing cash
  flows over a period
- **Income Statements** — revenue, expenses, net income over a
  period

The assembly: three `Promise.all` calls, then combine the responses
into the existing `getFundamentals` return shape. Consumers
unchanged.

### Return-shape preservation is the contract

`getFundamentals(ticker, opts)` returns some shape today. That
shape is consumed by:
- `runFundamentals` (in `analysts/core.ts` or wherever)
- The Phase 6 stock-detail endpoint
- Possibly other call sites

**The migration MUST preserve that exact return shape.** Consumers
should be byte-equivalent before/after. If the new endpoints can't
supply every field the VX endpoint did, surface to orchestrator —
that's a real regression and the brief gets re-scoped.

The W1 design step documents the exact mapping (VX field → new
endpoint field) before any code lands.

---

## Workstreams (one branch, two PRs: W1 design → W2+W3 fix)

### W1 — Probe + design (read-only; can run anytime after Prereq 1)

Output: `reports/phase-4w/design.md` committed to the branch as the
**first** PR (diagnosis-only). Diagnose-before-fix gate, mirroring
W1c's discipline.

#### W1.a — Endpoint shape probe

For each of the three new endpoints (Balance Sheets, Cash Flow
Statements, Income Statements):

1. Construct the URL using Massive's documentation (links in the
   sunset email).
2. Make a probe call for a known-good ticker (suggest: NVDA,
   2024-09-30 — recent quarter, definitely populated).
3. Document the full response shape (field names, types, sample
   values).
4. Document URL parameter semantics: does it accept `period_of_report`,
   `as_of_date`, `from`/`to`, ticker, multi-ticker batch, etc.?
5. Document any rate-limit headers / error-shape envelope.
6. Note whether response includes `WithStatus`-style envelope (per
   the discipline W1c just established for insider).

#### W1.b — Field mapping

Compare the existing VX endpoint response (read `getFundamentals`
source + a sample VX response from current production cache) to the
combined three-endpoint response.

Document in `reports/phase-4w/design.md`:

```markdown
| VX field           | New endpoint              | Field path             | Notes |
|--------------------|---------------------------|------------------------|-------|
| revenues           | Income Statements         | results[0].revenues    |       |
| netIncome          | Income Statements         | results[0].net_income  |       |
| totalAssets        | Balance Sheets            | results[0].assets      |       |
| ...etc                                                                            |
```

Flag any VX fields that have **no equivalent** in the new endpoints.
That's a regression risk — surface to orchestrator before W2.

#### W1.c — Historical depth probe (side investigation)

The whole reason the fundamental analyst was silent 2018-2021 in
the sp500 backtest was attributed to "provider history limits at
the VX endpoint." Probe the NEW endpoints for the same historical
window:

- AAPL Q1 2018 — does Balance Sheets / Cash Flow / Income Statements
  return data? Document the response.
- Same for one or two other 2018-era sp500 tickers (suggest: MSFT,
  AMZN).
- Same for 2019 and 2020 to see where the cliff actually is on the
  new endpoints.

Document findings in design.md. If the new endpoints have deeper
historical coverage, this migration delivers a real backtest unlock
beyond the deadline-driven necessity.

#### W1.d — Cache key strategy

The existing PIT cache uses keys like:
```
{ provider: 'polygon', dataClass: 'fundamentals', ticker, asOfDate, extra: '...' }
```

For the new endpoints, decide:
- **Option A**: keep the same cache key namespace (`dataClass:
  'fundamentals'`) but tag with a version (`extra:
  'v2:assembled-from-3'`) so old entries are stranded.
- **Option B**: use new dataClass per endpoint (`balance_sheets`,
  `cash_flow_statements`, `income_statements`) — each new endpoint
  caches independently, then `getFundamentals` assembles in memory
  every time.

Recommend Option B for cleanliness — three independent cached
fetches, assembly happens at call time. Old `fundamentals` cache
entries become stranded (cleared by the cleanup script).

If Option B is chosen, document the three new cache key schemas in
design.md.

#### W1.e — `shouldPersist` opt-in

The new endpoints inherit the same rate-limit failure surface that
W1c diagnosed for insider. Document in design.md whether each of
the three new fetches should opt into the `shouldPersist: (v) => v
!== null` predicate. Recommendation: **yes for all three** —
consistent with the "no silent []" discipline established in W1c.

#### W1 deliverable

`reports/phase-4w/design.md` with sections:
- Endpoint shape (3 sub-sections)
- Field mapping table
- Historical depth findings + recommendation
- Cache key strategy decision
- shouldPersist opt-in decision per endpoint
- Estimated W2 diff size
- Open questions for orchestrator (if any)

Open the W1 PR as a draft on branch
`phase-4w-massive-fundamentals-migration` with only the design
report committed. **Wait for orchestrator review before W2.**

### W2 — Implementation + tests (waits for W1c merge + W1 review)

#### W2.a — getFundamentals refactor

Replace the VX endpoint call in `getFundamentals` with three
parallel calls assembled into the existing return shape:

```typescript
async function getFundamentals(ticker: string, opts: GetFundamentalsOpts) {
  const [balanceSheets, cashFlows, incomeStatements] = await Promise.all([
    fetchBalanceSheets(ticker, opts).catch(() => null),
    fetchCashFlowStatements(ticker, opts).catch(() => null),
    fetchIncomeStatements(ticker, opts).catch(() => null),
  ]);
  return assembleFundamentals(balanceSheets, cashFlows, incomeStatements);
}
```

Three new helpers (`fetchBalanceSheets`, `fetchCashFlowStatements`,
`fetchIncomeStatements`) each handle one endpoint with the
WithStatus pattern (throw on failure) per the W1c discipline.

`assembleFundamentals` is the field-mapping function. Returns
existing VX-shape so consumers are unchanged.

If any of the three is null (caught error), the assembly should
produce a partial result with `_noData` marked on the fields that
came from the failed call — OR return null entirely if the whole
assembly can't proceed without that data. The design.md decides
which.

#### W2.b — Cache integration

If the W1 design chose Option B (three independent cached fetches):
- Add three new dataClass values to the pitCache key schema
- Each `fetch*` helper wraps in `pitCacheWrap` with the appropriate
  key + `shouldPersist: (v) => v !== null`
- `getFundamentals` itself doesn't directly hit the cache; the
  three helpers do

If the W1 design chose Option A:
- Single cache wrap around `getFundamentals` with versioned `extra`
  field
- Same shouldPersist opt-in

#### W2.c — Tests

Unit tests in `__tests__/`:
- `fetchBalanceSheets` / `fetchCashFlowStatements` /
  `fetchIncomeStatements`: URL construction, response parsing,
  WithStatus failure → throw, success → object
- `assembleFundamentals`: field mapping correctness, partial
  failure handling
- `getFundamentals`: integration test for full call path with
  mocked endpoints; return shape exactly matches the pre-migration
  shape (use a captured VX response as the golden reference)

All existing tests still pass (current baseline per W1c kickoff: 1054
tests).

### W3 — Cleanup + cutover

#### W3.a — Stranded VX cache entry cleanup

Script: `scripts/clear-stranded-vx-fundamentals-cache.ts`

Mirrors the W1c `clear-stale-insider-empties.ts` pattern:
- Dry-run default; `--confirm` flag actually deletes
- Filter: `key.dataClass === 'fundamentals'` AND (if W1 chose Option
  B) the entries have the VX-shape rather than the new-shape
- Conservative clear-all is fine — re-population happens on next
  call via the new endpoints

#### W3.b — Post-deploy verification procedure

Document in PR description:
1. W1c work fully merged and verified (silence-rate drops confirmed
   on sp500 re-fire)
2. This PR (4w) merges; Netlify auto-deploy completes
3. Pre-cutover smoke test: call `/api/target-rationale?ticker=NVDA`
   on the deployed function; verify the `fundamental-analyst` row
   returns non-`_noData` with reasonable score and rationale
4. Run `scripts/clear-stranded-vx-fundamentals-cache.ts --confirm`
   against prod Firestore
5. Brief settle window (no concurrent backtest runs)
6. Re-fire sp500 composite backtest. Expected: fundamental silence
   in 2022-2024 stays at 14-47% (the W1c work didn't touch
   fundamental) OR drops further if new endpoints have deeper data
7. If fundamental coverage IMPROVES in 2018-2021, that's the side-
   benefit unlock — celebrate, surface in the verdict update

---

## Acceptance criteria

### W1 (design report PR)

- `reports/phase-4w/design.md` committed; reviewed and authorised
  before W2
- All three endpoint shapes documented with sample responses
- Field mapping table complete
- Historical depth findings reported
- Cache strategy decision named
- shouldPersist opt-in decision named per endpoint
- No code changes committed beyond the design report

### W2 + W3 (fix PR)

- `getFundamentals` return shape exactly matches pre-migration
  shape (golden test passes)
- Three new fetch helpers each handle WithStatus correctly (throw
  on failure, return object on success)
- `shouldPersist: (v) => v !== null` applied per W1 decision
- Cleanup script with dry-run default + `--confirm` flag
- Regression tests in `__tests__/`; failures pin on the assembled
  result for known-good ticker+date
- All existing tests still pass
- `tsc --noEmit` clean; build clean
- APP_VERSION bumped one patch on the final fix PR
- PR opened ready-for-review (not draft)

### Phase-level

- Final fix PR merges by **early June 2026** (target)
- Post-merge cleanup runs; sp500 re-fire validates fundamental
  layer still operating (no regression from pre-migration baseline)
- Side-benefit historical depth unlock either confirmed or refuted
  with data
- Document in commit body whether the migration also affected
  consumers (Phase 6 stock-detail endpoint, etc.); none should
  break

---

## Out of scope (explicit)

- Phase 4t W1b (russell2k universe gap) — separate agent, PR #52
- Phase 4t W1c (chronic-silent earnings + insider) — separate
  agent, PR #53; landing first
- Phase 6 (Comprehensive Stock Detail Panel) — separate agent;
  `/api/stock-detail` consumes `getFundamentals` via the
  abstraction so insulated from this migration
- Phase 4v earnings overhaul — separate planned phase pending 4t
  verdict
- Modifying `runFundamentals` scoring math
- Adding new analysts or analyst components
- Adding new data providers beyond what Massive offers
- Backtest engine changes
- ML pipeline (5a)
- Performance optimization beyond what the migration requires
- Migrating other endpoints (news, insider, etc.) even if W1c's
  audit surfaces similar patterns — those are separate phases if
  they need fixing

---

## Disciplines

- **Diagnose-before-fix gate.** W1 design report ships as own PR
  BEFORE any code changes. Orchestrator reviews. PR #51's
  hypothesis-only ship is the failure mode to avoid; W1c's design
  rigor (probe, evidence, named root cause) is the model.
- **Return-shape preservation is the contract.** If the new
  endpoints can't supply every VX field, surface to orchestrator —
  that's a real regression, not a silent compromise.
- **No new dependencies.** The three new endpoints use the existing
  HTTP client and JSON parsing.
- **No silent fallback to VX.** If a new endpoint is unreachable
  (post-sunset), `getFundamentals` returns null + the existing
  `_noData` path handles it correctly. Do NOT add a "try VX first
  then fall back" pattern — VX will be dead June 22.
- **Test-pin the assembly.** A captured VX response (from cache or
  saved sample) becomes the golden reference. The migrated
  `getFundamentals` must produce a byte-equivalent result for at
  least one known-good ticker.
- **Cache cutover discipline.** Stranded VX entries get cleared via
  the cleanup script — explicit, scriptable, dry-run-by-default.
  Do not rely on TTL expiry.
- **`shouldPersist` opt-in.** The new fetches use the W1c
  predicate mechanism — `(v) => v !== null`. No silent empties on
  rate-limit failures.
- **Honest scope-creep handling.** If W1's audit surfaces unexpected
  complexity (e.g., a field that exists in VX but nowhere in the new
  endpoints), STOP and surface to orchestrator. Don't silently
  drop the field; don't silently add a fallback.

---

## Reference state

### Phase status this brief assumes

- 4t W1: MERGED, PR #48
- 4t-recovery: MERGED, PR #51
- 4t W2/W3 (verdict): PR #49 open, verdict pending
- 4t W1b: PR #52 draft, separate agent (russell2k)
- 4t W1c: PR #53 draft → W2 in flight (combined earnings + insider
  + pit-cache shouldPersist + cleanup script)
- 4q: MERGED + VERIFIED, PR #50
- 4u: MERGED
- 4v earnings overhaul: PLANNED, pending 4t verdict
- 5a ML pipeline: scaffolding only
- Phase 6 (Comprehensive Stock Detail Panel): briefed; PR-A in
  progress separately

### Files involved

#### Modify (W2)
- `netlify/functions/shared/data-provider.ts` — `getFundamentals`
  becomes a thin assembler; three new private fetch helpers added
- `netlify/functions/shared/pit-cache.ts` — already updated by
  W1c with `shouldPersist`; no further changes
- `src/App.jsx` — APP_VERSION bump

#### Create (W2/W3)
- `__tests__/data-provider-fundamentals.test.ts` — regression
  tests for the migrated function (or extend an existing test file
  if one exists)
- `scripts/clear-stranded-vx-fundamentals-cache.ts` — cleanup
  script
- `reports/phase-4w/design.md` — W1 deliverable

#### Read-only references
- `netlify/functions/shared/insider-provider.ts` — W1c's
  WithStatus pattern (model for the new fetch helpers)
- `netlify/functions/shared/earnings-intel.ts` — W1c-era earnings
  pattern (if it has a similar Promise.all + assembly shape)
- `analysts/core.ts` → `runFundamentals` — consumer; do NOT modify
- `reports/phase-4t-w1c/diagnosis.md` — architectural precedent;
  read for the "no silent []" discipline framing

### Specific anchors from prior context

- Sunset notice email: from `postmaster@mail.massive.com` received
  2026-05-21T15:26Z, subject "Action Required: Financials VX
  Endpoint Sunset on June 22, 2026"
- Vendor contact: support@massive.com (for documentation /
  migration questions)
- The W1c diagnosis report at bba2889 names the architectural
  framing: "Phase 4o W1's 'no silent []' intent undermined at the
  consumer boundary" — Phase 4w applies the same discipline to
  fundamentals

---

## Session size estimate

- **W1 (probe + design)**: 2-4 hours. Read documentation, probe
  endpoints, write design report. No code.
- **W2 (refactor + tests)**: 3-5 hours. The assembly logic is the
  bulk; tests pin it.
- **W3 (cleanup + verification)**: 1-2 hours. Script is small;
  verification procedure is documentation.

Total: 6-11 hours of agent work across one branch, ~2 PRs (W1
diagnosis-only first, then W2+W3 combined).

If W1's probe surfaces unexpected complexity (e.g., new endpoint
returns paginated data that requires multi-page assembly), stop
and surface to orchestrator before sizing W2.

---

## Failure modes to avoid

- **Skipping W1.** The "I'll just refactor it, the new endpoints
  must be similar enough" approach is exactly what produces silent
  data shape mismatches that take days to debug. W1's design report
  is the gate.
- **Building a VX-fallback path.** VX is dead June 22. Building
  defensive fallback code is wasted effort that may also hide real
  failures.
- **Silently dropping fields.** If the new endpoints don't supply a
  field the VX endpoint did, surface it. The Phase 6 detail panel
  may consume that field; silently dropping is a Phase 6 regression.
- **Touching consumers.** `runFundamentals` and Phase 6
  consumers are insulated by the abstraction. Don't refactor them
  during this phase.
- **Skipping the cleanup script.** Stranded VX cache entries WILL
  cause confusion post-deploy. The script is small; ship it.
- **Missing the deadline.** Internal target is early June, with 2-3
  weeks of buffer. If W1 surfaces unexpected complexity that pushes
  W2 past mid-June, escalate immediately — the deadline is
  non-negotiable; we'll find a way (alternative provider, contract
  Massive support, etc.).
