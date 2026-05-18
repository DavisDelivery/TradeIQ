# Phase 4p — Russell 2000 scan terminal-step fix

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** `~0.18.9-alpha` (agent bumps APP_VERSION one patch
from `main` at branch time; no scoring-math change)
**MODEL_VERSION:** unchanged.
**Dependencies:** Phases 4h, 4l, 4o (all merged). 4o's `/api/scan-status`
diagnostic produced the diagnosis this brief is built on. Reuses the
existing `shared/scan-resume/` + `shared/backtest-resume/` checkpoint
machinery.
**Parallel-with:** must NOT run alongside an agent touching the scan
worker functions, `shared/scan-resume/*`, `shared/backtest-resume/*`,
or `shared/snapshot-store.ts`.
**Estimated effort:** one executor agent session, ~2–3 hours — a
focused, precisely-diagnosed fix.

---

## Executive summary — the decision and the ask

Both russell2k scans — target-board and insider — are still broken
after Phase 4o, and Phase 4o's own `/api/scan-status` diagnostic has
now told us *exactly* why, leaving no guesswork.

The scans are **not** failing to walk the universe. The reinvoke chain
works: the cursor advances through all 2,037 russell2k tickers, ~2,022
get scored, 41 partial batches accumulate. The failure is the **terminal
step** — once the cursor reaches the end of the universe, the worker
must assemble the partial batches, build the snapshot, write it, and
mark the run `done`. That step never completes. The run freezes at
`status: running, nextTickerIndex: 2037` permanently; no snapshot is
ever published. One russell2k run has been frozen in exactly this state
since 2026-05-17 23:14.

This is **one root cause breaking both boards** — they share the
checkpoint-resume worker machinery. The most likely mechanism: the
terminal assemble-and-write is crammed into the tail of the last
batch-processing invocation and runs out of that invocation's
15-minute platform budget.

Phase 4p fixes it by giving the terminal step its **own dedicated
invocation** with a fresh 15-minute budget. One fix, both boards.

**The financial case is trivially positive:** today every russell2k
scan run burns ~41 minutes of function time across three invocations
and produces *nothing*. 4p makes that work actually complete — it is
cost-saving, not cost-adding. No new services, no LLM tokens. Approve.

---

# PART I — THE PROBLEM (precisely diagnosed)

Diagnosed 2026-05-18 via Phase 4o's `/api/scan-status` endpoint.

### What `/api/scan-status` showed

Run `target-board-russell2k-20260518-085232`:

```
status:            running          ← never flipped to "done"
nextTickerIndex:   2037 / 2037       ← walked the ENTIRE universe
scoredCount:       2022
partialBatchCount: 41
invocationCount:   3
reinvokeAttempts:  2
updatedAt:         2026-05-18T09:28:36Z   ← then frozen
```

Polled again at 09:38 — well past the invocation's 15-minute platform
ceiling — `status` was still `running`, `updatedAt` still frozen at
09:28:36. The target board still served the 2026-05-17 stale snapshot.

An older run, `target-board-russell2k-20260517-231327`, sits in the
*identical* dead state — `status: running, nextTickerIndex: 2037` —
frozen since 2026-05-17 23:14, ~10+ hours.

### What this rules in and rules out

- **Ruled out — a reinvoke/handoff stall.** The chain reinvoked twice
  and the cursor advanced through all 2,037 tickers. The earlier
  hypothesis (a self-reinvoke stall) is wrong.
- **Ruled in — a terminal-step failure.** The scan does all the hard
  work, then dies at the finish line. Once `nextTickerIndex >=
  totalTickers`, the worker must: read the 41 partial batches, assemble
  the rows, run `assessSnapshotPublish`, `writeSnapshot`, and
  `clearScanCursor('done')`. That sequence never completes.

### The most likely mechanism

Invocation 3 started 09:19:46. The cursor reached the end of the
universe at ~09:28:36 — about 9 minutes into the invocation — leaving
only ~6 minutes before the 15-minute platform kill at ~09:34:46. The
terminal assemble-and-write did not finish in those ~6 minutes; the
invocation was killed mid-terminal-step. `status` never advanced to
`done`; no snapshot was written.

In other words: **the terminal step is crammed into the leftover
minutes of the last batch-processing invocation, and there are not
enough of them.** A secondary possibility — the terminal write throws
(e.g. an oversized snapshot document) — is covered defensively in W2,
but the timing fits the budget-exhaustion explanation precisely.

### Why this breaks BOTH russell2k scans

The target-board and insider russell2k workers share the
checkpoint-resume machinery. The insider scan post-4o almost certainly
walks the universe fine (Phase 4o's W1 Finnhub throttle working) and
then dies at the same terminal step — which is why the insider
`_latest` pointer still references the empty pre-4o `01:01:10`
snapshot. **One root cause, two broken boards.** Phase 4o's W1 throttle
is probably working; its payoff is simply masked until the terminal
step is fixed.

---

# PART II — CURRENT-STATE NOTES (CTO)

- The reinvoke chain (`shared/backtest-resume/reinvoke.ts`,
  `watchdog.ts`) works — do not rewrite it.
- The batch loop and cursor advance work — the cursor reaching
  `nextTickerIndex: 2037` proves it.
- Phase 4o's `assessSnapshotPublish` (the degraded-publish guard) is
  correct and stays — it is downstream of the terminal step, not the
  cause.
- The single-pass scans (sp500/ndx/dow) do not use checkpoint-resume
  and are unaffected.
- `/api/scan-status` works (the Firestore index is now provisioned)
  **but ignores its `scan` query param** — it always returns the
  target-board russell2k scan. This blocked direct inspection of the
  insider scan and is fixed in W3.

---

# PART III — FINANCIAL ANALYSIS (CFO)

Short, because the answer is short: **4p saves money, it does not cost
money.**

- Today every russell2k scan run consumes ~41 minutes of Netlify
  function time across three invocations — and publishes nothing. That
  compute is pure waste.
- 4p makes that work complete. Same compute, but it now yields a
  snapshot. Strictly better.
- No new services, no new subscriptions, **no LLM/token cost** — this
  is scan-machinery plumbing.
- Build cost: one focused agent session, ~2–3 hours — smaller than 4o;
  the bug is already diagnosed to the exact failing step.

Approve. The only thing standing between Chad and working russell2k
coverage on two boards is this fix.

---

# PART IV — PROPOSED SOLUTION (CTO)

Three workstreams, one PR. Order **W1 → W2 → W3**.

### W1 — A dedicated invocation for the terminal step

Restructure the checkpoint-resume worker so the terminal step is never
crammed into the tail of a batch-processing invocation:

- Add a cursor state distinguishing "still walking the universe" from
  "walk complete, terminal step pending" — e.g. a `phase` field
  (`'scanning'` → `'finalizing'`) or a `status: 'finalizing'`.
- When the batch loop observes `nextTickerIndex >= totalTickers`, it
  does **not** run the terminal block inline. It sets the cursor to
  `finalizing` and **reinvokes once more**.
- The worker entry, on seeing a `finalizing` cursor, **skips the batch
  loop entirely** and runs only the terminal step — `readAllPartial
  Batches`, assemble, `assessSnapshotPublish`, `writeSnapshot`,
  `clearScanCursor('done')` — with a fresh, full 15-minute budget.
- Apply this to **both** russell2k workers —
  `scan-target-board-russell2k-background.ts` **and**
  `scan-insider-russell2k-background.ts`. If they share a common worker
  helper, fix it once there; if the logic is duplicated, fix both and
  prefer factoring the shared piece.

### W2 — Make the terminal step robust (defense for W1)

A dedicated invocation gives the terminal step time; W2 ensures it
cannot fail for other reasons:

- **Idempotency.** If the finalizing invocation is itself killed and
  reinvoked, re-running the terminal step must be safe: re-reading the
  partial batches and re-writing the snapshot for the same `runId` is
  idempotent; `clearScanCursor('done')` happens only at the very end,
  so a re-run simply redoes the assemble+write and then completes.
- **Snapshot size.** Confirm what the target-board snapshot actually
  stores — the board displays a top-N (50) but the run scores ~2,022.
  If the snapshot persists all scored rows it risks Firestore's 1 MiB
  document ceiling; the terminal write must trim to the stored-N or
  chunk. Verify and make the write size-safe for both boards.

### W3 — Stuck-run recovery + the `/api/scan-status` param fix

- **Stuck-run handling.** Two russell2k runs are frozen `status:
  running` forever. A run that is `running` but whose `updatedAt` is
  stale beyond a sane threshold must be recognized as dead — the
  scheduled trigger / watchdog should either resume it (re-fire the
  terminal step, which W2's idempotency makes safe) or mark it
  `failed`. At minimum, a stale-`running` run must never block the next
  scheduled scan from starting a fresh run.
- **Fix `/api/scan-status`.** It currently ignores its `scan` param and
  always returns the target-board russell2k scan. Make it honor `scan`
  (or `board` + `universe`) so the insider scan — and every other scan
  — can actually be inspected. This is required to verify the fix on
  the insider side.

---

# PART V — ARCHITECTURE DETAIL (CTO)

### The `finalizing` handoff

The worker already self-reinvokes; W1 adds one more reinvoke and a
cursor phase. The control flow becomes:

```
worker entry:
  if cursor.phase == 'finalizing':
      run terminal step (fresh 15-min budget); done.
  else:
      batch loop while nextTickerIndex < totalTickers && !watchdog.expired
      if nextTickerIndex >= totalTickers:
          cursor.phase = 'finalizing'; reinvoke; return
      else (watchdog expired mid-walk):
          reinvoke; return    ← unchanged existing behavior
```

The terminal step is thus *always* the first and only thing a
`finalizing` invocation does — it can never be starved of budget by
preceding batch work.

### One fix, both boards

The target and insider russell2k workers share the checkpoint-resume
pattern. The cleanest implementation puts the `finalizing` phase logic
in the shared layer so a single change covers both. If the workers
carry duplicated logic, both must be changed — a fix that lands on only
one board leaves the other broken (see Risk R4).

### Out of scope

- The reinvoke/watchdog mechanics themselves — they work.
- `assessSnapshotPublish` (Phase 4o W3) — correct, unchanged.
- The Finnhub throttle (Phase 4o W1) — unchanged; 4p is what finally
  lets its effect be observed.
- Analyst scoring, the `index=all` aggregation, any UI.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | New `phase` field interacts badly with the two already-frozen runs | Low | Old zombies linger | The frozen runs are dead; the next scheduled run starts fresh with the new cursor shape. W3's stuck-run handling clears the zombies. |
| R2 | The dedicated terminal invocation itself exceeds 15 min | Low | Terminal step still fails | The terminal step is read-41-batches + sort + one write — comfortably under 15 min with a fresh budget. W2 chunks it if size genuinely demands. |
| R3 | Finalizing invocation killed mid-write, re-run double-writes | Low | Inconsistent snapshot | W2 idempotency: same-`runId` re-assemble+re-write overwrites cleanly; `clearScanCursor('done')` only at the very end. |
| R4 | Fix lands on one worker, not both | Medium if rushed | One board stays broken | Brief is explicit: fix BOTH russell2k workers, ideally via shared code. Acceptance verifies both. |
| R5 | Terminal write hits the 1 MiB doc ceiling | Low–Medium | Terminal step throws | W2 verifies snapshot size and trims/chunks. |

No cost-overrun risk — 4p reduces wasted compute.

---

# PART VII — ACCEPTANCE CRITERIA

A build passes when **all** hold:

1. The russell2k **target-board** scan completes — `status: done`, a
   fresh snapshot published, `companyName`/`sector` populated on picks.
2. The russell2k **insider** scan completes — `status: done`, a
   **non-empty** snapshot published. (This also finally confirms Phase
   4o's W1 Finnhub throttle works.)
3. A run that reaches the end of the universe always either completes
   terminally or is recoverable — no run is left permanently
   `status: running`.
4. `/api/scan-status?scan=insider-russell2k` returns the **insider**
   scan's runs (the `scan` param is honored).
5. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
6. New tests cover: the `finalizing` phase handoff, the terminal-step
   dedicated invocation, idempotent terminal re-run, and the
   `scan-status` param routing.

Live verification is post-merge — the orchestrator fires both russell2k
scans and confirms `status: done` + published snapshots via
`/api/scan-status` and the board endpoints.

---

# PART VIII — ROLLOUT PLAN

1. Agent ships W1 + W2 + W3 as one PR; CI green; orchestrator reviews
   the `finalizing` handoff and confirms BOTH workers were fixed. **PR
   opened ready-for-review, not draft.**
2. Merge (confirm `merged: True` before any branch delete). Netlify
   deploys.
3. Orchestrator fires the russell2k target scan; after the chain +
   finalizing invocation, confirms `status: done` and a fresh snapshot
   with companyName/sector.
4. Orchestrator fires the russell2k insider scan; confirms `status:
   done` and a **non-empty** snapshot — closing out both 4p and the
   verification of 4o's W1.
5. Update `ORCHESTRATOR.md` — 4p done, and 4h / 4l W2 / 4o marked
   fully resolved.

Rollback is clean — W1 adds a cursor phase + one reinvoke; W2/W3 harden
and clean up. Reverting restores prior behavior; no data migration.

---

# PART IX — NO OPEN DECISIONS

This brief has no open decisions for Chad. The bug is diagnosed to the
exact failing step, the fix shape is determined, and there are no
product or cost trade-offs to choose. Approve and the executor kickoff
goes out.

---

*End of brief. Phase 4p is the fix that finally lands working russell2k
coverage on both the insider and target boards — and unlike its
predecessors it is diagnosed, via Phase 4o's own instrumentation, down
to the precise failing step. Recommendation: approve and proceed.*
