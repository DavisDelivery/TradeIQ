# Phase 4p — verification report

**Branch:** `phase-4p-scan-terminal-fix`
**APP_VERSION:** `0.18.9-alpha` (bumped from `0.18.8-alpha` on `main`)
**MODEL_VERSION:** unchanged
**Live acceptance:** deferred to orchestrator post-merge (executor sandbox
has no outbound access to the production deploy). The orchestrator fires
both russell2k scans and confirms `status: done` + a fresh published
snapshot via `/api/scan-status` and the board endpoints.

---

## Static verification (executor-local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean (vite 5.4.21, ~2s) |
| `npm test` baseline (`main`) | 880 passing across 94 files |
| `npm test` after 4p | **910 passing across 96 files (+30 tests, +2 files)** |

### New test files

| File | Tests | Covers |
|---|---|---|
| `netlify/functions/shared/scan-resume/__tests__/finalize.test.ts` | 13 | W1 transition helper is pure and preserves cursor fields; `dispatchFinalizingReinvoke` persists the finalizing cursor BEFORE dispatching the reinvoke, stamps `lastReinvokeError` on dispatch failure; W3 `recoverStuckRuns` ignores fresh runs / non-running statuses, marks stale `running` runs as `error` with cursor cleared, records `phase` of recovered runs (distinguishes scanning vs finalizing zombies), honors a custom threshold; `STALE_RUN_THRESHOLD_MS` exceeds Netlify's 15-min ceiling |
| `netlify/functions/shared/__tests__/trim-results-doc-limit.test.ts` | 6 | W2 size-safety: small payloads pass through (same array reference, no copy); empty input is a clean no-op; large payloads truncate to top-N by producer order and report `truncated: true`; pathological-row case keeps zero; `SNAPSHOT_DOC_SAFE_BYTES` is honored as the default ceiling; the russell2k worst-case (2,037 fat rows) trims rather than throwing |

### Modified test files

| File | Reason |
|---|---|
| `netlify/functions/shared/scan-resume/__tests__/cursor.test.ts` | +4 tests for `getCursorPhase` — back-compat default for pre-4p cursors with no `phase` field, explicit scanning/finalizing values, round-trip through write+read |
| `netlify/functions/__tests__/scan-target-board-russell2k-background.checkpoint.test.ts` | Updated 2 existing tests for the new walk → finalizing → terminal flow (an extra invocation now lands between "walk done" and the snapshot write). Added 2 new tests: W1 finalizing-cursor-on-entry skips the batch loop entirely; W2 a re-fired finalizing invocation redoes assemble+write cleanly (idempotency contract) |
| `netlify/functions/__tests__/scan-insider-russell2k-background.checkpoint.test.ts` | Same shape as the target-board sibling — updated 3 existing tests for the new control flow, added the 2 W1/W2 tests |
| `netlify/functions/__tests__/scan-insider-russell2k-background.degraded-guard.test.ts` | Added a `driveScanToTerminal` helper that chains the walk + finalizing invocations; the 4 existing degraded-guard tests now use it so the publish-guard decision still gets exercised at the terminal step |
| `netlify/functions/__tests__/scan-status.test.ts` | +4 tests for W3 `scan` shorthand param — `scan=insider-russell2k` routes correctly, `scan=target-board-sp500` parses the multi-hyphen board name, malformed `scan` is rejected 400, empty `scan` falls back to `board` + `universe` |

---

## Workstream summary

### W1 — Dedicated invocation for the terminal step

The terminal step (read partials → assemble → guard decision → writeSnapshot
→ clearScanCursor) used to be crammed into the tail of the last
batch-processing invocation. Phase 4o's `/api/scan-status` diagnostic
proved that's where the russell2k scans were dying: the cursor reached
`nextTickerIndex: 2037 / 2037` but the run froze `status: running`
forever because the terminal step ran out of the invocation's 15-min
platform budget mid-write. 4p gives the terminal step its own dedicated
invocation with a fresh 15-min budget.

**Cursor change** — `netlify/functions/shared/scan-resume/cursor.ts`
- New `ScanPhase = 'scanning' | 'finalizing'` type.
- New optional `phase?: ScanPhase` field on `ScanCursor`. Optional so
  pre-4p cursors in flight read back cleanly; `getCursorPhase(cursor)`
  defaults `undefined` → `'scanning'`.

**Shared helper** — `netlify/functions/shared/scan-resume/finalize.ts` (new)
- `transitionCursorToFinalizing(cursor)` — pure: stamps
  `phase: 'finalizing'`, `lastReinvokeAt`, and bumps `reinvokeAttempts`.
- `dispatchFinalizingReinvoke({ db, runId, cursor, reinvokeUrl, ctx })`
  — persists the finalizing cursor BEFORE dispatching the reinvoke
  (the next entry must see `phase: finalizing`), wraps
  `dispatchReinvoke`, stamps `lastReinvokeError` if the dispatch fails.

**Worker control flow** — both russell2k workers now follow:
```
worker entry:
  read cursor; bump invocationCount
  if cursor.phase === 'finalizing':
      runTerminalStep(...)  ← fresh 15-min budget, no batch work
      return 200
  else:
      batch loop while nextTickerIndex < totalTickers && !watchdog.expired
      if nextTickerIndex >= totalTickers:
          dispatchFinalizingReinvoke(...)
          return 202 (phase: 'finalizing')
      else (watchdog tripped mid-walk):
          existing mid-walk dispatchReinvoke
          return 202
```

The terminal step is extracted into a local `runTerminalStep(args)`
function in each worker so the finalizing entry can invoke it directly
without re-running the batch loop. Per the brief: the per-board
terminal logic differs (different row types, different sort, different
warnings/api accounting), so the shared layer covers the cursor phase
+ the dispatch helper, while the terminal body stays per-worker.

**Files touched for W1:**
- `netlify/functions/shared/scan-resume/cursor.ts`
- `netlify/functions/shared/scan-resume/finalize.ts` (new)
- `netlify/functions/scan-target-board-russell2k-background.ts`
- `netlify/functions/scan-insider-russell2k-background.ts`

### W2 — Idempotent + size-safe terminal step

**Idempotency** — by construction. The terminal step is purely:
`readAllPartialBatches` (deterministic on the same partial subcollection)
→ sort → `assessSnapshotPublish` (pure) → `writeSnapshot` (overwrites the
same `snapshotId` if re-run within the same UTC minute, otherwise produces
a fresh snapshot id; either case is acceptable) → `clearScanCursor('done')`
(only at the very end). A killed-and-retried finalizing invocation
simply redoes assemble+write; the cursor remains `running, phase: finalizing`
until the final clear lands. New test `terminal step is idempotent — a
re-fired finalizing invocation redoes the work without error` covers
this contract on both workers.

**Size safety** — Firestore caps a single document at 1 MiB. A
russell2k target-board scan scores ~2,022 Target rows, each carrying a
fat `analystContributions` array — a real risk of throwing on write
even with W1's fresh budget. Added a pure helper in
`netlify/functions/shared/snapshot-store.ts`:

- `SNAPSHOT_DOC_SAFE_BYTES` (default 800,000; env-overridable via
  `SCAN_MAX_SNAPSHOT_DOC_BYTES`).
- `trimResultsForDocLimit<T>(results, maxBytes?)` — estimates the
  serialized array size; below the ceiling, passes through (same
  reference). Above, keeps leading rows in producer order until the
  next row would push over.
- New optional `truncated?: boolean` and `originalResultCount?: number`
  fields on `BoardSnapshot` so consumers (HistoryView, the backtest
  reader, the live board APIs) can detect a capped snapshot. The
  worker also appends a `snapshot results truncated for doc-size
  safety: N/M rows kept (~X bytes)` string to the snapshot's
  `warnings` array.

Both workers call `trimResultsForDocLimit(allRows)` after the publish
guard's decision; the original row count is fed to `assessSnapshotPublish`
so the guard sees the real scan health rather than a post-trim shadow.

The "snapshots store the FULL raw result list — never trim" invariant
documented at the top of `snapshot-store.ts` is updated to reflect the
4p W2 exception: trim fires only above the 1 MiB safety boundary, is
recorded with `truncated: true`, and is the only thing standing between
an oversized doc and a permanently-frozen run.

**Files touched for W2:**
- `netlify/functions/shared/snapshot-store.ts`
- `netlify/functions/scan-target-board-russell2k-background.ts`
- `netlify/functions/scan-insider-russell2k-background.ts`

### W3 — Stuck-run recovery + `/api/scan-status` `scan` param fix

**Stuck-run recovery** — `recoverStuckRuns({ db, runIdPrefix,
staleThresholdMs?, now?, scanLimit? })` in `scan-resume/finalize.ts`.
- Walks `scanRuns` filtered by `runIdPrefix` (e.g.
  `'target-board-russell2k-'`).
- Skips runs that are not `status: 'running'` (already complete or
  already errored).
- Skips runs whose `updatedAt` is within `STALE_RUN_THRESHOLD_MS`
  (default 30 min — comfortably past Netlify's 15-min ceiling).
- For each stale `running` run: calls `clearScanCursor(db, runId,
  'error')` so `/api/scan-status` reports the actual death rather than
  a forever-running zombie.
- Returns `{ inspected, recovered: StuckRunRecord[] }` — each record
  carries `runId`, `updatedAt`, `phase` (so post-mortem distinguishes
  a `scanning` zombie from a `finalizing` zombie), and a `reason`
  string. Best-effort: a Firestore hiccup must not block the new
  scheduled scan.

Both scheduled triggers (`scan-target-board-russell2k.ts` and
`scan-insider-russell2k.ts`) call `recoverStuckRuns` immediately
before dispatching the fresh worker. Any failure in the recovery sweep
is logged and swallowed so the new scan still starts.

This will clean up the two zombie russell2k runs Chad has frozen since
2026-05-17 / 2026-05-18 on the next scheduled fire, and going forward
it's belt-and-suspenders insurance — the W1 dedicated-terminal fix
should mean nothing reaches the stuck state to begin with.

**`/api/scan-status` `scan` param** — `netlify/functions/scan-status.ts`
now accepts `?scan=<board>-<universe>` in addition to the existing
`?board=...&universe=...`. Parsing is done by trying each known board
prefix (the literal `target-board-` vs `insider-`) so the multi-hyphen
`target-board` name parses cleanly. Empty or malformed `scan` falls
through to the existing param shape; `board=` + `universe=` continue
to work unchanged.

Before this fix the endpoint silently dropped any `scan` query and
returned target-board russell2k for every request — which is how the
insider scan's freeze went un-diagnosed in Phase 4o. With this fix
`/api/scan-status?scan=insider-russell2k` returns the insider scan's
runs, satisfying acceptance criterion 4.

**Files touched for W3:**
- `netlify/functions/shared/scan-resume/finalize.ts` (recoverStuckRuns)
- `netlify/functions/scan-target-board-russell2k.ts` (trigger calls recoverStuckRuns)
- `netlify/functions/scan-insider-russell2k.ts` (trigger calls recoverStuckRuns)
- `netlify/functions/scan-status.ts` (parseScanParam)

---

## Files NOT touched (out of scope per kickoff)

- `shared/backtest-resume/{watchdog,reinvoke}.ts` — they work; called
  unchanged.
- `assessSnapshotPublish` logic / thresholds (Phase 4o W3, correct).
- The Finnhub throttle / rate limiter (Phase 4o W1).
- Analyst scoring, the `index=all` aggregation, the single-pass
  sp500/ndx/dow scans, any UI other than the APP_VERSION bump.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`.

---

## Acceptance — deferred to orchestrator post-merge

Per the kickoff: live verification is post-merge by the orchestrator.
They will fire both russell2k scans and confirm `status: done` +
published snapshots via `/api/scan-status` and the board endpoints.
Acceptance criteria:

1. russell2k **target-board** scan completes — `status: done`, fresh
   snapshot published, `companyName`/`sector` populated on picks.
2. russell2k **insider** scan completes — `status: done`, non-empty
   snapshot published. (This also confirms Phase 4o's W1 Finnhub
   throttle works — that payoff was previously masked by the terminal-
   step failure.)
3. A run reaching universe-end always either completes terminally or
   is recoverable — no run left permanently `status: running`.
4. `/api/scan-status?scan=insider-russell2k` returns the insider scan's
   runs.

---

## Known limitations

- The size-safety trim in W2 is a defensive last-resort. It fires only
  when the assembled doc would exceed 800 KB (`SNAPSHOT_DOC_SAFE_BYTES`).
  Backtest/calibration consumers that need the un-truncated set should
  check `snapshot.truncated`/`originalResultCount` and treat a truncated
  snapshot accordingly. The board display top-N (50) is far below any
  realistic truncation point, so the served UI is unaffected.
- `recoverStuckRuns` marks zombies as `error` rather than re-dispatching
  the terminal step. The brief allows either; we chose the simpler one
  because the next scheduled scan re-covers the same universe with
  cleaner state. If a faster live-recovery is wanted later, the W2
  idempotency contract makes a re-dispatch safe to bolt on.
