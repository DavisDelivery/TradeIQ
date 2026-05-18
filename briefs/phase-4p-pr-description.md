# Phase 4p — russell2k scan terminal-step fix

Both russell2k scans (target-board and insider) successfully walked all
2,037 tickers but the terminal `assemble + writeSnapshot` step never
completed — the run froze `status: running, nextTickerIndex: 2037`
forever and no snapshot was published. Phase 4o's `/api/scan-status`
diagnostic pinned the cause: the terminal step was crammed into the
tail of the last batch-processing invocation and timed out inside the
15-min platform budget. Full diagnosis: `briefs/phase-4p-brief.md`.
Verification: `reports/phase-4p/verification.md`.

This PR is one bundled change covering three workstreams; both
russell2k workers are fixed via a shared cursor + helper, so a single
bug → both boards healthy.

## Summary

- **W1** — dedicated terminal-step invocation. New `phase: 'scanning'
  | 'finalizing'` field on `ScanCursor`. When the batch loop sees
  `nextTickerIndex >= totalTickers`, it stamps `phase: 'finalizing'`
  and dispatches one more self-reinvoke (via shared
  `dispatchFinalizingReinvoke`). The next worker entry sees the
  finalizing cursor, skips the batch loop entirely, and runs only the
  terminal step (`readAllPartialBatches` → assemble → `assessSnapshotPublish`
  → `writeSnapshot` → `clearScanCursor('done')`) with a fresh full
  15-min budget. Applied to BOTH russell2k workers.
- **W2** — terminal step is idempotent + size-safe. Idempotency holds
  by construction (re-running on the same partials/runId overwrites
  cleanly; `clearScanCursor` only at the very end). New
  `trimResultsForDocLimit` in `snapshot-store.ts` plus optional
  `truncated`/`originalResultCount` fields on `BoardSnapshot` ensure
  the russell2k worst-case (~2,022 fat Target rows) never breaches
  Firestore's 1 MiB doc ceiling — if it would, the snapshot trims to
  top-N by producer order and flags itself.
- **W3** — stuck-run recovery + `/api/scan-status` `scan` param fix.
  New `recoverStuckRuns` helper (called by both scheduled triggers
  before they dispatch a fresh scan) clears the two zombie russell2k
  runs frozen since 2026-05-17/18 by marking them `error` with cursor
  cleared. `/api/scan-status` now honors `?scan=<board>-<universe>`
  (e.g. `?scan=insider-russell2k`) in addition to the existing
  `?board=...&universe=...` form — that param was silently dropped
  before, which is how the insider scan's freeze went un-diagnosed
  in 4o.

## Verification

- `npx tsc --noEmit` — clean
- `npm run build` — clean (vite, ~2s)
- `npm test` — **910 passing across 96 files** (was 880/94 on `main`,
  +30 new tests, +2 new test files)
- APP_VERSION bumped `0.18.8-alpha` → `0.18.9-alpha`. MODEL_VERSION
  unchanged.

## Acceptance — deferred to post-merge

Per the kickoff, live verification is the orchestrator's. After merge:
fire both russell2k scans and confirm `status: done` + a fresh
published snapshot via `/api/scan-status` and the board endpoints.

## Files touched

```
netlify/functions/scan-insider-russell2k-background.ts     W1+W2
netlify/functions/scan-insider-russell2k.ts                W3
netlify/functions/scan-status.ts                           W3
netlify/functions/scan-target-board-russell2k-background.ts W1+W2
netlify/functions/scan-target-board-russell2k.ts           W3
netlify/functions/shared/scan-resume/cursor.ts             W1
netlify/functions/shared/scan-resume/finalize.ts (new)     W1+W3
netlify/functions/shared/snapshot-store.ts                 W2
src/App.jsx                                                APP_VERSION bump
```

Tests:
```
netlify/functions/__tests__/scan-insider-russell2k-background.checkpoint.test.ts  updated + W1/W2 cases
netlify/functions/__tests__/scan-insider-russell2k-background.degraded-guard.test.ts  drive-to-terminal helper
netlify/functions/__tests__/scan-status.test.ts                                   +W3 scan param cases
netlify/functions/__tests__/scan-target-board-russell2k-background.checkpoint.test.ts  updated + W1/W2 cases
netlify/functions/shared/__tests__/trim-results-doc-limit.test.ts (new)           W2
netlify/functions/shared/scan-resume/__tests__/cursor.test.ts                     +getCursorPhase
netlify/functions/shared/scan-resume/__tests__/finalize.test.ts (new)             W1+W3
```

Reports:
```
briefs/phase-4p-pr-description.md (new)
reports/phase-4p/verification.md  (new)
```
