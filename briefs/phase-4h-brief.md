# Phase 4h — Russell scan reliability, nightly schedule & company-info display

**Author:** orchestrator (written in a combined CTO + CFO voice — technical
plan and the money are presented together because for this phase they are
the same argument)
**Target version:** `0.18.5-alpha` (no scoring-math change; APP_VERSION bump
because scan scheduling, the read endpoint, and the pick schema all change)
**MODEL_VERSION:** unchanged — 4h moves and surfaces data; it does not
change how a composite is computed.
**Dependencies:** Phase 4e-1-infra (merged `32773fb`) — supplies the
checkpoint-and-resume pattern this phase reuses. Polygon API key already
provisioned in Netlify env. No new third-party services, no new
subscriptions.
**Parallel-with:** safe to run alongside 5a discovery (disjoint files).
Must NOT run alongside another agent touching `shared/snapshot-store.ts`
or `target-board.ts`.
**Estimated effort:** one executor agent session, ~3–4 hours, plus ~1 hour
orchestrator review/merge/verify.

---

## Executive summary — the decision and the ask

TradeIQ's Russell 2000 board — ~2,000 names, **the single largest research
surface in the product and the one where pricing inefficiency most
plausibly lives** — has never worked. The scan that feeds it cannot finish
inside Netlify's 15-minute background-function ceiling, and the read
endpoint that serves it hangs for ~25 seconds because, when it finds no
fresh snapshot (which is always), it runs a live partial scan *inline
inside the web request*.

The cost of this is not hypothetical. The current every-30-minute Russell
scan cron burns an estimated **~105 function-hours every month and
produces zero complete scans** — it is pure waste, metered and billed,
indefinitely.

Phase 4h does three things in one agent session: (1) makes the Russell
scan reliably complete by chaining it across the 15-minute ceiling using
the exact pattern Phase 4e-1-infra already proved in production; (2)
removes the inline-live-scan fallback so the read endpoint is an O(1)
document read; (3) attaches company name and sector to every pick and
surfaces them in the UI.

**The financial case is unambiguous.** Build cost is one agent session.
The fix *reduces* ongoing infrastructure consumption by an estimated
~550–800 Netlify credits/month while converting a 2,000-name universe
from unusable to daily-fresh. There is no version of the cost-benefit
math where 4h is not worth doing. The only open questions are about
cadence and taxonomy, listed at the end for Chad to decide.

---

# PART I — THE PROBLEM

There are three distinct defects, discovered 2026-05-15 from Chad's
observation that the Russell board "isn't working" and confirmed by live
probes.

### Defect 1 — the scan never completes (functional)

`scan-target-board-russell2k.ts` scores the universe in a single pass.
Russell 2000 is ~2,000 names at ~1–2 seconds of scoring each — roughly
33–67 minutes of compute. Netlify background functions are killed at
**15 minutes wall-clock** (hard platform limit, not configurable). Every
invocation is therefore terminated before it finishes. It scores a
partial slice, gets killed, and the next scheduled fire starts again from
zero. A complete, fresh Russell snapshot has, in effect, never existed.

### Defect 2 — the read endpoint hangs (functional + cost)

`target-board.ts` follows a snapshot-first design: read the latest stored
snapshot, return it if fresh. That part is fine — it's an O(1) pointer
read (`boardSnapshots/target-board/_latest/{universe}` → one snapshot
doc). The problem is the **fallback**: when the snapshot is stale or
missing — which for Russell is *always*, because of Defect 1 — the
endpoint falls through to `runLiveAndRespond(...)`, which runs a live
partial scan **synchronously inside the HTTP request**. That live scan is
what hangs for ~25 seconds. Every Russell page-view pays that cost in
latency *and* in metered function compute.

### Defect 3 — no company name or sector on a pick (product)

A pick is shown as a bare ticker. For the small-cap universe especially,
"is `SMTC` worth my attention?" is unanswerable without knowing it's
Semtech, a semiconductor company. The sector value already exists inside
the pipeline — the `sector-rotation` analyst computes it — it is simply
never attached to the pick object the UI receives. Company name is not
currently fetched anywhere.

### Why these three are one phase

They are the same defect viewed three ways: the Russell board does not
deliver usable, legible output. Splitting them produces multiple PRs
touching the same three files (`scan-target-board-*.ts`,
`snapshot-store.ts`, `target-board.ts`). One phase, one PR, one review.

---

# PART II — CURRENT-STATE FORENSICS (CTO)

### The scan path

```
scan-target-board-russell2k.ts   (schedule: 0,30 13-21 * * 1-5)
  └─ runTargetScan({ universe: 'russell2k', ... })   ← single-pass, ~33-67 min
  └─ writeSnapshot('target-board', 'russell2k', {...})  ← only reached if scan finishes
```

`runTargetScan` has no cursor, no watchdog, no self-reinvoke. It either
finishes or is killed. For Russell it is always killed, so `writeSnapshot`
is never reached and `boardSnapshots/target-board/_latest/russell2k` is
never advanced to a complete run.

A stopgap already shipped this session — `scan-target-board-russell2k-
nightly.ts` (a second cron at 01:00 UTC). It does not fix anything; it
just adds one more 15-minute attempt that also gets killed. It exists so
there is an evening attempt at all. **4h supersedes it** — the proper
fix should fold the nightly schedule into the real solution and the
stopgap file should be deleted as part of this phase.

### The read path

```
GET /api/target-board?universe=russell2k
  └─ latestSnapshot('target-board','russell2k')    ← FAST: 2 doc reads
       ├─ snapshot exists AND isSnapshotFresh()  → return it          (fast path)
       └─ snapshot stale / missing               → runLiveAndRespond() (THE HANG)
                                                     └─ live partial scan, inline, ~25s
```

`isSnapshotFresh()` compares `snapshotAgeMs` against `freshnessBudgetMs`.
Two things follow. First: once a complete snapshot exists, the read
endpoint is already fast — the hang is *entirely* the fallback. Second:
even after 4h makes the scan complete, the `freshnessBudgetMs` for the
target board must be wide enough to cover the gap between scans. A
once-nightly scan needs a freshness budget of at least ~26 hours or the
snapshot will read "stale" by late afternoon and the endpoint will fall
back into the inline live scan again. **The freshness budget is a
required part of W2, not an afterthought.**

### Scope boundary

Phase 4h covers the **target-board** scan for `russell2k`, and
prophylactically `sp500` (~500 names ≈ 8–17 min — borderline; sometimes
completes, sometimes killed; same defect class). It does **not** cover
the per-analyst Russell scans (`scan-catalyst-russell2k.ts`,
`scan-insider-russell2k.ts`, etc.) or the Prophet-board scans — those are
separate functions with their own timing characteristics and, if they
need the same treatment, get their own follow-up phase. `dow` (~30) and
`ndx` (~100) complete comfortably and are out of scope.

---

# PART III — FINANCIAL ANALYSIS (CFO)

Netlify moved to credit-based pricing (Sept 2025, refined April 2026).
The relevant meter: **compute is billed at 10 credits per GB-hour** for
serverless, scheduled, and background functions. Background functions are
capped at 15 minutes. The Free plan's 125,000-invocation allowance is a
hard cap with no overage; paid plans auto-recharge in credit batches.
All figures below are **models**, clearly labelled — a CFO sizes the
consumption from the architecture, then applies whatever rate card the
account is actually on.

### Current run cost — what the broken state spends

```
Daytime cron  0,30 13-21 * * 1-5
  = 2 fires/hr × 9 hrs × 5 weekdays            = 90 fires/week ≈ 390 fires/month
  each fire runs to the 15-min kill (cannot finish)
  390 fires × 15 min                          = 5,850 min   ≈ 97.5 function-hours/month

Nightly stopgap  0 1 * * *
  30 fires × 15 min                           = 450 min     ≈ 7.5 function-hours/month

TOTAL Russell target-scan compute             ≈ 105 function-hours/month
  at 1 GB memory: 105 GB-hr × 10 credits      ≈ 1,050 credits/month
COMPLETE SCANS PRODUCED                        = 0
```

Every credit of that is spent and metered. The output is nothing. This
is the single clearest line in the brief: **~105 billed function-hours a
month for zero usable result.**

Plus a smaller, variable read-path cost: every Russell page-view that
hits the stale-snapshot fallback runs a ~25-second inline scan. Ten
views a day ≈ 2 function-hours/month of avoidable read compute.

### Post-4h run cost — what the fixed state spends

```
One complete Russell scan
  ~2,000 names × ~1.5 s avg                    ≈ 50 min compute
  chained across ~4 invocations of ≤13 min each (checkpoint-resume)

Cadence options:
  A. Nightly only (1×/day)   50 min × 30      = 1,500 min ≈ 25 function-hours/month
  B. Nightly + midday (2×/day) 50 min × 60    = 3,000 min ≈ 50 function-hours/month

  at 1 GB memory:
  A ≈ 250 credits/month     B ≈ 500 credits/month

The every-30-minute daytime cron is DECOMMISSIONED — it never produced a
complete scan and never will. Read-path inline-scan compute → ~0 (O(1)
doc read after W2).
```

### Net effect

```
                     Russell scan compute      Complete scans/month
  Current (broken)    ≈ 105 fn-hr  ≈ 1,050 cr   0
  4h, cadence A       ≈  25 fn-hr  ≈   250 cr   ≈ 30
  4h, cadence B       ≈  50 fn-hr  ≈   500 cr   ≈ 60

  SAVINGS:  ~55-80 function-hours/month  =  ~550-800 credits/month
            AND output goes from 0 → 30-60 complete scans/month
```

This is the rare engineering change that **costs less to run after the
fix than before it.** The fix pays for its own operating cost and then
some, because the current state is paying full price for a function that
is structurally guaranteed to fail.

### Build cost

- **One executor agent session**, ~3–4 hours wall-clock. Anthropic API
  inference for that session — a few dollars; uncapped by standing
  decision for TradeIQ.
- **Orchestrator** review + merge + post-deploy verification: ~1 hour.
- **Polygon:** company-name enrichment calls `/v3/reference/tickers` —
  ~2,500 one-time lookups across all universes, then cached
  indefinitely (ticker reference data effectively never changes). Well
  within any plan's rate limit. **$0 incremental.**
- **Firestore:** a one-time batch delete of accumulated stale snapshot
  docs; thereafter 1 snapshot doc + 1 pointer write per scan, plus a
  short-lived partial-results subcollection during a run. De minimis.
- **No new subscriptions. No new services. No new vendors.**

### Cost of inaction

- ~1,050 credits/month burned indefinitely for zero output.
- The 2,000-name small-cap universe — the surface with the most
  plausible inefficiency to exploit, since small caps are
  under-covered relative to large caps — stays dark.
- The inline-live-scan fallback is a **latent defect that scales**: any
  universe whose snapshot goes stale (sp500 already does, intermittently)
  triggers the same ~25s hang and the same wasted read compute. Leaving
  it un-fixed means the cost grows as the app and its usage grow.

### ROI verdict

Direct cash saving is modest at today's scale (~$4–5/month if the
account is in credit-overage; "reclaimed headroom" if within plan
allowance). **That is not the return.** The return is: a one-session
build converts a 2,000-name research surface from unusable to
daily-fresh, removes a bug class that would otherwise scale its cost,
and *reduces* the monthly run rate. Payback is immediate. Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Four workstreams, one PR. Recommended order **W3 → W2 → W1 → W4** —
W3/W2 are low-risk and independently shippable; W1 is the substantive
change; W4 depends on W3's data being present.

### W1 — Scan checkpoint-and-resume

Refactor `scan-target-board-russell2k.ts` (and `-sp500.ts`) to chain
across the 15-minute ceiling using the **exact pattern from Phase
4e-1-infra** — `shared/backtest-resume/{cursor,watchdog,reinvoke}.ts`.
That pattern is proven in production (the 4e-1-finish run completed 418
rebalances across 53 chained invocations). Reuse it; do not reinvent.

- A scan cursor records `nextTickerIndex`, `totalTickers`, `invocationCount`,
  `startedAt`, and a pointer to where partial results are accumulating.
- The scan processes a batch of tickers per invocation (size tuned so a
  batch finishes inside a ~13-minute watchdog budget, leaving ~2 minutes
  of margin under the 15-minute kill).
- At the watchdog limit it self-reinvokes via `Context.waitUntil(fetch(
  SAME_FUNCTION_URL, { resume: true }))` — the same mechanism, and the
  same race already fixed in PR #30/#31, that 4e-1-infra relies on.
- The terminal batch assembles the full result set and calls
  `writeSnapshot` exactly once.

Whether the resume modules are generalized out of `backtest-resume/`
into a shared `resume/` namespace, or a thin scan-specific layer is
modeled on them, is the agent's call — the kickoff will specify. Either
is acceptable; the architecture is identical.

### W2 — Read-endpoint de-hang

Two changes in `target-board.ts` / `snapshot-store.ts`:

1. **Remove the inline live-scan fallback for large universes.** When no
   fresh snapshot exists for `russell2k`/`sp500`, the endpoint must
   **return the last complete snapshot flagged as stale** (`stale: true`,
   with `generatedAt` so the UI can show "as of …"), *never* run a live
   scan inside the request. A stale-but-complete board beats a 25-second
   hang every time. `dow`/`ndx` may keep the live fallback — they're
   small enough that it's harmless.
2. **Widen `freshnessBudgetMs` for the target board** to comfortably
   exceed the gap between scheduled scans (≥26h for a nightly cadence;
   less if a midday scan is added). Otherwise the snapshot reads "stale"
   between scans and — even with change 1 — the UI mislabels fresh data.

### W3 — Company name + sector enrichment

Attach two fields to every pick written into a snapshot:

- `sector` — **sourced from the value the `sector-rotation` analyst
  already computes.** No new dependency; the data exists in-pipeline and
  is simply not propagated to the pick object today.
- `companyName` — fetched from Polygon `/v3/reference/tickers/{ticker}`,
  enriched at snapshot-write time, **cached aggressively** (a persistent
  ticker→name map; reference data effectively never changes, so this is
  a one-time ~2,500-call cost then near-zero).

Both fields are added to the snapshot's pick schema so they are written
once per scan and served for free on every read.

### W4 — UI surfacing

Update `AnalystContributions.jsx` and the pick-row renderer so each pick
shows company name and sector alongside the ticker and composite. Small,
contained React change. Respect the existing visual system (brand blue
`#1e5b92`, the Transformers-adjacent styling already in place is for
SENTINEL, not TradeIQ — TradeIQ keeps its current look).

---

# PART V — ARCHITECTURE DETAIL (CTO)

### Scan cursor schema (W1)

```
scanRuns/{runId}
  universe:        'russell2k'
  board:           'target-board'
  status:          'running' | 'done' | 'error'
  cursor: {
    nextTickerIndex:  <int>      // resume point
    totalTickers:     <int>
    invocationCount:  <int>      // proves chaining; watchdog/telemetry
    startedAt:        <iso>
  }
  partialRef:      scanRuns/{runId}/partial   // subcollection, see below
```

### Partial-results subcollection (W1)

Accumulated scored rows must **not** live on the cursor doc. Russell 2000
× a full analyst-contribution payload per row will approach or exceed
Firestore's **1 MiB document ceiling** — the same trap 4e-1-infra hit
with mlTraining rows, and solved the same way. Partial results stream
into `scanRuns/{runId}/partial/{batchId}`; the terminal batch reads them
all back, assembles the snapshot, writes it once, then the partial
subcollection can be left for TTL cleanup or deleted explicitly.

### Atomic snapshot swap (W1 + W2)

A scan in progress must never make the board worse. The previous
**complete** snapshot stays live and served throughout the new scan. The
`_latest` pointer is advanced to the new snapshot **only** on the
terminal batch's successful `writeSnapshot`. If a scan fails midway, the
last good snapshot is untouched and the read endpoint keeps serving it
(stale-flagged, per W2). No partial snapshot is ever published.

### Old-snapshot hygiene (W2)

`boardSnapshots/target-board/runs/{snapshotId}` has been accumulating one
doc per scan attempt. A one-time cleanup deletes stale runs; ongoing,
keep a bounded history (e.g. last 30 per universe) so the collection
doesn't grow without limit. This is also why the read path must use the
`_latest` pointer, never a scan-and-sort over `runs/` — the pointer read
is O(1) regardless of history depth.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Scan cursor/partial payload hits Firestore 1 MiB ceiling | Medium | Scan fails silently at terminal write | Partial results in a subcollection from the start; cursor stays small. Proven in 4e-1-infra. |
| R2 | `Context.waitUntil` self-reinvoke doesn't survive container freeze | Low | Scan stalls mid-chain | Reuse 4e-1-infra's `reinvoke.ts` verbatim — already validated in production across 53 chained invocations. Graceful `await fetch` fallback already built in. |
| R3 | A partial scan publishes and degrades the board | Low | Users see an incomplete Russell board | Atomic swap — `_latest` advanced only on terminal success; previous complete snapshot served until then. |
| R4 | `freshnessBudgetMs` left too short → endpoint still falls back | Medium | The hang persists despite W1 | W2 explicitly widens the budget to exceed the scan-gap; acceptance test checks read latency mid-afternoon, not just post-scan. |
| R5 | Polygon enrichment uncached → rate-limit pressure | Low | Slower scans / throttling | Persistent ticker→name cache; reference data never changes; ~2,500 one-time calls then near-zero. |
| R6 | Nightly scan mis-scheduled / runs too often | Low | Compute creeps back up | Explicit single nightly (or nightly + one midday) cron; no every-30-min cadence. CFO guardrail below. |
| R7 | Firestore index build lag if a composite index is introduced | Low | Brief query errors post-deploy | The `_latest` pointer design needs no composite index; if W2 adds one for history queries, deploy the index first and let it build before shipping the query. |
| R8 | Scope creep into per-analyst Russell scans | Medium | Session overruns | Brief explicitly scopes 4h to the target-board scan only; per-analyst scans are a separate phase. |

**CFO guardrail:** the new scheduled function must hard-code its cadence.
No dynamic scheduling, no per-request scan triggering for large
universes. The whole point of 4h is that Russell compute becomes a
predictable, bounded ~25–50 function-hours/month line item — not the
unbounded, usage-coupled cost it is today.

---

# PART VII — ACCEPTANCE CRITERIA

A run is acceptance-passing when **all** hold:

1. A `russell2k` target-board scan completes end-to-end — terminal
   `status: done`, all ~2,000 names scored, snapshot written — chained
   across multiple invocations, with `invocationCount > 1` proving the
   resume worked.
2. `GET /api/target-board?universe=russell2k` returns in **< 2 seconds**
   when probed at an arbitrary time of day (not just immediately after a
   scan) — i.e. the inline-live-scan fallback is gone and the freshness
   budget covers the scan-gap.
3. Every pick in the response carries a non-empty `companyName` and
   `sector`.
4. The TradeIQ UI renders company name + sector on each Russell pick.
5. `sp500` target-board scan also completes via the same path
   (prophylactic).
6. The every-30-minute daytime Russell cron is removed; the stopgap
   `scan-target-board-russell2k-nightly.ts` is removed; one scheduled
   function with the agreed cadence replaces both.
7. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
8. New tests cover: scan cursor advance/resume, terminal-only snapshot
   publish, stale-flag fallback behavior, enrichment field presence.

Live verification is deferred to post-merge (the executor sandbox has no
outbound network to the deploy) — the orchestrator fires the acceptance
scan and confirms criteria 1–4 against production, exactly as with 4e-1-
infra and 5a-prep.

---

# PART VIII — ROLLOUT PLAN

1. Agent ships W1–W4 as one PR; all CI green; orchestrator reviews the
   scan-cursor logic and the read-endpoint fallback change specifically.
2. Merge. Netlify deploys (~3 min).
3. Orchestrator fires a manual `russell2k` scan; confirms completion,
   `invocationCount > 1`, and total wall-clock.
4. Orchestrator probes `/api/target-board?universe=russell2k` for
   sub-2-second latency and presence of `companyName`/`sector`.
5. Confirm the new scheduled function is registered and the old crons
   are gone.
6. Update `ORCHESTRATOR.md` 4h row to done; record measured scan
   duration and the before/after compute figures for the record.

Rollback is clean: 4h is additive plus a scheduling change. If the
checkpoint-resume scan misbehaves, reverting the PR restores the prior
(broken-but-known) state; no data migration is involved.

---

# PART IX — DECISIONS (resolved by Chad 2026-05-17)

The four open questions are settled. The executor kickoff is written
against these answers.

1. **Scan cadence — DECIDED: nightly only (cadence A).** ~25
   function-hours/month, ~250 credits/month. A midday cron can be added
   later in one line if Chad finds he wants intraday freshness.

2. **Scan time — DECIDED: 7pm ET.** Cron `0 23 * * *` (23:00 UTC =
   7:00pm EDT; 6:00pm EST in winter — GitHub/Netlify crons are
   UTC-fixed and do not follow DST, both of which are comfortably after
   the 4pm ET market close). This supersedes the stopgap's 01:00 UTC
   schedule; the stopgap file is removed.

3. **Sector taxonomy — DECIDED: existing labels.** Use the
   `sector-rotation` analyst's sector values as-is. Zero added work;
   no GICS normalization.

4. **Snapshot retention — DECIDED: keep last 30 per universe.** Bounded
   history for any future drift/history feature; negligible storage.

---

*End of brief. Phase 4h is unblocked and fully specified. Executor
kickoff: `kickoffs/phase-4h-executor.md`.*
