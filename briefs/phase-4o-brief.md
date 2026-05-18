# Phase 4o — Russell 2000 scan reliability, round 2

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** `~0.18.8-alpha` (agent bumps APP_VERSION one patch
from `main` at branch time; no scoring-math change)
**MODEL_VERSION:** unchanged.
**Dependencies:** Phases 4h and 4l (both merged) — this phase repairs
their russell2k scans. Reuses the existing `shared/scan-resume/` +
`shared/backtest-resume/` checkpoint machinery.
**Parallel-with:** must NOT run alongside an agent touching
`shared/scan-insider.ts`, `shared/data-provider.ts`, the scan worker
functions, or `shared/snapshot-store.ts`.
**Estimated effort:** one executor agent session, ~3–4 hours — meatier
than 4l because one of the two bugs requires genuine diagnosis.

---

## Executive summary — the decision and the ask

Two TradeIQ boards depend on a russell2k scan, and **both russell2k
scans are broken** — for two different reasons.

The **insider** russell2k scan (Phase 4l W2) is a *silent failure*. It
fires ~2,000+ Finnhub calls, blows through Finnhub's rate limit, and
every rate-limited `429` response is quietly swallowed into an empty
result. The scan walks the whole universe, reports
`universeChecked: 2037`, writes a terminal snapshot — and the snapshot
is empty. Nothing in the snapshot's `warnings` reveals it. A scan that
looks complete and is not. **Root cause confirmed** (forensics in
Part II).

The **target-board** russell2k scan (Phase 4h) is broken differently:
it never writes a terminal snapshot at all. The board still serves a
day-old `snapshot-stale` result. The prior known issue was a
self-reinvoke handoff stall mid-chain. **Not yet freshly diagnosed** —
Part III is honest about that.

Phase 4o fixes both, and adds the systemic guard that should have
caught the first one: a degraded scan must never silently publish an
empty snapshot over a good one. The non-russell2k universes
(sp500/ndx/dow) all work — this is specifically about the large scan.

**The financial case is small but has one genuine question for Chad:
Finnhub plan tier.** Throttling the russell2k scan to respect the rate
limit is the fix — but if Chad's Finnhub tier is low enough that even a
throttled scan can't finish in a nightly window, that's a plan-upgrade
decision (Part X). Otherwise this is a cheap, high-priority repair —
two boards' worth of small-cap coverage are dark until it lands.
Approve.

---

# PART I — THE TWO FAILURES

Surfaced 2026-05-18 during post-merge verification of Phase 4l.

| | Insider russell2k (Bug A) | Target-board russell2k (Bug B) |
|---|---|---|
| Symptom | Terminal snapshot written, `universeChecked: 2037`, **`results: []`** | **No terminal snapshot** — board serves a day-old `snapshot-stale` |
| `generatedAt` | Fresh (scan "completed") | `2026-05-17T01:05:33Z` — ~24h+ stale |
| Root cause | **Confirmed:** Finnhub `429` rate-limiting, silently swallowed | **Suspected:** self-reinvoke handoff stall mid-chain — needs diagnosis |
| Data source | Finnhub (insider transactions) + Polygon (price enrich) | Polygon (bars/fundamentals) + analyst pipeline |
| Fix confidence | High — clear, scoped | Diagnose first, then fix |

Both are the russell2k checkpoint-resume scan. Both block the ~2,000
small-cap names — exactly where insider buying concentrates and where
the target board has the most ground to cover. They are bundled into
one phase because one agent, fluent in the checkpoint-resume
machinery, should fix them together.

---

# PART II — BUG A FORENSICS: the Finnhub rate-limit silent failure (CTO)

### The evidence chain

1. Post-merge, the russell2k insider board returns `source: snapshot`,
   `universeChecked: 2037`, **`rows: 0`**, `warnings: null`.
2. The sp500 / ndx / dow insider scans — fired the same way, same
   code path's `getFinnhubInsiderTransactions` — return 60 / 45 / 15
   rows. They work.
3. The **only** material difference is call volume: sp500 ≈ 208 calls,
   ndx ≈ 70, dow ≈ 27 — versus russell2k ≈ **2,037**.
4. `getFinnhubInsiderTransactions` in `data-provider.ts`:

```ts
if (!res.ok) {
  if (res.status === 429) {
    console.warn(`[insider-tx] Finnhub 429 on ${ticker}; returning empty`);
  }
  return [];          // ← a rate-limited call becomes "no insider data"
}
// ...
} catch {
  return [];          // ← any thrown error becomes "no insider data"
}
```

A `429` ("you are being rate-limited — retry later") is treated
identically to "this company has no insider transactions." The scan's
batch loop sees `txs.length === 0`, produces no row, advances the
cursor, and moves on. When the russell2k scan fires 2,000+ calls at
concurrency 8 with no pacing, Finnhub rate-limits it; a large fraction
(or all) of the calls return `429`; every one becomes an empty result.
The terminal batch reads back an empty partial set and `writeSnapshot`
publishes `results: []` with `universeChecked: 2037`.

### Why it is *silent* — the worse half of the bug

The `429`s emit only a `console.warn`. They do **not** propagate into
the scan's `warnings` array, into the cursor's `lastError`, or into the
snapshot. So the snapshot looks clean (`warnings: null`), `_latest`
advances to it, and the board serves an empty russell2k as if it were a
legitimate "no insider buyers found." A loud failure would have been
caught immediately; a silent one shipped.

---

# PART III — BUG B STATUS: the target-board russell2k stall (CTO)

**Honesty note:** unlike Bug A, Bug B has **not** been freshly
diagnosed this session. What is known:

- The russell2k target board serves `source: snapshot-stale`,
  `generatedAt: 2026-05-17T01:05:33Z` — over a day old. `companyName`
  and `sector` (the Phase 4h W3/W4 fields) are `null` on every pick,
  confirming no post-4h scan has produced a snapshot.
- The symptom differs from Bug A: Bug A writes an *empty terminal
  snapshot*; Bug B writes *nothing* — the previous snapshot simply
  ages out. That points to the checkpoint chain stopping before its
  terminal batch.
- The prior Phase 4h work logged a recurring "self-reinvoke handoff"
  problem — a chain that reached a mid-universe cursor and stopped
  rather than reinvoking to completion.

Bug B's fix is therefore **diagnose-then-fix**, and the diagnosis tool
is itself a deliverable (W2). The agent must not ship a guessed fix.

---

# PART IV — FINANCIAL ANALYSIS (CFO)

### No LLM/token cost

As with 4l, these scans are API calls (Finnhub, Polygon) plus
arithmetic. No Claude/AI inference. Cadence is not a token question.

### The one real cost question — Finnhub plan tier

The fix for Bug A is to throttle the scan to Finnhub's allowed call
rate. The arithmetic the agent must run:

- russell2k ≈ 2,037 insider-transaction calls, plus ~1 Polygon
  price-enrich call per ticker that has activity.
- At Finnhub's free tier (~60 calls/min) a 2,037-call scan paces out
  to ~34 minutes of call time. The checkpoint-resume machinery already
  exists precisely to span that across ~3 invocations — so even on the
  free tier the scan *can* complete nightly, just across a chain.
- If Chad is on a higher Finnhub tier (higher calls/min), it completes
  faster and the math is comfortable.

**Decision point (Part X):** if it turns out the throttled russell2k
scan cannot reliably finish within a nightly window on the current
Finnhub tier, Chad chooses: upgrade the Finnhub plan, or accept a
less-frequent russell2k insider refresh (e.g. weekly). Most likely the
throttle simply means a longer, still-nightly-completable scan and no
plan change is needed — the agent reports the real numbers.

### Build cost

One agent session, ~3–4 hours (Bug B's diagnosis is the variable). No
new vendors or services unless Chad elects a Finnhub upgrade.

### Verdict

Cheap to build; the only possible recurring cost is an optional Finnhub
upgrade, decided on real numbers. Two boards' small-cap coverage is
dark until this lands. Highest-priority repair on the board. Approve.

---

# PART V — PROPOSED SOLUTION (CTO)

Three workstreams, one PR. Order **W1 → W3 → W2** — land the confirmed
fix and the systemic guard first; Bug B's diagnosis is the open-ended
part and goes last so it can't block the rest.

### W1 — Rate-limit-aware Finnhub access (fixes Bug A)

- **Throttle Finnhub calls to the plan's rate limit.** Add a pacing
  mechanism — a token-bucket / global rate limiter — so the scan emits
  calls no faster than Finnhub allows. The limiter caps the *rate*;
  the checkpoint-resume machinery already absorbs the resulting longer
  wall-clock by spanning more invocations.
- **Lower the russell2k scan concurrency** from 8 to a value consistent
  with the paced rate; 8 unpaced is what causes the burst.
- **429 backoff-and-retry in `getFinnhubInsiderTransactions`.** On a
  `429`, wait (exponential backoff, a few attempts) and retry — a
  `429` means "retry later," not "no data." Only after retries are
  exhausted does the call resolve, and then it must resolve as a
  *flagged error*, not a silent `[]` (see W3).
- **Stagger the four insider-scan cron schedules.** They currently all
  fire at `30 21 * * 1-5` and compete for the same Finnhub quota. Give
  each its own slot (e.g. russell2k first, then sp500/ndx/dow a few
  minutes apart) so the big scan has clean headroom.
- **Apply the same discipline to Polygon calls** in the scans if the
  agent finds Polygon is also near its limit (the target scan leans on
  Polygon) — but Bug B's symptom is a stall, not an empty write, so
  Polygon rate-limiting is a secondary check, not the W1 priority.

### W2 — Diagnose and fix the target-board russell2k stall (fixes Bug B)

- **Instrument first.** There is no public read for the scan-run
  cursor docs (`scanRuns/{runId}`). Add a minimal diagnostic surface —
  a debug/inspection endpoint, or an extension of `/api/health` — that
  exposes the latest russell2k scan run's cursor state:
  `nextTickerIndex`, `invocationCount`, `lastError`, `startedAt`,
  watchdog/terminal state. This makes the stall point *visible* and is
  a deliverable in its own right.
- **Then diagnose** the self-reinvoke handoff: confirm whether the
  reinvoke fetch fires, whether it is correctly awaited via
  `Context.waitUntil`, whether the reinvoke payload carries the
  `runId` (a chain that loses the runId starts fresh instead of
  resuming), whether the watchdog trips cleanly, and whether the
  worker URL is correct in all environments.
- **Then fix** the actual cause found. Do **not** ship a guessed fix —
  if instrumentation does not make the cause clear, report findings in
  the hand-off and stop; we iterate.

### W3 — Degraded scans must fail loud, not publish empty (systemic)

The deeper lesson of Bug A: a scan that fails *silently* and publishes
an empty snapshot is worse than one that fails loudly. Close that hole
for every scan:

- **The terminal write must not atomic-swap a degraded result over a
  good one.** If the assembled result is empty, or far below a sane
  floor, or the run's error/`429` rate is high, the terminal batch
  either (a) keeps the previous snapshot and records the run as failed,
  or (b) writes the snapshot but marks it `degraded` so the read
  endpoint surfaces `stale`/`degraded` rather than serving an empty
  board as clean.
- **Rate-limit and error counts propagate** — from
  `getFinnhubInsiderTransactions` up through the batch result, the
  cursor, and into the snapshot `warnings`. A throttled or degraded
  scan is always visible.
- Generalize this in the shared scan-resume / snapshot-store layer so
  it protects the target board, the insider board, and any future
  board — not just russell2k insider.

---

# PART VI — ARCHITECTURE DETAIL (CTO)

### Rate limiting across a stateless platform

Netlify functions are stateless per invocation, so a module-scope token
bucket only paces calls *within* one invocation. That is acceptable
here because: the checkpoint-resume chain runs one invocation at a time
per scan (it is serialized by design — each invocation reinvokes the
next), and staggering the four universe crons (W1) keeps the scans from
colliding. Within a single invocation, a module-scope limiter plus low
concurrency paces the batch loop correctly. The agent does not need a
distributed rate limiter — it needs correct in-invocation pacing plus
non-overlapping schedules.

### The "don't publish degraded" guard (W3)

`writeSnapshot` performs an atomic transaction that advances `_latest`.
W3 inserts a guard *before* that swap: assess the assembled result
(row count vs. a floor, error rate vs. a threshold). On a clear
failure, skip the `_latest` swap — the previous good snapshot keeps
serving — and record the run as failed in the cursor. The floor must be
sane: block only on clearly-broken (0 rows, or an error rate above a
high threshold), never on ordinary low yield, or the guard will refuse
to ever publish.

### Out of scope

- Changing the insider classification logic, the analyst pipeline, or
  the target-board scoring. 4o is scan *reliability* only.
- The `index=all` aggregation (Phase 4l W1 — already verified working).
- UI changes — none needed; once the scans produce real data the
  existing boards render it.

---

# PART VII — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Throttle set too conservative → scan can't finish even across a checkpoint chain | Medium | russell2k stays dark | Measure Finnhub's real limit; pace to ~80–90% of it, not a fraction. Report the completion-time math in the hand-off. |
| R2 | Bug B diagnosis inconclusive | Medium | Target scan still broken | The W2 instrumentation is the guaranteed deliverable; if the cause stays unclear after it, report and iterate — do not ship a guess. |
| R3 | W3 guard too strict → never publishes | Low–Medium | Boards freeze on old snapshots | Floor triggers only on clearly-broken (0 rows / high error rate), not on low yield. |
| R4 | Four insider crons still collide on Finnhub | Low | Partial scans | Stagger the schedules (W1). |
| R5 | 429 retry/backoff lengthens scans enough to brush the function ceiling | Low | Extra reinvocations | Checkpoint-resume already handles this — more invocations is the designed behavior, not a failure. |
| R6 | Finnhub tier genuinely too low for a nightly russell2k scan | Low–Medium | Cadence compromise | Surfaced as Chad's decision in Part X with real numbers. |

---

# PART VIII — ACCEPTANCE CRITERIA

A build passes when **all** hold:

1. The russell2k **insider** scan completes with a **non-empty**
   snapshot — a row count consistent with sp500's hit rate scaled to
   the russell2k universe (hundreds of names), not 0.
2. The russell2k **target-board** scan completes and writes a fresh
   terminal snapshot with `companyName` / `sector` populated — OR, if
   Bug B's cause cannot be conclusively fixed, the W2 diagnostic
   surface is shipped and the hand-off documents the findings.
3. A rate-limited / degraded scan surfaces a visible `warnings` /
   `degraded` signal and does **not** publish an empty snapshot over a
   previously-good one.
4. `429` responses trigger backoff-and-retry, not a silent `[]`.
5. The four insider-scan cron schedules are staggered.
6. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
7. New tests cover: the rate limiter / pacing, the `429`
   backoff-and-retry, the degraded-publish guard (empty result does
   not swap `_latest`), and warning propagation.

Live verification is post-merge — the orchestrator fires both
russell2k scans and confirms non-empty completion + the degraded guard.

---

# PART IX — ROLLOUT PLAN

1. Agent ships W1 + W3 + W2 as one PR; CI green; orchestrator reviews
   the rate-limit pacing, the degraded-publish guard, and the W2
   findings specifically. **PR opened ready-for-review, not draft.**
2. Merge (confirm `merged: True` before any branch delete). Netlify
   deploys.
3. Orchestrator fires the russell2k insider scan; confirms a non-empty
   snapshot after the checkpoint chain completes.
4. Orchestrator fires the russell2k target scan; confirms a fresh
   terminal snapshot with companyName/sector populated (or reviews the
   W2 diagnostic output if Bug B needed iteration).
5. Update `ORCHESTRATOR.md` — 4o done, and 4h / 4l W2 marked resolved.

Rollback is clean — W1/W3 harden existing paths; W2 adds a diagnostic
surface plus a targeted fix. Reverting restores prior behavior; no data
migration involved.

---

# PART X — OPEN DECISION FOR CHAD

One genuine decision; the agent will surface the numbers needed to make
it.

**Finnhub plan tier / cadence.** The fix throttles the russell2k scan
to Finnhub's rate limit. The agent will compute, from Chad's actual
Finnhub tier, how long a fully-throttled russell2k insider scan takes
and whether the checkpoint chain completes it within a nightly window.

- If it completes nightly (most likely) → no action; the scan just
  takes longer, spanning more invocations. Stays daily.
- If it cannot → Chad chooses: **upgrade the Finnhub plan** for more
  headroom, or **accept a less-frequent russell2k insider refresh**
  (e.g. weekly for russell2k, daily for the large-caps).

No decision is needed up front — the agent reports the real numbers in
the hand-off and Chad decides then if the question even arises.

---

*End of brief. Phase 4o is the highest-priority repair on the board —
two boards' small-cap coverage is dark until it lands, and Bug A has a
confirmed, concrete root cause. Recommendation: approve and proceed.*
