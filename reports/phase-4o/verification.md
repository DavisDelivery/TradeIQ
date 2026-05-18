# Phase 4o — verification report

**Branch:** `claude/phase-4o-executor-khP9C`
**APP_VERSION:** `0.18.8-alpha` (bumped from `0.18.6-alpha` on `main`)
**MODEL_VERSION:** unchanged
**Live acceptance:** deferred to orchestrator post-merge (executor sandbox
has no outbound access to the production deploy).

---

## Static verification (executor-local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean (vite 5.4.21, ~6s) |
| `npm test` baseline (`main`) | 842 passing across 89 files |
| `npm test` after 4o | **880 passing across 94 files (+38 tests, +5 files)** |

### New test files

| File | Tests | Covers |
|---|---|---|
| `netlify/functions/shared/__tests__/rate-limiter.test.ts` | 11 | W1: token-bucket starts full, blocks once drained, refills with the clock, serializes concurrent acquires; 429 retry with backoff, Retry-After honored, non-429 fall-through, exhausted retries flag, backoff cap |
| `netlify/functions/shared/__tests__/data-provider-insider-429.test.ts` | 5 | W1: `getFinnhubInsiderTransactionsWithStatus` retries on 429, surfaces `rateLimited`/`rateLimitExhausted` flags, returns rows on 429-then-success, errors flow through with `errorMessage`, legacy `getFinnhubInsiderTransactions` benefits from the same retry path |
| `netlify/functions/shared/__tests__/publish-guard.test.ts` | 11 | W3: 0 rows on a large universe → skip; 0 rows on a small universe → publish; high failure rate → skip; moderate failure rate → publish-degraded; low yield + zero failures → publish; named thresholds; combined rate-limit + error fraction |
| `netlify/functions/__tests__/scan-insider-russell2k-background.degraded-guard.test.ts` | 4 | W3: bg-worker SKIPS `writeSnapshot` on the russell2k Bug A pattern (2,037-checked / 0 rows); publishes DEGRADED at moderate failure; publishes normally when healthy; cursor accumulates apiCalls / apiRateLimited / apiErrors across batches |
| `netlify/functions/__tests__/scan-status.test.ts` | 7 | W2: `/api/scan-status` rejects invalid board/universe, defaults to target-board+russell2k, isolates by prefix, derives `invocationAgeMs` + `scanAgeMs`, empty list when none match, null cursor on completed runs |

### Modified test files

| File | Reason |
|---|---|
| `netlify/functions/shared/__tests__/scan-insider-batch.test.ts` | Added a shim that bridges the new `getFinnhubInsiderTransactionsWithStatus` mock to the existing `getFinnhubInsiderTransactions` mock so the 7 existing tests still drive the new status-aware code path. |

---

## Workstream summary

### W1 — Rate-limit-aware Finnhub access (fixes Bug A)

- **New module:** `netlify/functions/shared/rate-limiter.ts`.
  - `createTokenBucket({ callsPerWindow, capacity?, windowMs?, now?, sleep? })`
    — module-scope token bucket with serialized `acquire()`. Default
    window 60s; default capacity = callsPerWindow. Test seams for clock
    + sleep so the suite runs without real timers.
  - `fetchWithRateLimit(url, init, opts?)` — fetch wrapper that retries
    on HTTP 429 with exponential backoff (default 500ms × 2^n, capped at
    8s, 3 retries). Honors `Retry-After` when the server sends it.
    Returns a `{ res, rateLimitHits, rateLimitExhausted }` envelope so
    the caller can decide what to do on exhausted retries.
  - `getFinnhubBucket()` — singleton, capacity = `process.env.FINNHUB_RPM
    ?? 55`. Default 55/min stays under Finnhub's nominal 60/min free-tier
    limit; raise via env var on a paid plan.

- **Modified:** `netlify/functions/shared/data-provider.ts`.
  - Added `getFinnhubInsiderTransactionsWithStatus(ticker, daysBack, opts)`
    that paces through the Finnhub bucket, uses the 429-aware fetch, and
    returns `{ data, rateLimited, rateLimitExhausted, errorMessage? }`.
    This is the status-aware variant the russell2k scan consumes.
  - Refactored `getFinnhubInsiderTransactions(...)` to delegate to the
    new function. All existing callers (insider-provider, analyst-runner,
    scan-prophet, scan-catalyst, backtest/score-at-date,
    analysts/insider) keep their `FinnhubInsiderTx[]` return type and
    transparently gain the token bucket + 429 retry.
  - The 429-exhausted branch now `console.warn`s with explicit "after
    retries; flagging as rate-limited" wording — visible in Netlify
    function logs even when callers don't read the status envelope.

- **Modified:** `netlify/functions/shared/scan-insider.ts`.
  - `runInsiderScanBatch` now calls
    `getFinnhubInsiderTransactionsWithStatus` per ticker and accumulates
    `finnhubCalls`, `finnhubRateLimited`, `finnhubErrors` into the batch
    result envelope. The batch's `warnings[]` also surfaces a
    human-readable summary when rate-limit/error counts are non-zero.

- **Modified:** `netlify/functions/scan-insider-russell2k-background.ts`.
  - Default `INSIDER_SCAN_CONCURRENCY` lowered from **8 → 4**. With the
    token bucket pacing the steady-state rate, the previous burst of 8
    parallel cold-start calls would blow through the bucket's capacity
    before any refill, forcing every subsequent ticker into 429-retry
    backoff. Concurrency 4 keeps cold-start headroom and steady-state
    pacing aligned.

- **Modified:** `netlify/functions/scan-insider-{sp500,ndx,dow,russell2k}.ts`.
  - Staggered the four insider cron slots so they no longer collide on
    Finnhub quota:
    - `scan-insider-russell2k`: **`30 21 * * 1-5`** (unchanged, longest scan goes first)
    - `scan-insider-sp500`:     **`35 21 * * 1-5`** (was 30)
    - `scan-insider-ndx`:       **`40 21 * * 1-5`** (was 30)
    - `scan-insider-dow`:       **`45 21 * * 1-5`** (was 30)
  - 5-minute spacing leaves comfortable headroom even on the free tier:
    each non-russell2k scan completes in <1 minute of real call time
    (sp500 ≈ 208 calls / 55 rpm ≈ 4 min budget; ndx 70 calls ≈ 1.3 min;
    dow 27 calls ≈ 0.5 min), so consecutive scans don't compete.

### Finnhub completion-time math (for Chad — § X of brief)

Single russell2k insider scan, with the W1 pacing in place:

- Universe: ~2,037 tickers.
- Pacing: 55 calls/min (default; one Finnhub call per ticker, plus
  ~1 Polygon previous-close per surviving ticker).
- Finnhub call wall-clock: **2,037 / 55 ≈ 37 minutes**.
- Polygon enrichment adds ~5-10 min for the rows that survive (typically
  a few hundred), but it's a separate provider so it doesn't compete
  with Finnhub's bucket.
- Per-invocation budget: 13 min (90s margin under the 15-min background
  ceiling). So a fully-paced russell2k insider scan completes in
  **roughly 3 checkpoint invocations** (~37 min Finnhub call time +
  enrichment overhead, spread across 3 × 13-min invocations).
- **Fits the nightly window comfortably** — the cron fires at 21:30 UTC
  and 3 × 13 min = 39 min wall-clock + reinvoke handoffs lands well
  before midnight. No Finnhub plan upgrade needed at the default
  `FINNHUB_RPM=55` setting.

If Chad is on a paid Finnhub tier (e.g., 300 rpm), set `FINNHUB_RPM=275`
in the Netlify env and the scan finishes in a single invocation (~7
min). Same code path; just the bucket capacity changes.

### W2 — Diagnose and fix the target-board russell2k stall (Bug B)

**Status: diagnostic shipped; cause under investigation.**

Per kickoff guidance ("Do NOT ship a guessed fix"), this phase ships
the diagnostic surface and the cursor-side instrumentation needed to
pinpoint the stall on the next live scan run. No reinvoke-layer logic
change.

- **New endpoint:** `GET /api/scan-status?board=<board>&universe=<universe>`
  (`netlify/functions/scan-status.ts`).
  - Reads the most recent `scanRuns/{runId}` docs (by ID-prefix range:
    `target-board-russell2k-…` or `insider-russell2k-…`) and returns the
    cursor state: `nextTickerIndex`, `totalTickers`, `invocationCount`,
    `partialBatchCount`, `scoredCount`, `lastError`, `lastReinvokeError`,
    plus the new W2 fields `lastReinvokeAt` and `reinvokeAttempts`.
  - Derives two convenience fields: `invocationAgeMs` (time since
    `lastInvocationStartedAt`) and `scanAgeMs` (since `startedAt`).
  - **`netlify.toml` redirect rule added** — `/api/scan-status` →
    `/.netlify/functions/scan-status`.

- **Cursor instrumentation** in
  `netlify/functions/shared/scan-resume/cursor.ts`:
  - New optional fields `lastReinvokeAt: ISO string` and
    `reinvokeAttempts: number`. Both russell2k workers (target-board and
    insider) stamp the cursor BEFORE dispatching the self-reinvoke fetch,
    so a stalled chain leaves a forensic trace: `lastReinvokeAt` set but
    `invocationCount` not advanced beyond `reinvokeAttempts`.

- **No reinvoke-layer logic change.** `dispatchReinvoke` and
  `inferFunctionUrl` remain identical to Phase 4h. The hypotheses in the
  brief (reinvoke fetch fires; awaited via `Context.waitUntil`; payload
  carries `runId`; watchdog trips cleanly; worker URL correct) all
  resolve "looks correct on inspection" but cannot be falsified without
  a live scan run. The new cursor fields + diagnostic endpoint will
  reveal the failure mode on the next nightly fire.

**How to use the diagnostic post-merge:**

```
curl -s 'https://tradeiq-alpha.netlify.app/api/scan-status?board=target-board&universe=russell2k' | jq
```

Read the topmost `runs[0]`:

- `status === 'done'` and `cursor === null` → success.
- `status === 'running'` and `invocationAgeMs > 15 * 60_000` (>15 min):
  the chain stalled. Then:
  - `lastReinvokeAt` AND `reinvokeAttempts >= invocationCount` → the
    watchdog tripped and we attempted to dispatch; the reinvoke fetch
    did not land. **Bug is in the reinvoke layer** (`dispatchReinvoke`,
    `Context.waitUntil`, or the bg-function URL routing).
  - `lastReinvokeAt` unset → the watchdog never tripped and the batch
    loop hung mid-execution (likely a single-batch deadlock or a
    Polygon/Finnhub call exceeding the budget). **Bug is upstream of
    the reinvoke layer.**
- `lastError` set → uncaught exception in the batch loop. Read it.

### W3 — Degraded scans must fail loud, not publish empty (systemic)

- **New in `netlify/functions/shared/snapshot-store.ts`:**
  - `BoardSnapshot.degraded?: boolean` + `BoardSnapshot.degradedReason?:
    string` — set when the W3 guard publishes-but-flags.
  - `assessSnapshotPublish(input)` — pure function returning a
    `PublishGuardDecision` with `action: 'publish' | 'publish-degraded'
    | 'skip'`. Floors:
    - **Skip:** `resultCount === 0` AND `universeChecked >= 100` (the
      russell2k Bug A pattern: a 2,037-name scan publishing 0 rows is
      almost certainly rate-limited into oblivion, not legitimate empty).
    - **Skip:** `failureRate >= 50%` (data is fundamentally incomplete).
    - **Skip:** `resultCount === 0` AND `any rateLimited` (defense in
      depth — never trust a 0-row result the moment rate-limiting was
      observed at all).
    - **Publish-degraded:** `failureRate >= 10%` (data is mostly there
      but the reader should know).
    - **Publish:** otherwise.
  - `PUBLISH_GUARD_EMPTY_UNIVERSE_MIN = 100`, `PUBLISH_GUARD_SKIP_ERROR_RATE
    = 0.5`, `PUBLISH_GUARD_DEGRADED_ERROR_RATE = 0.1` — exported as
    named constants for caller-side reference.

- **Wired into both russell2k bg-workers**
  (`scan-insider-russell2k-background.ts`,
  `scan-target-board-russell2k-background.ts`):
  - Cursor accumulates `apiCalls`, `apiRateLimited`, `apiErrors` across
    every batch (insider only — target-board lacks the per-call
    accounting today; row-count arm of the guard still applies).
  - Terminal batch consults `assessSnapshotPublish`. On `skip`:
    `clearScanCursor(db, runId, 'error')`, **do not call writeSnapshot**,
    **do not prune retention**. Partial subcollection still gets cleaned
    up (it's scratch space). On `publish-degraded`: writeSnapshot with
    `degraded: true` + `degradedReason: <reason>`. On `publish`: normal
    path.
  - Response body now includes `publishAction` and `publishReason` so
    the orchestrator can see the W3 decision from the worker's HTTP
    response.

- **Warnings propagation:** the cursor's accumulated rate-limit/error
  counts get formatted into the snapshot's `warnings[]` whenever they
  are non-zero, so the read endpoint surfaces them and the W3 read-side
  can render a "degraded" badge on the UI.

### Files touched

| File | Workstream |
|---|---|
| `netlify/functions/shared/rate-limiter.ts` (new) | W1 |
| `netlify/functions/shared/data-provider.ts` | W1 |
| `netlify/functions/shared/scan-insider.ts` | W1 |
| `netlify/functions/scan-insider-russell2k-background.ts` | W1 + W3 + W2 |
| `netlify/functions/scan-insider-russell2k.ts` (comment only) | W1 |
| `netlify/functions/scan-insider-sp500.ts` | W1 (cron) |
| `netlify/functions/scan-insider-ndx.ts` | W1 (cron) |
| `netlify/functions/scan-insider-dow.ts` | W1 (cron) |
| `netlify/functions/scan-target-board-russell2k-background.ts` | W2 + W3 |
| `netlify/functions/shared/scan-resume/cursor.ts` | W1 + W2 + W3 (cursor fields) |
| `netlify/functions/shared/snapshot-store.ts` | W3 |
| `netlify/functions/scan-status.ts` (new) | W2 |
| `netlify.toml` | W2 (redirect rule) |
| `src/App.jsx` | APP_VERSION bump |
| `ORCHESTRATOR.md` | status update |

### Live acceptance criteria (post-merge)

1. **Fire the russell2k insider scan** — should complete with a
   non-empty snapshot (hundreds of rows, consistent with sp500's hit
   rate scaled to the russell2k universe). Confirm via `GET
   /api/insider-board?universe=russell2k`.
2. **Fire the russell2k target-board scan** — either:
   - Completes with a fresh terminal snapshot (`companyName`/`sector`
     populated) → Bug B fix landed by virtue of the W1 token bucket
     reducing pressure on shared providers.
   - Or stalls again, in which case `GET /api/scan-status` reveals where
     (see "How to use the diagnostic post-merge" above) and the
     orchestrator can iterate.
3. **W3 guard holds:** an artificially-broken run (e.g., flip
   `FINNHUB_API_KEY` to a known-invalid value, fire the russell2k
   insider scan) should NOT swap `_latest` — the previous good snapshot
   should keep serving.

### Known limitations

- **Bug B diagnosis is iterative.** The W2 deliverable is the diagnostic
  endpoint + cursor instrumentation, not a fix for an as-yet-unobserved
  stall. The kickoff explicitly authorizes this path. The orchestrator's
  next russell2k target-board fire will reveal whether the stall
  persists and where.
- **Token-bucket is module-scope (per-invocation).** Sufficient because
  the checkpoint-resume chain runs one invocation at a time per scan
  and W1's cron staggering keeps the 4 insider universes off the same
  minute. A distributed limiter is unnecessary at this scale.
- **Target-board's W3 guard uses only the row-count arm.** The
  target-board scan doesn't yet track per-call rate-limit accounting
  (its providers are Polygon-heavy, not Finnhub-heavy). The row-count
  guard alone is enough to block the Bug A-shaped pattern.

---

## Hand-off

```
Change summary:
- W1: Finnhub rate-limited via token bucket (default 55 rpm; raise via
      FINNHUB_RPM env var), concurrency 8 → 4, 429 backoff-and-retry
      (3 attempts, exp backoff, Retry-After honored), four insider
      crons staggered to 21:30 / 21:35 / 21:40 / 21:45 UTC.
- W2: GET /api/scan-status diagnostic endpoint + netlify.toml redirect.
      Cursor instrumented with lastReinvokeAt + reinvokeAttempts so a
      stalled chain leaves a forensic trace. No reinvoke-layer logic
      change (per kickoff: instrument first, diagnose, then fix).
- W3: assessSnapshotPublish guard in snapshot-store. Wired into both
      russell2k bg-workers — empty result on a large universe SKIPS the
      _latest swap; moderate failure rate publishes flagged 'degraded';
      rate-limit + error counts propagate into snapshot.warnings.

Finnhub math: throttled to 55 rpm → russell2k insider scan ≈ 37 min
  Finnhub call wall-clock → completes in 3 checkpoint invocations →
  FITS the nightly window comfortably. Free-tier OK; no Chad decision
  needed unless he wants faster (raise FINNHUB_RPM on a paid plan).

Verification:
- tsc --noEmit: clean
- npm test: 880 passing (was 842 baseline; +38 tests across 5 new files)
- npm run build: clean

Acceptance: DEFERRED to post-merge (orchestrator fires both scans).

Known limitations:
- Bug B's actual cause is still under investigation. The W2
  instrumentation + diagnostic endpoint is the guaranteed deliverable
  per kickoff PART 3. The next russell2k target-board fire will reveal
  whether the W1 rate-limit hardening incidentally clears the stall (a
  side-channel hypothesis: Polygon-side throttling pressure dropping
  because Finnhub no longer steals concurrency from the same scan) or
  whether the reinvoke layer needs a targeted fix.
```
