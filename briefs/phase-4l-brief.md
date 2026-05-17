# Phase 4l — Insider board completeness

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** `~0.18.7-alpha` (agent bumps APP_VERSION one patch
from whatever `main` is at branch time; no scoring-math change)
**MODEL_VERSION:** unchanged.
**Dependencies:** Phase 4h (merged `c3f822b`) — supplies the
checkpoint-resume pattern (`shared/scan-resume/`) this phase reuses for
W2. Finnhub API key already provisioned. No new services, no new
subscriptions.
**Parallel-with:** safe alongside 4j (disjoint files). Must NOT run
alongside another agent touching `shared/scan-insider.ts`,
`insider-board.ts`, or `shared/snapshot-store.ts`.
**Estimated effort:** one executor agent session, ~2–3 hours, plus
~30 min orchestrator review/merge/verify.

---

## Executive summary — the decision and the ask

The insiders-purchasing board claims to cover the S&P 500, the Dow, the
Nasdaq 100 and the Russell 2000 — ~2,245 names — but in practice it
shows only ~33 tickers. Chad noticed this and was right to: the board
is structurally incapable of reflecting the full universe today.

A live probe found two distinct defects. First, the "all indices" view
skips the snapshot store entirely and runs a **capped live scan of 80
tickers** — it looks at 80 of 2,245 names and shows whatever those 80
happened to have. Second, the per-universe scheduled scans *do* run
daily and *do* sweep their full universe, but the Russell 2000 scan
(~2,000 Finnhub calls) hits the same Netlify 15-minute background
ceiling that Phase 4h fixed for the target board — so the small-cap
universe, **where insider buying is most common**, is the most broken.

Phase 4l closes both: it makes the "all" view aggregate the four
per-universe snapshots, and it applies 4h's checkpoint-resume pattern
to the Russell insider scan so that scan can actually finish.

**The financial case is trivial and worth stating plainly because Chad
asked about it directly: there is no LLM/Claude token cost here at
all.** Insider scanning is pure Finnhub API calls plus arithmetic — no
AI inference. The scan already runs daily and should stay daily; the
only costs are Finnhub API quota and Netlify function-minutes, both
modest. Build cost is one short agent session reusing 4h's machinery.
This is a cheap, high-certainty fix. Approve.

---

# PART I — THE PROBLEM

Surfaced 2026-05-17 from Chad's observation that the insiders-purchasing
tab returns only ~33 tickers — "I know that can't be true."

### Defect A — the "all" view scans only 80 tickers

`insider-board.ts` is snapshot-first *only when a single index is
selected*. The relevant line:

```ts
const snapshotUniverse: UniverseKey | null =
  indexFilter === 'all' ? null : (indexFilter as UniverseKey);

if (!force && snapshotUniverse) {   // ← null for 'all' → this block is SKIPPED
  ... snapshot path ...
}
```

When `index=all`, `snapshotUniverse` is `null`, the snapshot block is
skipped, and the request falls through to a **live capped scan** —
`LIVE_SCAN_CAP = 80`. So the "all" view scores 80 tickers out of ~2,245
and returns whatever buys/sells those 80 had. It never reads the
per-universe snapshots that the scheduled scans produce.

### Defect B — the Russell 2000 insider scan cannot finish

There *are* per-universe scheduled scans —
`scan-insider-{sp500,ndx,dow,russell2k}.ts`, all on `30 21 * * 1-5`
(21:30 UTC, weekdays, after the US close). They call `runInsiderScan`,
which sweeps the full universe uncapped (`cap = scanCap ?? Infinity`).
Good in principle. But `scan-insider-russell2k.ts` is a single-pass
scheduled function making ~2,000 Finnhub insider-transaction calls —
that does not complete inside Netlify's 15-minute background ceiling.
It is the same defect class Phase 4h fixed for `scan-target-board-
russell2k`. The Russell snapshot is therefore perpetually partial or
stale — and small-caps are exactly where genuine insider buying
concentrates.

### Why the count is ~33

The two defects compound. The "all" view's 80-ticker live scan, drawing
from a universe whose Russell slice is under-covered anyway, surfaces
~31–33 names — of which only a handful are genuine open-market buys.

### A note on realistic expectations

Genuine open-market insider *purchases* (transaction code P — not
sells, not option exercises, not grants/awards, not derivatives) are
genuinely uncommon; most insider activity is selling. Even a fully
correct scan will not surface thousands of buyers. But across the full
~2,245-name universe in a 90-day window it should surface a few
hundred names with insider activity and a meaningful set of genuine
buyers — not 33.

---

# PART II — CURRENT-STATE FORENSICS (CTO)

Live probe, 2026-05-17:

```
GET /api/insider-board?index=all&days=90&limit=200
  universeChecked: 2245          ← reports the universe is 2,245 names
  source:          fallback-partial   ← capped live scan, NOT a snapshot
  rows returned:   31
  rows with buys:  4
```

`universeChecked: 2245` is the universe *size*; `source:
fallback-partial` confirms only the 80-cap live slice was actually
scored. The mismatch between "2,245" and "scored 80" is the bug in one
line.

### The pieces that already work (4l does not rebuild them)

| Piece | Status |
|---|---|
| `runInsiderScan` (`shared/scan-insider.ts`) | Sweeps the full universe uncapped when no `scanCap` is passed — correct |
| Per-universe scheduled scans (sp500/ndx/dow/russell2k) | Run daily `30 21 * * 1-5`; sp500/ndx/dow complete fine |
| Snapshot store (`boardSnapshots/insider/_latest/{universe}`) | Per-universe snapshots written + read; the single-index path already uses them |
| `filterRowsToWindow` | Snapshots taken at 180d, re-filtered to 30/60/90/180 on read — works |
| `shared/scan-resume/` (Phase 4h) | Cursor + watchdog + reinvoke — reused by W2 |

The only broken parts are the `all` aggregation path and the Russell
scan's inability to finish. 4l is a targeted fix, not a rewrite.

---

# PART III — FINANCIAL ANALYSIS (CFO)

Chad asked, in raising this, "I'm not sure how many tokens that'll
take." The direct answer matters: **none.**

### No LLM/AI cost

Insider scanning is Finnhub API calls plus arithmetic aggregation.
There is no Claude/AI inference anywhere in this pipeline. Cadence is
not a token-budget question. The scan already runs daily and should
**stay daily** — there is no token saving to be had by moving to weekly
or monthly, and daily data is what an insider board is for.

### Run cost — modest, and 4l barely moves it

- **Finnhub:** ~2,245 insider-transaction calls per full daily sweep,
  already split across four per-universe scheduled functions. 4l does
  not increase call volume — it makes the Russell slice actually
  *finish*, which means the calls already being attempted now complete
  instead of being wasted on a killed function. Finnhub quota usage is
  essentially unchanged.
- **Netlify compute:** the Russell insider scan, checkpoint-resumed,
  becomes ~3–4 chained ~13-minute invocations once daily — comparable
  to the 4h target scan. The current single killed 15-minute run is
  *also* billed, so this is close to cost-neutral and arguably a small
  saving (work that completes vs. work that's thrown away).
- **`index=all` aggregation:** replaces an 80-ticker live scan with
  four O(1) snapshot reads — *faster and cheaper* per request.
- **Firestore:** the Russell scan's checkpoint-resume uses a
  short-lived partial subcollection (deleted on completion); de
  minimis.

### Build cost

One executor agent session, ~2–3 hours — smaller than 4h because W2
reuses 4h's `shared/scan-resume/` modules verbatim and W1 is a
straightforward aggregation. No new vendors, services, or
subscriptions.

### Verdict

Near-zero incremental run cost, no token cost, one short build. The
return is that the insiders board finally reflects the universe it
claims to — turning a structurally-broken tab into a usable one.
Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

Two workstreams, one PR. Order **W1 → W2** — W1 is the immediate
visible fix; W2 deepens Russell coverage.

### W1 — `index=all` aggregates the per-universe snapshots

Rework the `all` path in `insider-board.ts` so it:

1. Reads the four per-universe `insider` snapshots
   (`latestSnapshot('insider', u)` for `sp500`, `ndx`, `dow`,
   `russell2k`).
2. Unions their rows and **de-duplicates by ticker** — the indices
   overlap (the Dow is a subset of the S&P 500; the Nasdaq 100 overlaps
   it heavily), so the same ticker will appear in multiple snapshots.
   On a collision, keep one row (they describe the same insider
   activity for the same ticker — pick deterministically, e.g. the
   first non-stale, or merge identically).
3. Re-aggregates to the requested window via the existing
   `filterRowsToWindow` (snapshots are stored at the 180-day window).
4. Sorts and trims to `limit`.
5. Returns `source: 'snapshot-aggregate'` with a `generatedAt` that
   reflects the *oldest* contributing snapshot (so freshness is honest).

**Graceful partial:** if one universe's snapshot is missing or stale
(e.g. Russell mid-rollout of W2), `all` still returns the union of the
universes that *do* have snapshots, flagged accordingly — never an
empty board, never a fallback to the 80-cap live scan.

**Retire or shrink the live fallback for `all`.** The 80-cap live scan
should no longer be the `all` path. A `force=1` escape hatch may keep a
capped live scan for debugging, but the default `all` view is
snapshot-aggregate.

### W2 — Checkpoint-resume the Russell insider scan

Apply Phase 4h's pattern to `scan-insider-russell2k.ts` (and
prophylactically `scan-insider-sp500.ts` if it is also near the
ceiling — verify its runtime first):

- Reuse `shared/scan-resume/{cursor,watchdog,reinvoke}.ts` from 4h.
- Split into a thin scheduled trigger + a `-background.ts` worker that
  processes the universe in batches, checkpoints a cursor, and
  self-reinvokes via `Context.waitUntil` until the sweep is complete.
- Partial results accumulate in a subcollection
  (`insiderScanRuns/{runId}/partial/...`) — not on the cursor doc —
  to stay clear of Firestore's 1 MiB document ceiling.
- Terminal batch assembles the full row set and calls `writeSnapshot`
  once; the `_latest` pointer advances only on terminal success
  (atomic swap — a partial scan never degrades the live snapshot).
- Keep the daily cadence (`30 21 * * 1-5`); the checkpoint-resume just
  lets that one daily run finish.

---

# PART V — ARCHITECTURE DETAIL (CTO)

### Dedup across overlapping indices (W1)

The four universes are not disjoint — the Dow's 30 names are all in the
S&P 500; the Nasdaq 100 overlaps the S&P 500 heavily. A naive union
would list AAPL three or four times. De-duplicate by ticker. Because
every snapshot is produced by the same `runInsiderScan` over the same
180-day window, the rows for a given ticker should be equivalent across
snapshots — so "keep the first" is acceptable; if snapshots can differ
in freshness, prefer the freshest contributing snapshot's row.

### Honest freshness for the aggregate (W1)

The aggregate is only as fresh as its *stalest* input. Report
`generatedAt` as the oldest contributing snapshot's timestamp and
surface a `stale` flag if any contributing snapshot is past its
freshness budget — so the UI never implies the Russell slice is current
when it isn't.

### Atomic swap + partial subcollection (W2)

Identical discipline to 4h: the in-progress Russell scan never touches
the live `_latest` pointer until its terminal batch succeeds; partial
rows live in a subcollection so the cursor document stays small. A
failed mid-scan leaves the previous Russell snapshot intact.

### Out of scope

- Changing what counts as a "buy" vs. award vs. derivative — the
  existing classification stays.
- Insider-signal scoring (the `insider-analyst` in the Prophet/Target
  composite) — that is analyst-pipeline work, separate from the
  insider *board's* completeness.
- Per-analyst Williams/Lynch work — Phases 4m/4n.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | One universe's snapshot missing/stale → `all` looks incomplete | Medium (during W2 rollout) | Partial board | `all` returns the union of available snapshots, flagged; never empty, never the 80-cap live scan. |
| R2 | Duplicate tickers across overlapping indices | High if unhandled | Same name listed 3–4× | De-dup by ticker in W1; documented in PART V. |
| R3 | Russell scan cursor/partial payload hits 1 MiB ceiling | Medium | Terminal write fails silently | Partial rows in a subcollection from the start (4h pattern). |
| R4 | `Context.waitUntil` reinvoke doesn't survive container freeze | Low | Scan stalls mid-chain | Reuse 4h's `reinvoke.ts` verbatim — validated in production. |
| R5 | Finnhub rate-limit pressure when the Russell scan actually runs to completion | Low–Medium | Throttled / partial | The scan already attempts these calls today; completing them is not more calls, just more *finished* ones. Honor existing concurrency limits in `mapWithConcurrency`. |
| R6 | sp500 insider scan also near the ceiling | Medium | sp500 slice partial too | Verify sp500 scan runtime; if near the limit, apply the same checkpoint-resume prophylactically (W2 covers this). |

No cost-overrun risk — 4l adds no metered compute class and no token cost.

---

# PART VII — ACCEPTANCE CRITERIA

A build passes when **all** hold:

1. `GET /api/insider-board?index=all` returns the de-duplicated union
   of all four per-universe snapshots — `source: 'snapshot-aggregate'`,
   not `fallback-partial` — and is no longer capped at 80 tickers.
2. The response reflects materially more than ~33 names (full-universe
   coverage; exact count depends on real insider activity, but it is
   the union of four complete sweeps, not an 80-ticker sample).
3. `GET /api/insider-board?index=all` returns in < 2 seconds (four
   snapshot reads, not a live scan).
4. The Russell 2000 insider scan completes end-to-end —
   `insiderScanRuns/{runId}` reaches `status: done` with
   `invocationCount > 1` and a written Russell snapshot.
5. `index=all` degrades gracefully when one universe snapshot is
   missing/stale (returns the rest, flagged) — never empty, never the
   80-cap live scan.
6. `tsc --noEmit` clean, full test suite green, `npm run build` clean.
7. New tests cover: the `all` aggregation + dedup, graceful partial
   when a snapshot is absent, the Russell scan cursor advance/resume,
   and terminal-only snapshot publish.

Live verification is deferred to post-merge — the orchestrator fires
the Russell scan and probes `/api/insider-board?index=all`, confirming
criteria 1–5 against production.

---

# PART VIII — ROLLOUT PLAN

1. Agent ships W1 + W2 as one PR; CI green; orchestrator reviews the
   `all` aggregation/dedup and the Russell checkpoint-resume
   specifically. **PR opened ready-for-review, not draft.**
2. Merge. Netlify deploys (~3 min).
3. Orchestrator fires the Russell insider scan; confirms completion
   (`status: done`, `invocationCount > 1`).
4. Orchestrator probes `/api/insider-board?index=all` — confirms
   `snapshot-aggregate`, full-universe coverage, sub-2-second latency.
5. Update `ORCHESTRATOR.md` 4l row to done.

Rollback is clean — W1 is a read-path change, W2 is additive
(new background worker + cursor). Reverting the PR restores the prior
behavior; no data migration is involved.

---

# PART IX — OPEN DECISIONS FOR CHAD

Two small choices; each has a recommended default. Answer (or say
"defaults") and the executor kickoff goes out.

1. **Default view filter.** Should the insiders tab default to showing
   *net buyers only* (genuine open-market purchases), or all insider
   activity (buys, sells, awards) with buys highlighted? *Recommendation:
   default to net buyers — the tab is "insiders purchasing," and a
   buyers-first default matches the intent. All-activity stays
   available as a toggle. This is a small UI tweak that can ride along
   in W1; say the word and it's included.*

2. **sp500 insider scan.** Apply checkpoint-resume to the sp500 insider
   scan prophylactically in this phase, or only if it's measured to be
   near the ceiling? *Recommendation: have the agent measure the sp500
   scan's runtime first; apply checkpoint-resume only if it's within
   ~3 minutes of the 15-minute limit. The Russell scan is the certain
   problem; sp500 is a maybe.*

---

*End of brief. Phase 4l is unblocked (4h's scan-resume modules exist).
It is a short, cheap, high-certainty fix that makes the insiders board
reflect the universe it claims to cover. Recommendation: approve and
proceed.*
