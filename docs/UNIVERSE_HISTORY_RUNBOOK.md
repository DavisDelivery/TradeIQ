# Universe History Runbook

Phase 4 backtest reads point-in-time index membership from
`netlify/functions/shared/universe-history.ts`. That file is generated
from ETF-sponsor data sources and needs periodic refresh. This runbook
documents how.

## Why this exists

A backtest whose universe is "current S&P 500 constituents" silently
inherits survivorship bias — the delisted, acquired, and dropped names
disproportionately underperformed, and they're not in the dataset.
`wasInIndexOnDate(ticker, index, date)` answers correctly because the
static history file remembers them.

## Why not Wikipedia?

Earlier follow-up briefs reached for Wikipedia as a free source for S&P
500 / NDX historical constituents. Wikipedia is **not an acceptable
data source for a trading app**:

- **No SLA.** Wikipedia makes no uptime or data-quality commitment.
- **Anyone can edit.** A vandalized table row or a delayed correction
  silently poisons backtest results.
- **Parse fragility.** Wikipedia's tables change format without notice,
  breaking scrapers.
- **No audit trail.** Compliance review cannot defend "we ran this
  decision against a free Wikipedia scrape."
- **Not vendor-of-record.** No real trading desk uses Wikipedia for
  index membership. The expectation is contractually-obligated data
  from the index sponsor, an ETF tracking the index, or a paid vendor
  (Sharadar, Norgate, Polygon CRSP).

The Wikipedia code paths have been ripped out of
`scripts/generate-universe-history.ts`. **Do not re-add them.** If you
find yourself reaching for Wikipedia, the answer is either (a) accept
the coverage gap and document it, or (b) escalate to paid-vendor sourcing.

## Sources

ETF sponsors as vendors of record. Each fund is contractually obligated
to track its index for billions in AUM, so its published holdings are
the closest free-data approximation to authoritative index membership:

| Index       | ETF | Sponsor     | URL                                                                                          | Format |
| ----------- | --- | ----------- | -------------------------------------------------------------------------------------------- | ------ |
| S&P 500     | SPY | State Street (SSGA) | `holdings-daily-us-en-spy.xlsx`                                                      | xlsx   |
| Dow         | DIA | State Street (SSGA) | `holdings-daily-us-en-dia.xlsx`                                                      | xlsx   |
| NDX         | QQQ | Invesco             | SPA-only; no public CSV/xlsx endpoint discoverable from this env                     | (n/a)  |
| Russell 2000 | IWM | iShares (BlackRock) | `…/1467271812596.ajax?fileType=csv&fileName=IWM_holdings&dataType=fund&asOfDate=…`   | csv    |

## Coverage at last regeneration

| Index     | Snapshots | First date  | Last date    | Notes                                                                                                |
| --------- | --------- | ----------- | ------------ | ---------------------------------------------------------------------------------------------------- |
| Dow       | 101       | 2018-01-31  | (current)    | Hand-curated month-end series from documented index changes + current SSGA DIA snapshot              |
| S&P 500   | 1         | (current)   | (current)    | SSGA SPY current only — SSGA silently ignores `asOfDate`, returns today's holdings regardless        |
| NDX       | 1         | (current)   | (current)    | Falls back to `netlify/functions/shared/universe.ts` tagged subset (curated, ~70 tickers) — Invesco QQQ blocked at last run |
| Russell 2k | 52        | 2022-01-31  | 2026-04-30   | iShares IWM historical via `asOfDate=YYYYMMDD`; trading-day rollback handles weekend month-ends      |

## How to refresh

```bash
# From repo root, with network access to ssga.com and ishares.com:
npx tsx scripts/generate-universe-history.ts
```

Expected runtime: ~80–90 seconds (Russell backfill dominates — ~52 IWM
historical CSV fetches throttled at 250ms each).

The generator:

1. Fetches the current SSGA SPY xlsx → SP500 current snapshot.
2. Fetches the current SSGA DIA xlsx → Dow current snapshot.
3. Emits 100+ Dow monthly snapshots from hand-curated index-change history
   (the SEGMENTS constant in the generator). The latest SSGA snapshot
   supplements this.
4. Walks IWM historical month-ends from 2022-01-31 forward via the
   `asOfDate=YYYYMMDD` parameter. Weekend month-ends roll back to the
   nearest prior trading day; the canonical month-end is preserved as
   the snapshot key.
5. NDX falls back to the `universe.ts` curated subset (Invesco QQQ
   is SPA-only and not scrape-able from this env at audit time).
6. Writes `netlify/functions/shared/universe-history.ts` (entire file
   is generator output — do not hand-edit).

## Re-run cadence

**Monthly.** The current SP500/Dow snapshot rolls forward, and the
Russell backfill grows by one new month-end. Add to the maintenance
calendar.

## Acceptable shortcuts

When extending coverage:

- **iShares historical CSV missing for some months.** The generator
  rolls back day-by-day up to 5 days when the canonical month-end is a
  non-trading day. If even after rollback no data comes back, the month
  is skipped and logged — do not synthesize.
- **SSGA xlsx format changes.** Inspect the file with the `xlsx` package
  and update the `fetchSsgaHoldingsXlsx` parser. The current parser
  expects "Holdings:" in row 2 and a "Ticker" column in row 4.
- **Invesco QQQ becomes reachable.** Add an `fetchQqqHoldings` function
  paralleling `fetchSsgaHoldingsXlsx` and remove the NDX fallback to
  `universe.ts` in the generator's `main()`.
- **A ticker symbol changed.** ETF sponsors emit symbol changes at their
  effective dates. The generator picks up the new symbol automatically;
  no manual reconciliation needed unless backtest code is hardcoded to
  the old symbol.

## When to escalate to paid vendor

If SP500 or NDX historical coverage genuinely matters for Phase 4
backtest and the free ETF-sponsor approach can't deliver it (SSGA does
not expose historical SPY/DIA holdings; Invesco QQQ remains
SPA-blocked), the correct move is a paid vendor:

- **Sharadar** (Nasdaq Data Link) — Equities catalog with point-in-time
  index membership.
- **Norgate Data** — Survivorship-bias-free historical universes for
  US stocks.
- **Polygon CRSP** — Polygon's higher-tier CRSP-sourced reference.

Do not reach for unofficial sources to bridge the gap.

## Verification

After refresh:

```bash
npx tsc --noEmit
npm test -- universe-history    # 21 tests
npm run build
```

All three should pass. The `universe-history.test.ts` tests assert the
lookup contract (returns / null / boundaries) — they tolerate moving
snapshot dates as long as data is reasonably recent.

Quick sanity REPL:

```js
import { wasInIndexOnDate, tickersInIndexOnDate, universeHistoryCoverage }
  from './netlify/functions/shared/universe-history';

universeHistoryCoverage();
// → per-index { firstDate, lastDate, snapshotCount }

tickersInIndexOnDate('sp500', '2026-05-07')?.length;
// → ~500 (real SPY holdings)

wasInIndexOnDate('NVDA', 'dow', '2024-12-01');
// → true (added Nov 2024)

wasInIndexOnDate('TSLA', 'sp500', '2018-01-01');
// → null (no SP500 history that far back — SSGA does not expose archive)
```
