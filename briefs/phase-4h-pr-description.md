# Phase 4h — Russell scan reliability + nightly schedule + company info

**APP_VERSION:** `0.18.4-alpha → 0.18.5-alpha`
**MODEL_VERSION:** unchanged (4h moves and surfaces data; no scoring math change)
**Companion docs:** `briefs/phase-4h-brief.md`, `kickoffs/phase-4h-executor.md`, `reports/phase-4h/verification.md`

---

## What this PR does

Fixes the three defects keeping TradeIQ's Russell 2000 board unusable:

1. **Scan never completes** → checkpoint-resume the russell2k + sp500
   target-board scans across Netlify's 15-minute background ceiling
   using the pattern Phase 4e-1-infra proved in production
   (`shared/backtest-resume/{cursor,watchdog,reinvoke}.ts`).
2. **Read endpoint hangs ~25 s** → for russell2k / sp500, the endpoint
   NEVER inline-scans on a stale/missing snapshot. It serves the last
   complete snapshot flagged `stale: true` (or `snapshot-missing` when
   none exists). `dow` / `ndx` / `core` keep the live fallback —
   they're small enough to be harmless inside the 26 s sync ceiling.
3. **No company name or sector on a pick** → every Target now carries
   `companyName` (from a Polygon-cached `tickerReference/{ticker}`
   collection with in-repo fallback) and `sector` (the same value the
   sector-rotation analyst already uses for its sector-ETF lookup, per
   Chad's "existing labels" decision). UI renders both on cards and
   detail.

## Scheduling

- One scheduled cron per large universe: `0 23 * * *` (23:00 UTC =
  7:00 pm EDT / 6:00 pm EST, both safely after the 4 pm ET close).
- Old `0,30 13-21 * * 1-5` daytime cron removed (the every-30-min that
  never produced a complete scan).
- Stopgap `scan-target-board-russell2k-nightly.ts` deleted.
- `FRESHNESS_BUDGETS_MS['target-board']` widened from 30 min → 26 h so
  the snapshot reads "fresh" all day until the next scheduled scan.

## Architecture

```
scan-target-board-russell2k.ts             (trigger; cron 0 23 * * *)
  └─ POST /.netlify/functions/scan-target-board-russell2k-background
       └─ readScanCursor → resume or fresh start
       └─ enrichTickerNames (cache-first; Polygon on miss; in-repo fallback)
       └─ loop runTargetScanBatch (50/batch) until watchdog (13 min) trips
       │   └─ appendPartialBatch → scanRuns/{runId}/partial/{batch-NNNNNN}
       │   └─ writeScanCursor (advance nextTickerIndex)
       └─ if more: dispatchReinvoke via Context.waitUntil
       └─ if done: readAllPartialBatches → sort → writeSnapshot (ONCE)
                    → clearScanCursor → deletePartialBatches
                    → pruneOldSnapshots (keep last 30)
```

The previous complete snapshot stays served at `_latest` for the entire
scan duration; the `_latest` pointer advances ONLY on the terminal
batch's successful `writeSnapshot`. A mid-chain failure leaves the
last good snapshot untouched.

Sp500 (`scan-target-board-sp500-background.ts`) is a twin of the
russell2k worker — same pattern, same batch size, same watchdog budget.

## Files

| Workstream | Files |
|---|---|
| W3 — enrichment | `shared/ticker-reference.ts` (new), `shared/types.ts`, `shared/analyst-runner.ts`, `shared/scan-target.ts` |
| W2 — de-hang | `shared/snapshot-store.ts`, `target-board.ts`, `src/components/FreshnessPill.jsx` |
| W1 — resume | `shared/scan-resume/cursor.ts` (new), `scan-target-board-russell2k-background.ts` (new), `scan-target-board-sp500-background.ts` (new), `scan-target-board-russell2k.ts`, `scan-target-board-sp500.ts`; **deleted** `scan-target-board-russell2k-nightly.ts` |
| W4 — UI | `src/TargetBoardView.jsx`, `src/components/FreshnessPill.jsx`, `src/App.jsx` (APP_VERSION) |
| Tests | 6 new test files, +52 tests (694 → 746) |
| Docs | `reports/phase-4h/verification.md`, `briefs/phase-4h-pr-description.md`, `ORCHESTRATOR.md` |

## Compute footprint (modeled)

| State | Russell2k scan compute | Complete scans/month |
|---|---|---|
| Pre-4h | ~105 fn-hr → ~1,050 credits | 0 |
| Post-4h | ~25 fn-hr → ~250 credits | ~30 |

Saves ~80 fn-hr / ~800 credits per month AND raises russell2k from
unusable to daily-fresh.

## Verification

- `npx tsc --noEmit` — clean
- `npm run build` — clean (vite 5.4.21, ~6 s)
- `npm test` — **746 passing** (baseline 694; +52 new)

Live acceptance is deferred per `reports/phase-4h/verification.md`
PART "Acceptance" — the orchestrator fires a manual scan post-merge
and confirms `invocationCount > 1`, sub-2-second read latency,
companyName + sector on every pick, and the cron registration.
