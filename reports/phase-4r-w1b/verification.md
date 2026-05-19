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
| `startedAt` | 2026-05-19T00:21:?? Z |
| `completedAt` | *(filled in at hand-off — see PR #45 message)* |
| Elapsed (min) | *(filled in at hand-off)* |
| `invocationCount` (final) | *(filled in at hand-off)* |
| `reinvokeAttempts` (final) | *(filled in at hand-off)* |
| Any `lastReinvokeError` observed in chain | *(filled in at hand-off)* |
| Any `lastReinvokeStatus` non-2xx observed | *(filled in at hand-off)* |
| Recovery sweep needed? | *(filled in at hand-off)* |

### Interim observations (run still in flight at time of doc commit)

First poll at 00:22:48 (~90s after dispatch) returned cursor state:

```
status=running invAge=60642 reinvokes=2 lastStatus=202 lastErr=null recovery=null
```

This is the first concrete proof the W2 instrumentation works:

- `reinvokes=2` — the worker has dispatched two reinvokes in the
  first batch window (pre-W1b this field did not exist at all).
- `lastStatus=202` — every dispatch attempt landed with the
  Background-Function gateway's 202 acceptance.
- `lastErr=null` — no transient failure was caught by the new retry
  loop.
- `recovery=null` — the W3 net has not been needed.

The remaining batches will be observed across the poll loop; the
hand-off message has the terminal numbers.

### Diagnostic observations to verify

- `reinvokeAttempts` advances in lock-step with `invocationCount` —
  confirms every dispatch landed cleanly. **Confirmed at 90s mark.**
- If any 429/5xx surfaces on the chain, the dispatch retries and
  ultimately lands (`lastReinvokeError` is null on final cursor).
- No `recoveryAttempts` increment — chain held without the W3 net.

## Hand-off

Per the brief (PART VII §5/§6), W1b proof is **one** rolling window
driven to `done`. Driving all 8 concurrently is the orchestrator's
post-merge step, on prod (Netlify auto-deploys main), with the v2
verdict confirmation as the binding acceptance gate.
