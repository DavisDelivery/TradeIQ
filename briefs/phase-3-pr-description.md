# Phase 3: Point-in-time data layer (v0.12.0-alpha)

## Preconditions

- Phase 0 + Phase 1 + Phase 2 done in `ORCHESTRATOR.md` ✓ (verified at branch start)
- Baseline 127 tests passing on `main` ✓
- All five providers (Polygon, Finnhub, Quiver, FRED, Anthropic) wrapped through Zod schemas ✓

## What's in this PR

Every external data call answerable as a function of `asOfDate`. A
historical universe-history module gives Phase 4's backtest survivorship-
bias-correct index membership, with Dow at full month-end coverage from
2018-01-31 through 2026-04-30 (100 snapshots).

**APP_VERSION** bumped from `0.11.1-alpha` → `0.12.0-alpha` (minor bump
for the new data layer).

## Per-provider audit summary

| Provider | Data class                  | Native PIT?            | Where it lives                                        |
| -------- | --------------------------- | ---------------------- | ----------------------------------------------------- |
| Polygon  | Daily bars                  | Yes (implicit)         | `getDailyBars` (no code change; comment + verification)|
| Polygon  | Fundamentals                | Partial                | `getFundamentals(t, { asOfDate })` — server `filing_date.lte` + in-memory `estimateFilingDate` fallback for null filing_date 10-Ks |
| Polygon  | News                        | Yes                    | `getNews(t, { asOfDate })` — `published_utc.lte=<asOfDate>T23:59:59Z` |
| Finnhub  | Recommendations             | Hybrid (rolling + fallback) | `getRecommendations(t, { asOfDate })` — live filter ≤4mo, then catalyst snapshot store fallback |
| Finnhub  | Insider transactions        | Yes                    | `getFinnhubInsiderTransactions(t, days, { asOfDate })` + `getInsiderActivity(t, days, { asOfDate })` |
| Quiver   | Congressional + lobbying    | Approximate            | `getPoliticalActivity(t, days, { asOfDate })` — STOCK Act 45-day buffer documented as residual |
| Quiver   | Government contracts        | Yes                    | `getGovContractActivity(t, days, { asOfDate })` — uses `Date` (publication), NOT `action_date` |
| Quiver   | Patents                     | Yes (structural)       | `getPatentActivity(t, name, days, { asOfDate })` — endpoint coverage is currently empty (audit-time observation) |
| FRED     | Macro series                | Yes (gold standard)    | `getFredSeries(s, { asOfDate })` + `getMacroData({ asOfDate })` via `vintage_dates` |
| Snapshot store fallback     | n/a                    | `snapshotBeforeDate` + `fieldAtDate` helpers in `snapshot-store.ts` |

`docs/POINT_IN_TIME_AUDIT.md` is the master spec — every PIT decision
documented there, including residual look-ahead-bias risks and the
asOfDate format/timezone convention.

## Universe history coverage

| Index     | First date  | Last date   | Snapshots | Notes                                                      |
| --------- | ----------- | ----------- | --------- | ---------------------------------------------------------- |
| Dow       | 2018-01-31  | 2026-04-30  | 100       | Full monthly. Hand-curated from documented index changes (GE→WBA 2018, AMGN/HON/CRM↔XOM/PFE/RTX 2020, AMZN→WBA 2024, NVDA→INTC + SHW→DOW 2024). |
| S&P 500   | 2026-04-30  | 2026-04-30  | 1         | Current seed only — Wikipedia hostname-blocked at egress. |
| NDX       | 2026-04-30  | 2026-04-30  | 1         | Same as SP500.                                            |
| Russell2k | 2026-04-30  | 2026-04-30  | 1         | iShares hostname-blocked at egress.                       |

**Honest about the SP500/NDX/Russell gap.** The Phase 3 build environment
hostname-blocks `en.wikipedia.org` and `www.ishares.com`. The framework
ships correct (helpers, types, lookup contract, generator script,
runbook); historical extension for SP500/NDX/Russell is a manual
runbook step in any non-restricted env. The Dow ships at full coverage
because it's small enough to hand-curate accurately.

The runbook (`docs/UNIVERSE_HISTORY_RUNBOOK.md`) explains exactly how to
extend: `npx tsx scripts/generate-universe-history.ts` from a normal
environment.

## Test count

- Baseline: 127
- New: 55 (target was 28; came in higher because Dow's full coverage
  enabled a thorough historical-membership test battery)
- Total: 182, all green
- `npx tsc --noEmit` clean
- `npm run build` clean

New test files:
- `netlify/functions/shared/__tests__/universe-history.test.ts` (21 tests)
- `netlify/functions/shared/__tests__/data-provider-pit.test.ts` (19 tests)
- `netlify/functions/shared/__tests__/quiver-providers-pit.test.ts` (7 tests)
- `netlify/functions/shared/__tests__/snapshot-store-pit.test.ts` (8 tests)

## Known residual look-ahead-bias risks (be honest — Phase 4 will hit them)

1. **Polygon fundamentals restatement drift.** Even with `filing_date.lte`
   filtering, today's response for a 2022 filing reflects subsequent
   restatements. Real fix is extending Phase 1's snapshot schema to
   persist fundamentals at scan time — Phase 1 territory, out of scope.
2. **Finnhub recommendation history depth.** Live endpoint returns ~4
   months. PIT before that depends on Phase 1's accumulated catalyst
   snapshots, which only began recently. Phase 4 backtest should not
   extend rec-PIT data beyond available snapshot history.
3. **Quiver congressional disclosure lag.** STOCK Act gives politicians
   45 days. We filter on transaction `Date`. Phase 4 should layer a
   45-day forward shift before consuming this signal in backtest.
4. **Polygon fundamentals null filing_date estimate.** ~75 day end_date
   offset for 10-Ks has up to ±15 day error. Documented; immaterial at
   monthly/quarterly backtest cadence.
5. **Hot PIT path caching.** Phase 4 will call PIT functions thousands
   of times. Functions are marked `// PIT-cacheable: keyed by (...)` so
   a Firestore-backed cache wraps cleanly. Cache itself is Phase 4 work.
6. **Universe history depth gap.** SP500/NDX/Russell ship current-seed
   only; runbook extension required for full Phase 4 backtest scope.

## Smoke test plan for the merging agent

1. Verify `APP_VERSION` shows `0.12.0-alpha` live at
   `https://tradeiq-alpha.netlify.app/` after deploy.
2. Hit `/.netlify/functions/health` — confirm no 5xx.
3. Spot-check a PIT call against Polygon (e.g., NVDA fundamentals at
   `asOfDate: '2023-06-01'` should return Q1 2024 onwards excluded).
4. Confirm `wasInIndexOnDate('NVDA', 'dow', '2024-12-01')` returns true
   in a Node REPL or test runner.
5. Confirm ORCHESTRATOR.md Status table shows Phase 3 as `done`.

## Notable bug catches during this phase

- **Polygon's `filing_date` is null for many 10-K annuals** (NVDA Q4 2026
  in our test queries). The brief assumed it's always present; it isn't.
  Mitigated with `estimateFilingDate(end_date, fiscal_period)` heuristic.
- **Polygon's `published_utc.lte=YYYY-MM-DD` is end-of-day inclusive in
  practice** (verified — articles from 2024-01-01T13:30:00Z came through
  with `lte=2024-01-01`). Brief assumed it's midnight-start. We pass the
  explicit `T23:59:59Z` form anyway per convention to be unambiguous.
- **Finnhub recommendations DO have a usable PIT field** (`period`),
  but only ~4 months of rolling history. Brief said "no PIT path." The
  hybrid live-filter + snapshot-fallback design is the right answer.
- **Quiver insider endpoint returns 404 on this account** — the
  codebase already routes through Finnhub. No-op for this workstream;
  documented in audit doc.
- **Polygon ticker reference `date=` parameter isn't fully PIT** —
  market_cap and SIC are returned at TODAY's value, not the asOfDate
  value (verified — AAPL with `date=2018-03-15` returned $2.93T market
  cap, which is current). Useful only for "was this ticker active on
  this date." Documented prominently in audit doc.
- **Polygon delisted ticker retention**: FRBA + FRC (2023 delistings)
  return full pre-delisting bars; LEHMQ (2008) returns NOT_AUTHORIZED
  on the current Polygon plan tier. 5-year backtest scope is safe;
  pre-2018 backtests would need a tier upgrade.

## File summary

```
docs/POINT_IN_TIME_AUDIT.md                                              new (~280 lines)
docs/UNIVERSE_HISTORY_RUNBOOK.md                                         new (~110 lines)
scripts/generate-universe-history.ts                                     new (~250 lines)
netlify/functions/shared/data-provider.ts                                modified (+~250)
netlify/functions/shared/insider-provider.ts                             modified
netlify/functions/shared/political-provider.ts                           modified
netlify/functions/shared/patent-provider.ts                              modified
netlify/functions/shared/govcontracts-provider.ts                        modified
netlify/functions/shared/snapshot-store.ts                               modified (+~80)
netlify/functions/shared/universe-history.ts                             new (~225 lines)
netlify/functions/shared/schemas/finnhub.ts                              modified (+rec schema)
netlify/functions/shared/schemas/polygon.ts                              modified (filing_date nullable)
netlify/functions/shared/__tests__/universe-history.test.ts              new
netlify/functions/shared/__tests__/data-provider-pit.test.ts             new
netlify/functions/shared/__tests__/quiver-providers-pit.test.ts          new
netlify/functions/shared/__tests__/snapshot-store-pit.test.ts            new
src/App.jsx                                                              APP_VERSION bump
ORCHESTRATOR.md                                                          Phase 3 row → done
```
