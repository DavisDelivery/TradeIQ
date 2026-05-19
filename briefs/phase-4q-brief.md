# Phase 4q — Clickable analyst contribution detail

**Author:** orchestrator (CTO + CFO combined voice — house style)
**Target version:** patch bump; MODEL_VERSION unchanged — this surfaces
existing data, it does not change scoring.
**Priority:** MEDIUM — a real transparency gap; can run in parallel
with Phase 4t.
**Dependencies:** none blocking. Phase 4k (desktop layout) is merged —
the detail panel has a docked desktop variant; 4q must work in both.
**Estimated effort:** one executor session, ~3–4 hours — mostly UI.

---

## Executive summary — the decision and the ask

The target board's detail panel shows ten analyst CONTRIBUTIONS rows —
each with a score, a direction, a weight, and a LIVE / NO DATA badge.
What it does **not** show is *why* an analyst scored what it did.

This is a real gap. When the owner asked "how does MU score 50 on
Earnings when Micron has had blowout earnings," answering it required
reading the analyst source code. The answer was sitting in the
analyst's own output — `rationale: 'no earnings catalyst'`,
`signals: { _noData: true, _reason: 'no_actionable_data' }` — but the
UI never receives it.

Every analyst already computes a `rationale` string and a `signals`
object. `analyst-runner.ts` builds each pick's `AnalystContribution`
as `{ analyst, score, direction, weight }` and **discards `rationale`
and `signals`.** The drill-down detail is computed and thrown away.

Phase 4q makes each CONTRIBUTIONS row **expandable** — tap it, see that
analyst's `rationale` and `signals` breakdown, including a clear
"no actionable data" state when the analyst didn't fire. Surface the
detail the engine already produces. Approve.

---

# PART I — THE PROBLEM

The detail panel (e.g. the MU target-board card) lists ten analysts
with score / direction / weight / LIVE-or-NO-DATA. A user looking at
`Earnings 50 / NO DATA / 0%` cannot tell, from the app, whether that
means "earnings are mediocre," "no earnings catalyst is near," or "the
data feed returned nothing." Those are very different facts, and the
distinction is exactly what a user needs to trust — or question — the
composite.

The information exists. Each analyst returns an `AnalystOutput`:

```
{ score, direction, confidence, rationale, signals }
```

`rationale` is a human-readable explanation ("3/4 beats", "earnings in
4d, de-rated", "no earnings catalyst", "risk-off headwind"). `signals`
is the structured breakdown the score was built from — including the
`_noData: true` / `_reason` markers that distinguish a real neutral
score from a no-data fallback.

But `analyst-runner.ts` → `composeTarget(...)` reduces each analyst to
`AnalystContribution = { analyst, score, direction, weight }`. The
`rationale` and `signals` are dropped before the pick is ever
serialised. The UI cannot show what it never receives.

---

# PART II — CURRENT-STATE ASSESSMENT (CTO)

- `netlify/functions/analysts/*.ts` + `analysts/core.ts` — produce the
  per-analyst `AnalystOutput { score, direction, confidence, rationale,
  signals }`.
- `netlify/functions/shared/analyst-runner.ts` — assembles `allAnalysts`
  (the full `AnalystOutput` for all ten), passes it to `composeTarget`,
  which returns thin `AnalystContribution[]` (`{analyst, score,
  direction, weight}`) — `rationale`/`signals` discarded here.
- `netlify/functions/shared/types.ts` — `AnalystContribution`
  interface.
- `netlify/functions/target-board.ts` — serves the board snapshot.
  `ticker-info.ts` — a per-ticker endpoint. The executor must confirm
  **which path feeds the detail panel** (snapshot vs a per-ticker /
  on-demand re-score) before choosing where to surface the detail.
- `src/components/AnalystContributions.jsx` — the CONTRIBUTIONS UI.
- The board snapshots are large and were a cursor/limit concern in
  Phase 4u — see PART V on not bloating them.

---

# PART III — FINANCIAL ANALYSIS (CFO)

- **No LLM/token cost, no run cost.** This is data plumbing + UI.
- **Build cost:** one executor session, ~3–4 hours — weighted to the
  UI.
- **Value:** transparency the owner has explicitly asked for. It also
  pays back operationally — questions like "why is this analyst 50"
  become self-serve instead of a code read. And it directly supports
  Phase 4t/4v: seeing per-analyst rationale makes factor behaviour
  legible to the person deciding what to trust.

Approve.

---

# PART IV — PROPOSED SOLUTION (CTO)

One PR. Order **W1 → W2**.

### W1 — Surface `rationale` + `signals` to the detail panel

- Carry each analyst's `rationale` and `signals` through to the detail
  panel — e.g. extend `AnalystContribution` with optional
  `rationale?: string` and `signals?: Record<string, unknown>`, or a
  parallel per-analyst detail map on the pick.
- **First, confirm the data flow** (a small diagnose step): does the
  detail panel read the board snapshot, or does it call a per-ticker /
  on-demand path? Surface the detail through whichever path the panel
  actually uses.
- **Decision — prefer on-demand, do not fatten snapshots.** A board
  snapshot covers ~50 picks; carrying every analyst's full `signals`
  object for every pick materially inflates every snapshot. Phase 4u
  just fixed a Firestore-size problem caused by exactly this kind of
  unbounded inline growth — do not reintroduce it. If the detail panel
  has (or can use) a per-ticker on-demand path, serve the per-analyst
  detail there, fetched when the user opens a stock. If the panel is
  snapshot-only, the executor weighs adding a lean per-ticker detail
  fetch versus a bounded snapshot addition, and explains the choice.

### W2 — Expandable analyst rows

- In `AnalystContributions.jsx`, make each analyst row **expandable** —
  tap/click to reveal that analyst's `rationale` and a readable
  rendering of its `signals`.
- **The no-data state must read honestly.** When `signals._noData ===
  true`, the expanded row must say plainly that the analyst had no
  actionable data (and the `_reason`, e.g. `no_actionable_data` /
  `no_data`) — *not* present the fallback 50 as if it were a real
  assessment. This is the MU/Earnings case; it must be unambiguous.
- Render `signals` legibly — it is a structured object; show it as
  readable key/value detail, not raw JSON.
- Works on **both** the mobile detail panel and the Phase 4k docked
  desktop detail panel.

---

# PART V — ARCHITECTURE & INTEGRITY DETAIL (CTO)

### Do not bloat the board snapshots

The lean path is on-demand: the board row stays thin; the per-analyst
detail loads when a user opens a stock and expands a row. Phase 4u's
lesson — unbounded inline growth in a Firestore document — applies
directly. Surfacing detail must not make every snapshot heavier for
data most users never expand.

### Honesty of the no-data state

The whole motivation is a user mistaking a no-data 50 for a real score.
The expanded row must therefore make the no-data case *more* obvious,
not just dump signals. A no-data analyst reads as "no actionable data —
<reason>", visibly distinct from a real neutral score.

### Surface only — do not change scoring

4q exposes `rationale`/`signals` exactly as the analysts already
produce them. It does not alter any analyst, the composite, or weights.
(The Earnings analyst's *quality* is a separate matter — Phase 4v,
sequenced after 4t.)

### Parallelism with 4t

4q is mostly UI plus a small `analyst-runner.ts` / types change. Phase
4t works in `score-at-date.ts` and the backtest path. The one shared
touch-point is `analyst-runner.ts` / `types.ts` — a small additive
field. Low collision risk; if a conflict on `main` appears, stop and
report.

---

# PART VI — RISK REGISTER (CTO + CFO)

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | Carrying `signals` inline bloats every board snapshot | Medium | Snapshot size / cost regression (the 4u problem) | W1 prefers an on-demand per-ticker path; snapshots stay thin. |
| R2 | The no-data state still reads like a real score | Medium | The exact confusion 4q exists to fix | W2 makes `_noData` an explicit, visually distinct state. |
| R3 | `signals` rendered as raw JSON — unreadable | Low–Medium | Feature lands but isn't useful | W2 renders structured key/value detail. |
| R4 | Additive `analyst-runner.ts`/types change conflicts with 4t | Low | Merge friction | Small additive field; stop and report on conflict. |
| R5 | Expandable rows break the 4k desktop docked panel | Low | Desktop regression | W2 tested on both layouts. |

No cost risk.

---

# PART VII — ACCEPTANCE CRITERIA

1. Each analyst's `rationale` and `signals` reach the detail panel
   without materially inflating board snapshots (on-demand path
   preferred; the choice explained).
2. Every CONTRIBUTIONS row in `AnalystContributions.jsx` is expandable
   and shows that analyst's `rationale` + a legible `signals`
   rendering.
3. A no-data analyst (`signals._noData === true`) renders as an
   explicit "no actionable data — <reason>" state, visibly distinct
   from a real neutral score.
4. Works on the mobile detail panel and the Phase 4k docked desktop
   panel.
5. `tsc --noEmit` clean, suite green, `npm run build` clean, with tests
   for the surfaced detail and the no-data rendering.

---

# PART VIII — ROLLOUT PLAN

1. One PR (ready-for-review, not draft) — W1 detail surfacing + W2
   expandable rows + tests. Orchestrator review — the focus is that
   snapshots are not bloated and the no-data state reads honestly.
2. Merge (confirm `merged: True` before branch delete). Netlify
   deploys.
3. ORCHESTRATOR.md updated.

Rollback: a normal revertible PR.

---

# PART IX — OPEN DECISIONS

None for Chad. The one judgment call — on-demand per-ticker fetch vs a
bounded snapshot addition — is an executor decision from the W1
data-flow check, with a standing recommendation (PART IV/V) to prefer
on-demand and keep snapshots lean.

---

*End of brief. Phase 4q turns the ten analyst rows from opaque numbers
into something a user can interrogate — surfacing the `rationale` and
`signals` the engine already produces, and making the difference
between "real neutral" and "no data" unmistakable. It is the
transparency layer under every "why did it score that" question —
including the one that started it. Recommendation: approve; it can run
alongside 4t.*
