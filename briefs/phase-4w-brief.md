# Phase 4w — Massive Financials VX Endpoint Migration

> **Status: ACTION ITEM / PLANNED (stub, not yet briefed in full)**
>
> Logged 2026-05-21. Triggered by sunset notice email from
> postmaster@mail.massive.com received 2026-05-21T15:26Z.
>
> This file is a STUB — enough context for the orchestrator and
> executor agent to pick up the phase when activated. Full brief to
> be written when the phase is greenlit for kickoff (expected: after
> W1c W2 PR merges and post-merge sp500 re-fire verification lands).

---

## TL;DR

Massive (TradeIQ's fundamentals data vendor) is sunsetting the
**Financials VX endpoint** on **Monday, June 22, 2026**. The
endpoint was deprecated 2025-09-20 and is no longer supported. The
account triggered the notice email because it has used the
deprecated endpoint within the last 30 days, confirming TradeIQ is
actively consuming it.

Without migration, the **fundamental analyst breaks across all
timeframes** (live target board scoring + backtest) at midnight on
2026-06-22.

---

## Hard deadline

**Monday, June 22, 2026** (32 days from logged-on date 2026-05-21).

Recommended internal target: **early June 2026** to leave 2-3 weeks
of buffer for post-migration verification, dead-cache cleanup, and
unforeseen plan-access issues.

---

## What's affected

### Code site
- `netlify/functions/shared/data-provider.ts` → `getFundamentals(ticker, opts)`
  is the abstraction that today calls the Financials VX endpoint.
- All consumers of `getFundamentals` (the fundamental analyst, the
  Phase 6 `/api/stock-detail` endpoint, anywhere else it's called)
  inherit the break via the abstraction. The migration changes the
  IMPLEMENTATION of `getFundamentals` while preserving the call
  signature.

### Functional impact if not done

- **Live target board**: fundamental layer scoring fails → `_noData`
  for every ticker → composite drops one active factor.
- **Backtest**: same failure mode. Coverage chart's "14-47% silent
  fundamental in 2022-2024" goes to **100% silent across all
  dates**, including live.
- **Phase 6**: `/api/stock-detail` endpoint loses the fundamentals
  history + key metrics that come from this provider.
- **Composite active-factor count** drops: 2018-2021 from 3 to 3
  (unchanged — fundamental was already silent there), 2022-2024 from
  5 to 4 (real regression).

---

## Migration target

Massive's notice replaces the single Financials VX endpoint with
**three new Fundamentals endpoints**:

- **Balance Sheets**
- **Cash Flow Statements**
- **Income Statements**

The migration in `getFundamentals` is roughly: replace the VX call
with three parallel calls (Promise.all), then assemble the responses
into the existing return shape so consumers don't change.

Estimated effort: **200-400 LOC including tests**. Roughly 5-10
agent hours.

---

## Plan-access prerequisite (Chad action)

The email notes:

> "Depending on your current plan, accessing the Fundamentals
> endpoints may require an upgrade or add-on. Individuals can access
> them on Stocks Advanced or the Stocks Financials Add-on.
> Organizations can access them on Stocks Business or the Stocks
> Financials for Business Add-on."

**Before the brief is expanded and the phase kicks off, Chad must
verify his Massive subscription covers the new endpoints.** This is
a 5-minute action: log into massive.com, check subscription tier,
confirm Stocks Advanced/Business + (if needed) the Financials
Add-on.

If the current plan doesn't cover the new endpoints, decide:
- Upgrade plan, OR
- Find an alternative fundamentals data provider

No engineering work begins until this is resolved.

---

## Side-investigation worth running during W1 diagnosis

Massive's notice states the new endpoints provide "expanded coverage
and improved functionality compared to the legacy Financials VX
endpoint."

If "expanded coverage" includes **deeper historical depth**, this
migration may also dissolve the 2018-2021 fundamental cliff (which
the Phase 4t coverage analysis attributed to provider history
limits at the VX endpoint).

The W1 diagnosis should explicitly probe the new endpoints for:
- AAPL Q1 2018 balance sheet — does it return?
- AAPL Q1 2018 income statement — does it return?
- Same for one or two other 2018 sp500 tickers

If yes, the migration delivers a backtest unlock as a side benefit.
If no, the cliff remains a provider-history-limit constraint.

---

## Sequencing — DO NOT START YET

Phase 4w starts AFTER:

1. **W1c W2 PR merges** (earnings + insider fix, currently in
   flight). Both phases touch `data-provider.ts`; avoiding the merge
   conflict is the only reason for sequencing — there's no
   logical dependency.
2. **W1c post-merge verification completes** (cleanup script runs,
   sp500 re-fire validates silence-rate drops).
3. **Chad verifies plan access** (above).

Once those three gate items clear, the full Phase 4w brief gets
expanded (replacing this stub) and the executor agent kicks off.

---

## Open questions to resolve when expanding to full brief

- **Cache key shape**: Do the new endpoints have different response
  shapes? If yes, the PIT cache keys (`{provider: 'polygon',
  dataClass: 'fundamentals', ticker, asOfDate, ...}`) may need
  updating. Old cache entries get stranded; new code reads/writes
  new keys.
- **Cleanup script**: Likely needed for stranded VX-shape cache
  entries, similar to W1c's `clear-stale-insider-empties.ts`
  pattern. Conservative clear-all on `dataClass: 'fundamentals'` is
  probably right.
- **shouldPersist opt-in**: The new endpoints inherit the same
  rate-limit risk as VX. Opting fundamentals into the
  `shouldPersist: (v) => v !== null` predicate (the pit-cache.ts
  mechanism W1c is adding) is consistent with the "no silent []"
  discipline. Default-include in the new `getFundamentals` impl.
- **URL construction audit**: do the new endpoints support the
  asOfDate filter (from/to params, or as-of-period parameter)? The
  diagnosis classification from 4t W1c — "URL doesn't apply
  historical filter" — should be ruled out for each of the three
  new endpoints. Verify before assuming.
- **Live vs PIT path consistency**: confirm both call paths use the
  same provider URLs (the live path's "always recent" semantic
  should match the PIT path's asOfDate semantic, just with
  different params).

---

## Reference state at logging time

- 4t W1c (chronic-silent earnings + insider) — PR #53 open,
  W2 implementation in flight; landing imminent
- 4t W1b (russell2k UNIVERSE_HISTORY) — PR #52 open, separate agent
- Phase 6 (comprehensive stock detail panel) — PR-A in flight,
  insulated from this migration via the `getFundamentals`
  abstraction
- 4t W2/W3 verdict — pending W1c verification
- 4v earnings overhaul — PLANNED, pending 4t verdict
- 5a ML pipeline — scaffolding only

---

## When this stub gets expanded

Triggered by EITHER:
- W1c verification completes successfully (insider silence drops to
  <40%, earnings silence drops to <30% in 2020+) AND Chad confirms
  plan access — at which point orchestrator expands stub → full
  brief and writes the kickoff
- OR June 1, 2026 reaches and the gate items aren't clear — at
  which point we escalate to "ship anyway with whatever's in
  flight" because the deadline is non-negotiable

The June 22 deadline is FIRM. No engineering excuse delays it.
