# Phase 0a-2 — sp500 PIT universe-history backfill

Closes the sp500 PIT-coverage gap that has been forcing every
historical sp500 backtest (and Phase 5a's seed runs) to complete
with `tradeCount = 0` because every rebalance date emitted
"universe pool empty (no PIT snapshot covers date)".

## What changed

| File                                                          | Status      | Why |
|---------------------------------------------------------------|-------------|-----|
| `scripts/lib/ishares-holdings-csv.ts`                         | **new**     | Extracted parser; shared by IVV and IWM |
| `scripts/generate-universe-history.ts`                        | edit (+85)  | `backfillSp500History()` + shared `fetchIsharesHoldingsCsv()` |
| `netlify/functions/shared/universe-history.ts`                | regenerated | Adds 100 monthly sp500 snapshots 2018-01-31 → 2026-04-30 |
| `netlify/functions/__tests__/ishares-holdings-csv.test.ts`    | **new**     | 10 hermetic parser tests |
| `netlify/functions/shared/backtest/__tests__/universe-pool.test.ts` | edit | sp500 is no longer "current-seed only" — assertions updated |
| `netlify/functions/shared/backtest/__tests__/walk-forward-integrity.test.ts` | edit (1 case) | Test 6b inverted (`corrected=false → corrected=true`) |
| `reports/phase-0a-2/backfill-report.md`                       | **new**     | W7 deliverable — full backfill report |
| `briefs/phase-0a-2-pr-description.md`                         | **new**     | This file |
| `ORCHESTRATOR.md`                                             | edit        | Mark 0a-2 row done; flag Phase 5a as unblocked |
| `.gitignore`                                                  | edit        | Add `.secrets/`, `data/backfill-log.jsonl`, `data/cache/` |

## Approach

Instead of the brief's Wikipedia → Firestore design (incompatible
with the repo state — see "Divergence from brief" below), this
phase uses the existing `iShares IWM asOfDate → static
UNIVERSE_HISTORY` pattern, just pointed at iShares **IVV** for
S&P 500.

The new `backfillSp500History()` is a near-clone of the existing
`backfillRussell2kHistory()`. Same monthly-cadence loop, same
weekend-rollback logic, different ETF URL and a higher minimum
member threshold (400 instead of 100).

## Backfill stats

- **101 sp500 snapshots** (1 current SSGA SPY + 100 monthly IVV)
- Date range: **2018-01-31 → 2026-05-14**
- Ticker counts: **503-510 per snapshot** (within "500 ± 10" target)
- Zero IVV fetches failed or had to be skipped
- 100% of weekend month-ends were resolved via 1-2 day rollback

## Verification

Spot-checks against documented S&P 500 history (full table in
`reports/phase-0a-2/backfill-report.md`):

- FB present 2018-01 → 2021-12; META appears 2022-06 onward (real
  rename: June 9, 2022 ✓)
- TSLA absent before 2020-12, present after (real add: Dec 21, 2020 ✓)
- ABNB absent before 2023, present 2024-12 (real add: Sept 18, 2023 ✓)
- TWTR present through 2022-06, gone by 2022-12 (Elon acquisition
  closed Oct 27, 2022 ✓)
- GE present throughout (kicked out of *DJIA* June 2018, stayed in
  S&P; spot-check passes)

Engine-level: `engine.ts:353` is the empty-pool gate that
previously short-circuited every sp500 rebalance. Post-0a-2,
`universePoolForDate('sp500', '2020-06-30')` returns ~509 tickers
with `corrected=true` (verified in updated unit tests).

## Tests

- 522 → 534 passing (net +12)
- `npx tsc --noEmit`: clean
- `npm run build`: clean

## Divergence from brief

The kickoff brief
(`kickoffs/phase-0a-2-executor.md`) specified Wikipedia parsing →
backward-walk membership reconstruction → Firestore daily writes,
plus a Polygon/Databento symbol-activity verifier. After surfacing
these structural conflicts:

1. **Wikipedia is decommissioned** in the current repo
   (`netlify/functions/shared/universe-history.ts` header rule).
2. **The backtest engine reads `UNIVERSE_HISTORY` from a static TS
   module, not Firestore.** Firestore writes would have been
   invisible to the engine.
3. **An iShares ETF pattern already exists** for russell2k via
   IWM `asOfDate`; iShares IVV honors `asOfDate` back to at least
   2017-12-29 (verified probe), making it the natural sp500 fit.

I asked for guidance and Chad approved the IVV pivot. The shipped
scope (~150 LOC + tests) is roughly 1/10 of what the brief
estimated, because the iShares ETF is itself the
survivorship-corrected PIT source — no separate reconstruction or
verifier needed.

**Brief should be updated post-merge to reflect the IVV-via-generator
approach.** Polygon and Databento API keys provided by Chad are
unused in this PR; either would still be useful for a future
symbol-activity audit phase.

## Acceptance test (post-merge, post-deploy)

The brief's W6 curl is preserved verbatim; only the runtime shifts
from "during backfill conversation" (per the Firestore design) to
"after PR merge + Netlify redeploy" (per the static-TS-module
design).

Run from any shell after merge:

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {
      "topN": 50,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 50
    },
    "costs": { "slippageBps": { "sp500": 10 }, "commission": 0 },
    "initialCapital": 100000
  }'
```

Acceptance: `metrics.tradeCount > 0` AND `mlTrainingCount >= 3000`.

## Phase 5a unblock

Phase 5a's data gate (2 sp500 monthly/top50 runs ≈ 8,400 rows) was
blocked because no sp500 backtest could produce data. With this PR
merged + deployed, those seed runs can fire and the 10k-row data
gate should clear after a single rerun.

## What's NOT in this PR

- **NDX backfill** (Phase 0a-2b). Invesco QQQ remains blocked at
  the generator's network egress.
- **Pre-2022 russell2k coverage** (Phase 0a-2c). IWM's `asOfDate`
  archive starts 2022-01-31.
- **Pre-2018 sp500 coverage.** IVV would support deeper history,
  but pre-2018 sector mapping shifted enough that backtests would
  need their own caveat layer.
- **Ticker-format normalization.** IVV emits `BRKB`/`BFB`/`DISCA`
  (no period); SSGA SPY emits `BRK.B`/`BF.B`. Polygon resolves
  both — this is pre-existing iShares behavior (russell2k IWM has
  the same characteristic) — but a future cleanup could normalize.
