# Phase 4n — Williams + Lynch backtest validation

**Status:** wiring shipped, live verdict numbers **PENDING credentialed run**.

This directory holds the verdict reports for the Williams and Lynch
discrete signals introduced in Phase 4m. The work split:

- [`pit-integrity-attestation.md`](./pit-integrity-attestation.md) — the
  honest CTO statement of how PIT-clean the backtest path is for each
  board, including what we can't fix without a fundamentals-snapshot
  store.
- [`williams-backtest.md`](./williams-backtest.md) — Williams trade-signal
  verdict report (BUY-verdict portfolio vs SPY).
- [`lynch-backtest.md`](./lynch-backtest.md) — Lynch investment-signal
  verdict report (BUY-verdict portfolio vs SPY) with the
  fundamentals-restatement caveat surfaced.
- [`runbook.md`](./runbook.md) — exact commands to populate this
  directory once Polygon + Finnhub creds are available.

## Why the numbers are pending

The executor session that landed Phase 4m+4n has the wiring + the
integrity tests, but no Polygon / Finnhub / Firebase service account
in its shell environment. Running the backtest end-to-end requires
all three (Polygon for bars + fundamentals, Finnhub for earnings
history, Firebase for the PIT cache). Same posture as Phase 4e-1's
initial executor delivery.

**Shipping the wiring without the numbers is the honest move.** A
bias-contaminated Lynch return printed without the caveat would be
worse than no number — that's the failure mode PART V of the brief
flagged. The runs land after the PR merges and live in the same
report files.

## What's verified now (no creds needed)

- 23 unit tests over `deriveWilliamsSignal` and `deriveLynchSignal` —
  verdict-from-confluence logic for every BUY/SELL/HOLD/AVOID path,
  ATR-stop math, fair-value-band math, price-above-ceiling downgrade
  (`netlify/functions/styles/__tests__/`).
- 10 integration tests over the PIT scoring path — every data fetch
  threads `asOfDate`, no fetch defaults to "now"; the `discreteSignalOnly`
  filter drops non-BUY candidates as expected
  (`netlify/functions/shared/backtest/__tests__/score-at-date-williams-lynch.test.ts`).
- `tsc --noEmit` clean, `npm test` 944+ tests green, `npm run build`
  clean.
