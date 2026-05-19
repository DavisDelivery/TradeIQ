# Phase 4q Executor Kickoff — Clickable analyst contribution detail

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a **new, separate** Claude chat. This is its own
> executor agent — not the 4t agent. The GitHub PAT is embedded inline.

---

You are an executor agent. Your single assignment is **Phase 4q** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4q-brief.md` in the
repo, then start with PART 1.

**Scope discipline:** you do Phase 4q and nothing else. Phase 4t is a
*separate* agent running in parallel on its own branch — do not touch
its work, its branch, or the backtest engine. If you find yourself
tempted to scope another phase, stop — that is a different agent's job.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. Its **target board** scores
stocks with a ten-analyst composite; each stock has a detail panel
listing the ten analyst CONTRIBUTIONS rows. Owner: Chad Davis.

## What Phase 4q is (full detail in the brief)

The detail panel shows ten analyst rows — score, direction, weight,
LIVE/NO-DATA badge — but **not why** an analyst scored what it did.
Every analyst already computes a `rationale` string and a `signals`
object (including `_noData` / `_reason` markers), but
`analyst-runner.ts` → `composeTarget` reduces each analyst to
`AnalystContribution = { analyst, score, direction, weight }` and
**discards `rationale` and `signals`.** The drill-down detail is
computed and thrown away.

4q makes each row **expandable** so a user can see that analyst's
reasoning — and makes the no-data case unmistakable.

## The design — DECIDED (do not revisit)

The owner has set these. They are settled:

- **Source: live recompute, session-memoized.** A new endpoint
  `GET /api/target-rationale/:ticker` live-recomputes the ten-analyst
  score for that one ticker on demand and returns the full payload
  **including each analyst's `rationale` and `signals`**. The SPA
  memoizes per ticker for the session (a `useTargetRationale(ticker)`
  hook) so re-opening the same stock does not re-fetch. **Do not add
  this detail to board snapshots** — the on-demand endpoint *is* the
  path; snapshots stay lean (Phase 4u fixed a Firestore-size problem
  caused by exactly that kind of inline bloat).
- **UI: inline accordion.** Each analyst row in
  `AnalystContributions.jsx` gains an open/closed state; tapping it
  expands an inline accordion showing `rationale` + a legible
  `signals` rendering.
- **No-data state: greyed row, italic.** When `signals._noData ===
  true`, the row renders greyed with an italic line:
  `No actionable data — <reason>` (the `_reason`, e.g.
  `no_actionable_data` / `no_data`). It must be visibly distinct from
  a real neutral score — never present the fallback 50 as a real
  assessment.

## Your assignment in one sentence

Add a live per-ticker rationale endpoint, a session-memoized hook, and
an inline accordion on the analyst rows that shows each analyst's
reasoning — with an honest greyed/italic no-data state.

## Disciplines

- **Surface only — do not change scoring.** 4q exposes
  `rationale`/`signals` exactly as the analysts already produce them.
  It does not alter any analyst, the composite, or weights.
  MODEL_VERSION is unchanged.
- **Do not bloat board snapshots** — the on-demand endpoint is the
  path.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4q@tradeiq.local"
git config user.name "Executor 4q"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4q-analyst-rationale-detail
```

If baseline fails, STOP and report. Bump APP_VERSION one patch in
`src/App.jsx`. MODEL_VERSION unchanged — 4q surfaces existing data.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit there.

Read `briefs/phase-4q-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. The recompute
endpoint runs server-side on Netlify, which has the credentials — you
do not need local API keys.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/shared/analyst-runner.ts` — runs the ten analysts,
  assembles `allAnalysts` (each a full `AnalystOutput { score,
  direction, confidence, rationale, signals }`), and via
  `composeTarget` produces thin `AnalystContribution[]` — this is
  where `rationale`/`signals` are dropped. **`allAnalysts` is the
  source of the detail you need.**
- `netlify/functions/analysts/*.ts` + `analysts/core.ts` — the analyst
  implementations. **Read-only — do not modify analyst logic.**
- `netlify/functions/shared/types.ts` — `AnalystContribution`,
  `AnalystOutput`.
- `netlify/functions/target-board.ts`, `ticker-info.ts` — existing
  endpoints; reference for endpoint/handler style and the
  `[[redirects]]` pattern.
- `netlify.toml` — `[[redirects]]` blocks; the new `/api/target-
  rationale/:ticker` route needs one.
- `src/components/AnalystContributions.jsx` — the CONTRIBUTIONS UI you
  extend with the accordion.
- Phase 4k shipped a docked desktop detail panel — the accordion must
  work in **both** mobile and desktop layouts.

## 2.2 Files you ARE allowed to touch

- a new `netlify/functions/target-rationale.ts` (the endpoint)
- `netlify.toml` — the `[[redirects]]` block for the new route
- `netlify/functions/shared/analyst-runner.ts` /
  `shared/types.ts` — ONLY a small additive change if needed to expose
  per-analyst `rationale`+`signals` from the recompute path (e.g. a
  function that returns the full per-analyst payload). Do not change
  scoring.
- `src/components/AnalystContributions.jsx` — the accordion
- a new `src/hooks/useTargetRationale.js(x)` (or co-located) — the
  session-memoized hook
- test files for the above
- `src/App.jsx` — APP_VERSION bump
- `briefs/phase-4q-pr-description.md`
- `ORCHESTRATOR.md` — mark 4q done at the end

## 2.3 Files you may NOT touch

- The analyst scoring logic (`analysts/*.ts`, `analysts/core.ts`), the
  composite, the weights — 4q surfaces, it does not change scoring
- The backtest engine / `score-at-date.ts` / anything Phase 4t touches
  — a separate agent owns it
- Board snapshots / scan functions — do not add detail to snapshots
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

## 2.4 Environment notes

- The new `/api/target-rationale/:ticker` route **needs a matching
  `[[redirects]]` block** in `netlify.toml` — without it the endpoint
  404s in production. Map it one route to the function.
- No browser storage in the SPA — the hook memoizes in React state /
  module-scoped session memory, not localStorage.

---

# PART 3 — THE WORK (order W1 → W2)

## W1 — Live per-ticker rationale endpoint

- New endpoint `GET /api/target-rationale/:ticker` → a new
  `netlify/functions/target-rationale.ts`. It live-recomputes the
  ten-analyst score for that ticker (reuse `analyst-runner.ts`'s
  scoring path) and returns a payload with, **per analyst**: `analyst`,
  `score`, `direction`, `weight`, `rationale`, and `signals` (the full
  structured object, including `_noData` / `_reason`).
- Add the `[[redirects]]` block in `netlify.toml`.
- If `analyst-runner.ts` does not already expose the full per-analyst
  payload via a reusable function, add a small additive one — do not
  change scoring.

## W2 — Accordion UI + session-memoized hook

- `useTargetRationale(ticker)` — a hook that fetches
  `/api/target-rationale/:ticker` and **memoizes per ticker for the
  session** (React state / module-scoped cache; no localStorage) so
  re-opening a stock does not re-fetch.
- `AnalystContributions.jsx` — each analyst row gains an open/closed
  state; tapping toggles an **inline accordion** showing that
  analyst's `rationale` and a legible key/value rendering of `signals`
  (not raw JSON).
- **No-data row:** when `signals._noData === true`, render the row
  greyed with an italic `No actionable data — <reason>` line —
  visibly distinct from a real neutral score.
- Works on the mobile detail panel **and** the Phase 4k docked desktop
  panel.

---

# PART 4 — TESTS

- W1: the endpoint returns per-analyst `rationale` + `signals`,
  including `_noData` payloads; mock the data layer, no network.
- W2: a row expands; a `_noData` analyst renders the greyed/italic
  no-data state.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One PR, ready-for-review (not draft). One commit per workstream +
  tests.
- APP_VERSION bumped one patch. MODEL_VERSION unchanged.
- `strict: true` TypeScript; React per the existing SPA style.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4q-analyst-rationale-detail
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4q - clickable analyst contribution detail",
    "head": "phase-4q-analyst-rationale-detail",
    "base": "main",
    "body": "See briefs/phase-4q-brief.md. Adds GET /api/target-rationale/:ticker (live recompute, per-analyst rationale+signals), a session-memoized useTargetRationale hook, and an inline accordion on the analyst rows with an honest greyed/italic no-data state. Surface-only; MODEL_VERSION unchanged."
  }'
```

**Open the PR ready-for-review, NOT a draft.**

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PHASE 4q — PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

W1 — endpoint:
- GET /api/target-rationale/:ticker — live recompute; returns
  per-analyst score/direction/weight/rationale/signals
- netlify.toml redirect added

W2 — UI:
- AnalystContributions.jsx inline accordion; useTargetRationale hook
  (session-memoized)
- no-data row: greyed + italic "No actionable data — <reason>"
- verified on mobile + 4k desktop docked panel

Verification:
- tsc --noEmit: clean / npm test: <N> (was <baseline>) / build: clean

Acceptance: DEFERRED to orchestrator review + merge.
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Adding the detail to board snapshots** — the on-demand endpoint is
  the path; snapshots stay lean (the Phase 4u lesson).
- **Changing analyst scoring** — 4q surfaces only.
- **A no-data row that reads like a real score** — it must be greyed +
  italic and explicit.
- **Forgetting the `netlify.toml` redirect** — the endpoint 404s
  without it.
- **Touching Phase 4t's files** (the backtest engine /
  `score-at-date.ts`) — a separate agent owns that.
- **Opening the PR as a draft.**

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4q of the TradeIQ project at
DavisDelivery/TradeIQ. This is its own phase — you do 4q only; Phase 4t
is a separate agent running in parallel, do not touch its work.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4q-executor.md — that's your full assignment —
   then read briefs/phase-4q-brief.md.

Everything you need is in those two files. Phase 4q makes each analyst
CONTRIBUTIONS row in the target-board detail panel expandable to show
WHY it scored what it did. The data already exists — every analyst
computes a `rationale` + `signals` object (incl. `_noData`/`_reason`
markers) but analyst-runner.ts drops them when building the thin
AnalystContribution. The design is DECIDED (do not revisit): W1 add a
new endpoint GET /api/target-rationale/:ticker that live-recomputes the
ten-analyst score for one ticker and returns per-analyst
score/direction/weight/rationale/signals — and add its [[redirects]]
block in netlify.toml; do NOT add this detail to board snapshots (the
on-demand endpoint IS the path — snapshots stay lean, the Phase 4u
lesson). W2 a session-memoized useTargetRationale(ticker) hook + an
inline accordion in AnalystContributions.jsx — tapping a row expands
rationale + a legible signals rendering; the no-data state
(signals._noData === true) renders as a greyed row with an italic "No
actionable data — <reason>" line, visibly distinct from a real score;
works on mobile + the Phase 4k desktop docked panel. Surface-only —
do NOT change any analyst, the composite, or weights; MODEL_VERSION
unchanged. If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ. Open the PR ready-for-review, not a draft. Start
with PART 1 once you've read both. ~3-4 hour session.
