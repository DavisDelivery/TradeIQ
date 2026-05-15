# Phase 4f-finish — deferred 4f work

Follow-up to [#27](https://github.com/DavisDelivery/TradeIQ/pull/27)
(the merged "partial" 4f). Carries the W2 diagnoses, the remaining
W3 repairs, the W5 weight removals + UI badges, and the
options-unusual wiring forward; explicitly skips W6 pending the
4e-1-finish backtest infra fix.

## What changed

| File | Status | Why |
|------|--------|-----|
| `reports/phase-4f/audit.md` | extended | § 2 per-stub diagnoses (W2), § 3 actions, § 4 options caveat, § 5 re-audit plan |
| `netlify/functions/analysts/core.ts` | edit | `runEarnings` / `runNewsSentiment` / `runFundamental` / `runFlow` now emit `signals._noData=true` on empty inputs (W3) |
| `netlify/functions/__tests__/core-analysts-no-data.test.ts` | **new** | 12 hermetic tests for the new `_noData` paths |
| `netlify/functions/shared/analyst-runner.ts` | edit | `ANALYST_WEIGHTS['macro-regime']=0` and `['patent-analyst']=0` (W5 permanent removals) + documentation block |
| `netlify/functions/shared/institutional-flow/polygon-options-snapshot.ts` | **new** | Minimal Polygon `/v3/snapshot/options/{ticker}` fetcher returning an `OptionsTickWindow` |
| `netlify/functions/shared/institutional-flow/__tests__/polygon-options-snapshot.test.ts` | **new** | 6 hermetic tests with mocked fetch |
| `netlify/functions/scan-institutional-flow-largecap.ts` | edit | Wires `computeOptionsFlowSignal` per ticker; reads prior-day OI from Firestore cache; writes optionsFlow alongside dark-pool + block-trades |
| `netlify/functions/__tests__/scan-institutional-flow-largecap.test.ts` | edit | Adds mocks for polygon-options-snapshot + firebase-admin |
| `src/components/AnalystContributions.jsx` | **new** | LIVE / NO DATA / REMOVED badge component; `provenanceFor` helper |
| `src/__tests__/AnalystContributions.test.jsx` | **new** | 17 component tests (badges, provenance, render) |
| `src/TargetBoardView.jsx` | edit | Inline contributions panel replaced by `<AnalystContributions target={target} />` |
| `src/App.jsx` | edit | APP_VERSION 0.18.0-alpha → 0.18.1-alpha |
| `ORCHESTRATOR.md` | edit | 4f row → `done`; new 4f-finish row → `done (PR open)` |

## W2 audit § 2 highlights

Full table in `reports/phase-4f/audit.md`. Per-stub root-cause
classifications (sorted by weight):

| Analyst (Target × russell2k) | Weight | Verdict | Root cause | Action |
|------------------------------|-------:|---------|------------|--------|
| insider                      |   14%  | Stub    | `null_default` | None — fixed at wrapper in PR #27 |
| flow                         |   10%  | Degraded | `threshold_misconfig` | Deferred to Phase 4g (needs W6) |
| news-sentiment               |   10%  | Degraded | `null_default` | **Fixed in this PR** — `runNewsSentiment` empties → `_noData` |
| political                    |   10%  | Stub    | `null_default` | None — fixed at wrapper in PR #27 |
| earnings                     |    7%  | Stub    | `threshold_misconfig` | **Fixed in this PR** — no upcoming + no history → `_noData` |
| macro-regime                 |    7%  | Stub    | `no_upstream`     | **Weight=0** (macroBias never wired) |
| patent                       |    6%  | Stub    | `no_upstream` (russell2k) | **Weight=0** (conservative) |
| technical                    |   15%  | Degraded | `threshold_misconfig` | Deferred to Phase 4g (needs W6) |

| Analyst (Prophet)            | Weight | Verdict | Root cause | Action |
|------------------------------|-------:|---------|------------|--------|
| catalyst (largecap)          |   30%  | Degraded | not a defect — 93% pctFailing reflects the selective catalyst gate by design | None |
| volatility (russell2k)       |    6%  | Degraded | `threshold_misconfig` (russell2k vol regime triggers offsetting modifiers) | Deferred to Phase 4g |

## W6 (backtest comparison) — SKIPPED

Phase 4e-1-finish's background-function dispatch bug is unresolved
at the time of this PR. The pre/post backtest comparison requires
the same `scripts/run-portfolio-backtest.ts` infra that 4e-1-finish
is unable to dispatch runs through. Skipping W6 is explicitly
authorized by the kickoff (§ W6: *"W6 is a sanity check, not a
gate — shipping without it is acceptable"*).

W3/W5 changes in this PR are correct by construction — the
`_noData` flags are honest about missing data conditions; the
weight=0 removals reflect documented no_upstream cases — and don't
need an IC delta to validate.

W6 moves to a follow-up PR once 4e-1-finish's dispatch bug lands.

## Options-unusual wiring — partial state

`computeOptionsFlowSignal` is now invoked per largecap ticker on
each scheduled scan via a new minimum-viable fetcher
(`polygon-options-snapshot.ts`) that consumes Polygon's
`/v3/snapshot/options/{ticker}` endpoint.

- **OI-spike component** lands live. Previous-day OI is sourced
  from yesterday's cached signal in the same Firestore
  subcollection (`institutionalFlow/largecap/{ticker}/{prev}.optionsFlow._oiToday`).
  On first-day-after-deploy the prior is absent and oiSpikeStrikes
  is 0; subsequent days have data and the comparison works.
- **Sweep/Block components** remain at 0 until a per-contract tick
  fetcher follows. Polygon's snapshot endpoint exposes a single
  `last_trade` per contract, not a stream; sweep detection (≥3
  exchanges within 100ms) is not derivable from this surface.
  Block detection on the per-contract last-trade is technically
  possible but produces almost no signal at the single-print
  level. Deferred to Phase 4g.
- The `unusualScore` composite is OI- and direction-dominated until
  the tick fetcher lands.

## Versions

- `APP_VERSION` `0.18.0-alpha` → `0.18.1-alpha`
- `MODEL_VERSION` **unchanged** at `2026.03.0` — composite math
  itself didn't change in this PR; only which analysts contribute
  (via weight=0 removals + `_noData` honesty). Historical snapshots
  remain comparable.

## Tests + verification

- 583 → **618 passing** (+35; target was +20-40)
- `npx tsc --noEmit`: clean
- `npm run build`: clean
- No live-data smoke (deploy preview Netlify cron doesn't fire)

## Re-audit plan

Schedule a follow-up audit run via the Sunday cron one month
post-deploy (~2026-06-15). Expectations documented in audit § 5.
