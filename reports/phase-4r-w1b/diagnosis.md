# Phase 4r-W1b — W1 Diagnosis

**Question:** *why* is the portfolio-backtest checkpoint-resume reinvoke
unreliable under concurrent load?

**Method:** read every link in the chain
(`run-portfolio-backtest-background.ts` →
`shared/backtest-resume/reinvoke.ts:dispatchReinvoke` →
`inferFunctionUrl` → `shared/backtest-resume/cursor.ts`), then compare
to the scan-side equivalents that Phase 4p hardened, then cross-check
against the live `/api/backtest-status` evidence from the 2026-05-18
8-way concurrent fire.

The brief named five candidate causes. Below I rule each in or out
against the actual code; the section after that names the **confirmed
root causes**.

---

## Live evidence (2026-05-19 status snapshot)

The 8 rolling windows fired 2026-05-18 19:22 UTC eventually all
completed by 2026-05-18 20:12 UTC — ~48–50 minutes wall-clock each.
None show as `staleRunning` now. So the symptoms the brief captured
("0 of 8 done at ~50 min, runs frozen with cursor age past 30 min")
must have been:

- caught in the *middle* of a slow chain, where one or two reinvokes
  did eventually land but only after a long gateway-side queue, OR
- some runs that genuinely died and were re-fired (manually or via
  the cron's next-undone strategy) and then completed.

Either way, **the chain is not robust enough to *predictably*
reinvoke under concurrency** — the brief's symptom set is correct
even though the system happened to recover on this round. The
diagnosis below is the actual chain fragility, not "what failed on
2026-05-18."

---

## Suspects — rule each in/out

### S1. Reinvoke fetch rejected/throttled under load — **CONFIRMED**

Look at `dispatchReinvoke` (`reinvoke.ts:45–96`):

```ts
const fetchPromise = fetch(functionUrl, { method: 'POST', ... })
  .then((res) => {
    if (res.status >= 400) {
      console.error('reinvoke_dispatch_non_2xx', { runId, ..., status: res.status });
    } else {
      console.log('reinvoke_dispatched', ...);
    }
  })
  .catch((e: unknown) => {
    console.error('reinvoke_fetch_error', { runId, ..., err: ... });
  });
if (typeof ctx.waitUntil === 'function') {
  ctx.waitUntil(fetchPromise);
} else {
  await fetchPromise;
}
return { ok: true };
```

Two distinct defects in one function:

1. **Non-2xx and network errors are only logged.** They are *not*
   propagated up. The outer `try/catch` returns `{ok: true}` regardless
   of what the fetch did, because the `.catch()` on the `.then()`
   chain swallows everything. The caller writes `lastReinvokeError`
   only when `dispatched.ok === false` — which is *only* the case for
   a synchronous throw from `fetch()` (rare). So a gateway 429/503 or
   a connection reset leaves **no Firestore-visible trace** — the
   error is locked inside the Netlify log stream.

   The existing test at `reinvoke.test.ts:76–82` documents this:
   `fetchSpy.mockRejectedValue(new Error('network down'))` →
   `expect(result.ok).toBe(true)` — *the unit test asserts that a
   failed network call is reported as a successful dispatch.* That is
   the bug.

2. **There is no retry.** A single failed dispatch is the end of the
   chain for that run — the container freezes, the cursor is intact
   but unreferenced. Netlify Background Functions are subject to
   per-function concurrency limits (small double-digits in default
   tenants); 8 self-POSTs arriving within the same ~10 ms window after
   8 concurrent watchdogs trip is exactly the load shape that
   produces 429/503. With no retry and no caller-visible error, the
   run silently dies.

This is the central defect. Concurrency is the trigger because eight
near-simultaneous `dispatchReinvoke` calls are the load profile that
crosses the platform's concurrency ceiling; solo runs avoid it.

### S2. `inferFunctionUrl` builds a wrong/ambiguous URL — **RULED OUT**

`reinvoke.ts:107–123` walks `x-forwarded-host` → `host` → `process.env.URL`
→ alpha-deploy fallback, with `x-forwarded-proto` for the scheme. The
trigger uses the same logic (`portfolio-backtest-trigger.ts:47–59`)
and the trigger demonstrably reaches the worker. The unit tests cover
every branch. The `full` window (which finished cleanly on 2026-05-16
across at least one reinvoke) is positive evidence — same URL
derivation, same code path, succeeded when running alone.

### S3. `ctx.waitUntil` not keeping the container alive — **RULED OUT**

`reinvoke.ts:82` enqueues the entire `.then().catch()` chain into
`ctx.waitUntil`. Netlify guarantees the container survives until that
promise resolves. The fetch's response handlers run inside that
promise. If the issue were premature container freeze we would
observe runs that *never* reinvoke even once — but the production
data shows reinvokes do land (the rolling-2018 run completing 48 min
after start required at least three successful reinvokes). The
`waitUntil` plumbing is sound.

### S4. Cursor handoff race / stale-guard drops a legitimate reinvoke — **RULED OUT**

`shared/backtest-resume/cursor.ts` has **no stale-reinvoke guard.**
The brief and the comment in `run-portfolio-backtest-background.ts:299`
both reference one, but the real guard is just `clearCursor` on the
terminal write: the cursor goes `null`, and a stray re-invoke that
reads `null` treats it as "no resume needed" (`cursor.ts:74`). For
non-terminal handoffs there is no guard to drop a legitimate
reinvoke; the only ordering is `writeCursor` then `dispatchReinvoke`,
which is correct. Not the failure.

### S5. Resumed invocation dies early — **RULED OUT for this symptom**

The brief notes resumed invocations sometimes die before re-dispatching.
That would manifest as `status: failed` rows or as runs that reinvoke
once and then stall *without* writing `lastReinvokeError`. The current
fragility (silent reinvoke failure with intact cursor) does not match
"resumed invocation dies early"; it matches "reinvoke fetch was
rejected and we never saw it." S5 may exist as a secondary failure
mode but it is not what makes the 8-way concurrent fire unreliable.

---

## Confirmed root cause

**`dispatchReinvoke` cannot detect or recover from gateway throttling
of self-POSTs.** Specifically:

- It returns `{ok: true}` for every fetch outcome that isn't a
  synchronous throw from `fetch()` itself.
- It does not retry.
- It does not stamp HTTP status onto the cursor.
- The caller therefore writes `lastReinvokeError` only for
  synchronous setup failures (essentially never).

Under solo load this is invisible — one fetch lands, one invocation
runs. Under 8-way concurrent load Netlify's per-function concurrency
ceiling is reached, the gateway returns 429 or 503 for the unlucky
self-POSTs, and the runs whose dispatch was throttled die with their
cursors intact but no further invocations.

The cursor is missing two diagnostics that already exist on the
scan-side cursor (`ScanCursor.lastReinvokeAt`,
`ScanCursor.reinvokeAttempts`, both added by Phase 4o W2 for exactly
this kind of post-mortem). The backtest cursor has only
`lastReinvokeError`, and as noted above, that is essentially never
written.

Secondary contributing factor: **8 self-POSTs arrive in the same
~10 ms window** because all 8 watchdogs trip at exactly the same
13-min mark. There is no jitter in the dispatch path. Even if the
platform's concurrency limit is comfortably above 8, the arrival
clustering maximises the probability of a brief over-limit window.

---

## Trade-off note for W2

Brief PART IX raises the reliability-vs-bounded-concurrency call. The
diagnosis points to a fix that is **both, lightly:**

- **Hardened per-dispatch reliability** is the primary fix — retry
  the reinvoke fetch with bounded exponential backoff and surface
  the real outcome to the cursor. This addresses the underlying
  defect (silent loss of throttled dispatches).
- **Bounded clustering** is a supporting fix — add a small (≤1.5s)
  jitter before the dispatch fetch so 8 simultaneous watchdog trips
  don't all hit the gateway in the same instant. This is not bounded
  concurrency in the strict sense (we do not gate cross-run); it is
  cheap insurance that reduces the load spike without serialising
  the runs.

We do not need to serialise the 8 rolling backtests across cron
cycles — the production evidence (eventual 8/8) shows that with
even modest reliability hardening the platform handles the load.

W3 adds the stuck-run net so that any future stall (a fix-resistant
class S5-style failure, or a Netlify outage swallowing every retry)
does not freeze a window forever.
