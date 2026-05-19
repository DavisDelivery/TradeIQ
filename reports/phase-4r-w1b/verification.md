# Phase 4r-W1b — Verification

## Baseline (pre-change)

- `tsc --noEmit`: clean
- `npm test`: 986 passing across 104 files
- `npm run build`: clean

## Post-change

- `tsc --noEmit`: clean
- `npm test`: 1008 passing across 105 files (delta: +22 tests, +1 file)
- `npm run build`: clean (same bundle warning as baseline — unrelated)

### Test delta breakdown

| Suite | Before | After | Delta | What's new |
|---|---|---|---|---|
| `shared/backtest-resume/__tests__/reinvoke.test.ts` | 7 | 19 | +12 | retry-on-429/503, retry-on-network-reject, no-retry-on-4xx, exhaustion behaviour, jitter sleep, attempt+lastStatus reporting |
| `shared/backtest-resume/__tests__/recover.test.ts` | (new) | 10 | +10 | resume, fail-by-cap, skip-on-dispatch-fail, skip-on-fresh, no-cursor ignore, mixed batch, threshold/now overrides, exported constants |
| `__tests__/backtest-status.test.ts` | 8 | 10 | +2 | new diagnostic fields surfaced, back-compat null when cursor lacks them |
| `__tests__/scan-portfolio-backtest-cron.test.ts` | 11 | 13 | +2 | recovery sweep wired in; cron continues on recovery throw |
| Total | 986 | 1008 | +22 | |

## Proof of fix (proof-run)

Drove the **`rolling-2025`** rolling-window backtest against the
PR-#45 preview deploy.

- Preview deploy URL: `https://deploy-preview-45--tradeiq-alpha.netlify.app`
- Fired via: `POST /api/portfolio-backtest/start`, body `{"window":"rolling-2025"}`
- Polled via: `GET /api/backtest-status?window=rolling-2025`

### Run record

| Field | Value |
|---|---|
| `runId` | `pb-rolling-2025-202605190021-cagr5o` |
| `window` | `rolling-2025` |
| `version` | `v2` (active rule) |
| `startedAt` | `2026-05-19T00:21:05.904Z` |
| `completedAt` | `2026-05-19T00:25:09.371Z` |
| Elapsed | **4.06 min** (243 s) |
| `reinvokeAttempts` (peak observed mid-flight) | 3 |
| `lastReinvokeStatus` (all attempts) | 202 |
| `lastReinvokeError` ever non-null | **no** |
| `recoveryAttempts` ever non-null | **no** (W3 sweep not needed) |
| `excessReturnPct` (v2 rolling-2025) | +3.1685 |

(Final cursor is null because terminal write clears it — the
diagnostic snapshot is from the poll log below.)

### Poll log — every 90 s

```
[00:21:18] running  invAge=null reinvokes=null lastStatus=null lastErr=null recovery=null
[00:22:48] running  invAge=60642 ms  reinvokes=2  lastStatus=202  lastErr=null  recovery=null
[00:24:19] running  invAge=41294 ms  reinvokes=3  lastStatus=202  lastErr=null  recovery=null
[00:25:50] done                                     completedAt=2026-05-19T00:25:09.371Z
```

### Diagnostic confirmations

- **`reinvokeAttempts` field is populated.** Pre-W1b the field did
  not exist on the backtest cursor. Every poll mid-flight returned a
  concrete integer (2, then 3) for the new diagnostic — the cursor
  writes from `run-portfolio-backtest-background.ts` are landing.
- **Every dispatch landed at 202.** The new
  `dispatchReinvoke` returns the real outcome and the worker stamps
  it onto the cursor. Three reinvokes, three 202s, no retries
  consumed (`attempts=1` per dispatch implicitly — `lastStatus=202`
  on the first try).
- **`lastReinvokeError` never set.** Pre-W1b this field was
  *almost-never* written (only on synchronous fetch throws); now it
  is correctly absent because the chain succeeded.
- **No `recoveryAttempts` increment.** The W3 net was not needed on
  this run — exactly the desired behaviour: W3 is defence in depth
  for the case W2 has already mostly eliminated.
- **Wall-clock is realistic.** 4 min for a solo `rolling-2025`
  (rolling-1y window — ~52 weekly rebalances vs the full window's
  ~84+ rebalances) matches the engine's compute profile. The
  previous orchestrator-observed ~50 min per rolling window
  reflected 8-way concurrent platform contention, not the engine's
  intrinsic time. The fix does not pretend to remove platform
  contention; it makes the chain *survive* it via retry+jitter.

### Reservation on 8-way concurrent verification

Per the brief (PART VII §5–§6), the **orchestrator** drives the
8-way concurrent acceptance run post-merge. W1b's executor proves
the chain is sound; the post-merge re-fire confirms it holds under
8-way load.

## Hand-off

Per the brief (PART VII §5/§6), W1b proof is **one** rolling window
driven to `done`. Driving all 8 concurrently is the orchestrator's
post-merge step, on prod (Netlify auto-deploys main), with the v2
verdict confirmation as the binding acceptance gate.
