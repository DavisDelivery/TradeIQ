# Phase 4n — PIT integrity attestation

This is the honest engineering statement on look-ahead-bias risk for
the Williams and Lynch backtests. The brief (PART V) named this as
the single most important integrity point in 4n: "A backtest's job
is to tell the truth about whether a signal works. A flattering lie
is a negative deliverable."

## TL;DR

| Board | PIT risk | Status |
|---|---|---|
| Williams | none beyond standard | **PIT-clean** |
| Lynch | Polygon may serve restated fundamentals | **PIT-correct on filing dates; residual restatement risk** |

The Williams backtest can be presented as a clean PIT result. The Lynch
backtest **must** be presented with the restatement caveat — the
filing-date filter is correctly applied, but the values inside those
filings can be revised by the issuer later, and Polygon silently
incorporates those revisions. We do what we can and label what we can't.

---

## Williams — PIT-clean

**Inputs:** daily OHLCV bars only.

**PIT risk surface:** none beyond what's already audited in
`docs/POINT_IN_TIME_AUDIT.md`. Daily bars do not get restated after
publication; the bar for date D, fetched today, is the same bar that
was true on date D.

**Verification:** the `score-at-date-williams-lynch.test.ts` integration
test asserts every `getDailyBars` call from `scoreWilliamsAtDate` has
`to === asOfDate`. No fetch defaults to `new Date()`. The signal
derivation (`deriveWilliamsSignal`) is a pure function over the
returned bars + the AnalystScore — no I/O, no clock reads, no future
data.

**Verdict:** Williams 4n results can be presented as **honest PIT**.

---

## Lynch — PIT-correct on filing dates, restatement caveat applies

**Inputs:** fundamentals (PEG, EPS growth, revenue growth, debt-to-
equity, operating margin) + earnings history (EPS actual vs estimate
per quarter) + a single price (latest close at `asOfDate`).

**What the PIT path correctly enforces:**

1. **Bars** — `getDailyBars(ticker, from, asOfDate)`. No bars later
   than `asOfDate` are visible. The "current price" for the
   fair-value band is the close on `asOfDate`, not today's close.
2. **Fundamentals filing-date filter** — `getFundamentals(ticker,
   { asOfDate })` filters server-side via Polygon's `filing_date.lte`
   parameter AND in-memory via `(filing_date ?? estimateFilingDate(...))
   <= asOfDate`. Filings made after `asOfDate` are not seen.
3. **Earnings history period filter** — `getEarningsHistory(ticker, 4,
   { asOfDate })` drops any row whose `period > asOfDate`. The backtest
   only sees quarters that had already been reported.

**The residual risk we cannot eliminate from this PR:**

Polygon's `/vX/reference/financials` silently incorporates **issuer
restatements** into past filings. If Apple reported $97B of 2021
revenue in early 2022, then revised it to $94B in a 2023 10-K/A, the
endpoint serves the revised $94B today when you query the 2021
filing. The agent scoring an `asOfDate` in 2021 today therefore sees
the 2023 view of 2021 fundamentals — that is look-ahead.

This is documented in `data-provider.ts` line 159–163 ("RESIDUAL RISK:
Polygon silently incorporates restatement edits...") and in
`docs/POINT_IN_TIME_AUDIT.md`. The proper fix is to snapshot
fundamentals into the `boardSnapshots` store at scan time and read
from that store during backtests — a Phase 1 schema extension. That
work is out of scope for Phase 4n; it deserves its own brief.

**What this means in practice:**

- **Magnitude.** Restatements on large-cap S&P 500 issuers are uncommon
  and usually small (single-digit percentages). The Lynch backtest is
  therefore likely directionally informative but the magnitudes
  optimistic. We constrain the backtest to S&P 500 specifically to
  minimize this — restatements are more frequent and material in
  small caps (Russell 2K), which is why the brief recommends starting
  with S&P 500.
- **Direction of bias.** Restatements that lower past revenue/EPS
  would *retrospectively* turn some past-good companies into past-bad
  companies — a TODAY view of bad fundamentals on a date where the
  market was still operating on the GOOD reported numbers. This can
  cut either way for the backtest, but for a GARP-style screener it
  most commonly creates a survivorship-style overconfidence (we keep
  the names that ended up restated favorably; we drop names that were
  restated downward).
- **Earnings beats.** Quarterly EPS-vs-estimate beats can also be
  restated, less frequently and usually only on EPS-actual, not on
  the consensus estimate (which is a historical record). The beats
  count therefore has lower restatement contamination than the
  ratios-from-revenue inputs.

**Verification:** the integration test asserts every `getFundamentals`
and `getEarningsHistory` call from `scoreLynchAtDate` carries the
`asOfDate` opt. The `pitCaveat` metadata field is also set on every
Lynch ScoredCandidate so the verdict report can flag it programmatically
(`result.metadata.pitCaveat`).

**Verdict:** Lynch 4n results must be presented with the residual-
restatement caveat printed at the top, not buried. The
`lynch-backtest.md` template enforces this.

---

## What would close the residual risk

Fundamentals snapshot store. Each board scan persists the
fundamentals it saw into `boardSnapshots/lynch/{asOfDate}/{ticker}`
with the public-on-that-date values. The Lynch PIT path then reads
from snapshots first, falling back to the Polygon live query only
for dates within the snapshot retention window. After ~12 months of
snapshot accumulation the backtest window grows organically into
true PIT territory.

That's a follow-up phase, not a 4n deliverable. The 4n deliverable
is to **wire the path correctly and tell the truth** about what
remains uncertain. This document is that truth.
