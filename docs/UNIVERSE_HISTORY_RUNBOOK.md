# Universe History Runbook

Phase 4 backtest reads point-in-time index membership from
`netlify/functions/shared/universe-history.ts`. That file is generated /
hand-curated and needs periodic refresh. This runbook documents how.

## Why this exists

A backtest whose universe is "current S&P 500 constituents" silently
inherits survivorship bias — the delisted, acquired, and dropped names
disproportionately underperformed, and they're not in the dataset.
Phase 3's `wasInIndexOnDate(ticker, index, date)` answers correctly
because the static history file remembers them.

## What ships in Phase 3

The static file ships with:

| Index     | Coverage                                  | Source                                                              |
| --------- | ----------------------------------------- | ------------------------------------------------------------------- |
| Dow       | 2018-01-31 through 2026-04-30, monthly    | Hand-curated from publicly documented index changes                  |
| S&P 500   | 2026-04-30 only (current seed)            | `netlify/functions/shared/universe.ts`                              |
| NDX       | 2026-04-30 only (current seed)            | `netlify/functions/shared/universe.ts`                              |
| Russell2k | 2026-04-30 only (current seed)            | `netlify/functions/shared/universe.ts`                              |

This is intentionally partial — the Phase 3 build environment cannot
reach `en.wikipedia.org` or `www.ishares.com` due to egress restrictions.
The framework, helpers, and Dow coverage all ship correctly; SP500 / NDX /
Russell historical extension is a manual run-from-laptop step.

## Refreshing in a non-restricted environment

```bash
# From the repo root, with network access to Wikipedia + iShares:
npx tsx scripts/generate-universe-history.ts
```

The generator:

1. Pulls the current S&P 500 constituent list and changes table from
   `https://en.wikipedia.org/wiki/List_of_S%26P_500_companies`.
2. Pulls the NDX constituent list + annual changes from
   `https://en.wikipedia.org/wiki/Nasdaq-100`.
3. Pulls the Russell 2000 holdings CSV from iShares for today's date.
   For historical Russell coverage, edit the script's `main()` to loop
   over month-end dates (iShares supports `asOfDate=YYYYMMDD`).
4. Reconstructs month-end snapshots by walking forward from each
   index's earliest known constituent set, applying changes at their
   effective dates.
5. Writes `netlify/functions/shared/universe-history.ts`.

The generator's parser implementations (`parseWikipediaTickerColumn`,
`parseWikipediaChangesTable`, `parseWikipediaAnnualChanges`,
`parseIWMHoldings`) are stubs that throw in seed-only mode. They need
filling in when run from a non-restricted env — the scaffolding marks
exactly where each parser plugs in.

## Re-run cadence

**Monthly.** The current month-end snapshot needs to roll forward, and
the generator captures any newly-effective index changes. Add to the
maintenance calendar.

## Acceptable shortcuts

When extending historical coverage:

- **Wikipedia format breaks.** Wikipedia's table layouts change. Try
  the Wayback Machine archive of the same URL. Failing that, hand-curate
  deltas from the article history page (visible under "View history" on
  the Wikipedia article — diff between revisions shows the change rows).
- **iShares historical CSVs missing for some months.** iShares retains
  daily holdings for several years but the per-date files occasionally
  return 404 for older dates. Use what's available; document gaps. Do
  not synthesize fake constituents.
- **A ticker symbol changed.** Treat the new symbol as a new addition
  and the old symbol as a removal at the change date. Examples to be
  aware of:
    - FB → META (2022-06-09)
    - GOOG / GOOGL — both share classes are in the indices simultaneously
    - DowDuPont (DWDP) → Dow Inc (DOW) at the 2019-04-02 spinoff
- **Acquired companies.** When a constituent is acquired and delisted,
  the change table should reflect the delisting date, not the deal
  announcement date. Use the date the ticker stopped trading.

## Verification

After refresh, run:

```bash
npm test -- universe-history
```

Tests in `netlify/functions/shared/__tests__/universe-history.test.ts`
verify the lookup function contract (incl. null-on-no-coverage) and
spot-check well-known historical memberships:

- AAPL was in the Dow before its 2015 addition? false
- AAPL in Dow on 2018-03-15? true
- GE in Dow on 2018-03-15? true (GE removed June 2018)
- AMZN in Dow on 2024-04-01? true (added Feb 2024)
- NVDA in Dow on 2024-12-01? true (added Nov 2024)
- TSLA in S&P 500 on 2018-01-01? false (added Dec 2020)

If any spot-check fails after a generator run, that's a parser bug.
Investigate before committing the refreshed file.

## Coverage report

The exported `universeHistoryCoverage()` helper returns a per-index
summary with first/last date and snapshot count. Useful for surfacing
gaps in CI or in a Phase 4 backtest preflight check.

```ts
import { universeHistoryCoverage } from './netlify/functions/shared/universe-history';
console.log(universeHistoryCoverage());
// { sp500: { firstDate: '2021-01-31', lastDate: '2026-04-30', snapshotCount: 64 }, ... }
```
