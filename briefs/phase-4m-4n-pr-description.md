# Phase 4m + 4n — Williams & Lynch discrete signals + backtest validation

Closes the combined Phase 4m + 4n per `briefs/phase-4m-4n-brief.md` and
`kickoffs/phase-4m-4n-executor.md`. One PR — 4m and 4n landed together
because 4n's wiring + integrity tests turned out to be tractable; the
"deep" work the brief warned about (live PIT fundamentals) is reported
honestly rather than papered over with a flattering biased number.

## What landed

### 4m (W1–W3): discrete signals on continuous scores

- **Williams trade signal** — discrete `BUY`/`SELL`/`HOLD` derived from
  indicator confluence (%R reversal + volatility breakout + closing
  strength + EMA trend gate), not a bare score-threshold cut. Levels
  are volatility/ATR-based, matching how Williams sized trades:
  - Entry: latest close (next-bar at-market)
  - Stop: 2 × Wilder ATR(14) away from entry
  - Target: 3R from entry (3× risk distance) — Williams' "let winners
    run, cut losers small"
  - File: `netlify/functions/styles/williams-signal.ts`

- **Lynch investment signal** — discrete `BUY`/`HOLD`/`AVOID` from the
  PEG + earnings-consistency + revenue-sweet-spot + debt logic. **No
  price stop** — Lynch was a GARP buy-and-hold investor; a price stop
  would misrepresent the strategy. Instead:
  - Fair-value band: PEG ≈ 1.0 → "cheap", 1.5 → "fair upper"; price
    band = ttmEps × {growth%, growth% × 1.5} when EPS > 0 and
    growth > 0
  - Fundamental-invalidation list: the conditions whose breach exits
    the thesis (PEG > 2.0, declining revenue, D/E > 2.0, etc.)
  - BUY auto-downgrades to HOLD when current price exceeds the fair-
    value ceiling — Lynch's "the stock has caught up to the story"
  - File: `netlify/functions/styles/lynch-signal.ts`

- **Views rebuilt as sortable tables** — `WilliamsView.jsx` /
  `LynchView.jsx` show the verdict in the leftmost column (sortable
  BUY → HOLD → SELL/AVOID), entry/stop/target or fair-value band, and
  every column sortable via `useSortable`/`SortableTh`. Row click
  expands inline detail (confluence reasons + Lynch invalidation list).
  Responsive on mobile via `overflow-x-auto`. The 4k-owned files
  (App shell, target/insider views) are untouched.

- **MODEL_VERSION** 2026.03.0 → 2026.04.0 (boards emit new fields).
- **APP_VERSION** 0.18.9 → 0.19.0-alpha (user-visible verdict + levels).

### 4n (W4–W5): point-in-time backtest path + verdict reports

- **W4 — PIT scoring path.** `scoreTickerAtDate` dispatches Williams and
  Lynch alongside the existing prophet path. Both share the engine's
  PIT cache and trading calendar. Williams uses bars only (PIT-clean
  by construction). Lynch threads `asOfDate` through
  `getFundamentals` and `getEarningsHistory`, applying Polygon's
  server-side `filing_date.lte` plus the in-memory estimated-filing-
  date fallback. A new `discreteSignalOnly` config flag on
  `BacktestConfig` makes the engine validate the **discrete signal
  itself** — BUY-only portfolio vs SPY — rather than a score-ranked
  basket. `scripts/run-backtest.ts` learns `--discrete-signal-only`.
  10 new integration tests assert every fetch carries `asOfDate` (no
  fetch defaults to "now") and the BUY-only filter drops HOLD/AVOID
  candidates.

- **W5 — honest verdict reports.**
  [`reports/phase-4n/`](reports/phase-4n/) contains:
  - [`pit-integrity-attestation.md`](reports/phase-4n/pit-integrity-attestation.md):
    Williams **PIT-clean**, Lynch **PIT-correct on filing dates with a
    residual restatement caveat** (Polygon silently incorporates issuer
    restatements; the proper fix is a fundamentals snapshot store —
    its own phase). The Lynch `ScoredCandidate.metadata.pitCaveat` is
    set programmatically so the report can flag it.
  - [`williams-backtest.md`](reports/phase-4n/williams-backtest.md) and
    [`lynch-backtest.md`](reports/phase-4n/lynch-backtest.md): scaffold
    with the methodology, the PIT integrity statement, an empty
    results table, and explicit VALIDATED / NOT VALIDATED criteria.
  - [`runbook.md`](reports/phase-4n/runbook.md): exact commands to
    populate the tables once Polygon + Finnhub + Firebase creds are
    available.
  - Two configs in `configs/`:
    `williams-sp500-2018-2024-weekly-top20.json` (weekly rebalance,
    3–10 day swing horizon) and
    `lynch-sp500-2018-2024-quarterly-top20.json` (quarterly rebalance,
    6–24 month investment horizon). Both: S&P 500 (PART X default),
    Prophet-matching window, `discreteSignalOnly: true`.

  **The verdict numbers are PENDING the credentialed run.** This
  session's shell does not carry Polygon/Finnhub/Firebase creds —
  same posture as Phase 4e-1's executor delivery. The honest
  deliverable is the wiring + the integrity attestation; a
  bias-contaminated Lynch return printed as clean would be a negative
  deliverable per the brief's PART V.

## Verification

- `tsc --noEmit` — clean
- `npm test` — **943 passing** (was 910 on `main`; **+33 new tests**
  across `styles/__tests__/{williams,lynch}-signal.test.ts` and
  `shared/backtest/__tests__/score-at-date-williams-lynch.test.ts`)
- `npm run build` — clean (the existing 968 kB chunk-size warning is
  unchanged from `main`)
- MODEL_VERSION bump: 2026.03.0 → **2026.04.0**
- APP_VERSION bump: 0.18.9-alpha → **0.19.0-alpha**

## File-ownership respect (Phase 4k coordination)

This PR touches:

- `netlify/functions/styles/*`, `netlify/functions/styles/__tests__/*` —
  new files for the signal layer.
- `netlify/functions/shared/scan-{williams,lynch}.ts`,
  `netlify/functions/shared/backtest/{engine,engine-batched,types,
  score-at-date}.ts`, `netlify/functions/shared/backtest/__tests__/*`,
  `netlify/functions/shared/pit-cache.ts` (one additive type union
  member: `'earnings_history'`), `netlify/functions/shared/model-
  version.ts`, `scripts/run-backtest.ts`.
- `src/WilliamsView.jsx`, `src/LynchView.jsx` (the two
  Williams/Lynch-owned views).
- `src/App.jsx` — **only the APP_VERSION line** per the kickoff's
  4k-coordination rule. Shell/nav/Target/Insider views are untouched.
- `reports/phase-4n/*`, `configs/*`, `briefs/phase-4m-4n-pr-
  description.md`, `ORCHESTRATOR.md`.

No conflicts expected with the 4k branch.

## Acceptance (post-merge)

1. Smoke-test the Williams and Lynch boards on the deploy preview —
   verdict column shows BUY/SELL/HOLD or BUY/HOLD/AVOID, sortable,
   levels populated where applicable.
2. Run the two backtests per [`reports/phase-4n/runbook.md`](reports/phase-4n/runbook.md):
   ```bash
   npx tsx scripts/run-backtest.ts --config configs/williams-sp500-2018-2024-weekly-top20.json
   npx tsx scripts/run-backtest.ts --config configs/lynch-sp500-2018-2024-quarterly-top20.json
   ```
3. Paste the resulting metrics into `reports/phase-4n/williams-
   backtest.md` and `reports/phase-4n/lynch-backtest.md`,
   keep the Lynch restatement-caveat banner at the top regardless of
   outcome, and commit.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
