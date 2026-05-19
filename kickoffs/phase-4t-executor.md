# Phase 4t Executor Kickoff — Multi-factor composite edge validation

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your assignment is **Phase 4t** of the
TradeIQ project — the most important measurement in the project. The
conversation you are reading is your boot prompt. Read it end-to-end,
then read `briefs/phase-4t-brief.md` in the repo (full rationale +
architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app` — a React/Vite SPA backed by
TypeScript Netlify functions and Firestore. Its **target board** scores
stocks with a ten-analyst composite (Technical, Sector, Fundamental,
Flow, News, Earnings, Macro, Insider, Patents, Political), producing a
0–100 composite and a long/short direction. It has a backtest engine
that runs strategies against historical data on a checkpoint-resume
background-function pattern. Owner: Chad Davis.

## What Phase 4t is (full detail in the brief)

The owner wants a multi-factor strategy with **an edge he can trust** —
one that flags stocks with a high probability of going up *or* down,
across the S&P 500 and the Russell 2000. That model already exists: it
is the target board's ten-analyst composite. What does **not** exist is
any evidence it works. The composite was miscomputed until Phase 4s
(fixed it), and it has **never been backtested**. The Prophet portfolio
backtest used a *separate* scorer and says nothing about the target
board.

Phase 4t answers the open question: **does the ten-analyst composite
have a real, out-of-sample edge?** You will extend the backtest engine
to score the full composite point-in-time, backtest it on the S&P 500
and the Russell 2000 separately, and decompose which factors carry the
edge.

## Your assignment in one sentence

Build a point-in-time scoring path for the ten-analyst composite,
backtest it honestly and out-of-sample on sp500 and russell2k, attribute
the edge to factors, and write a verdict — which is allowed to be
negative.

## The decision already made (do not revisit)

- **Backtest window: `2018-01-31` to `2024-12-31`** — the same span the
  existing infrastructure, Prophet, and the Williams/Lynch runs use.
  This makes the composite's result directly comparable and the cache
  already covers it. This is settled; use this window.

## The disciplines that are NOT optional

- **4t MEASURES — it does not TUNE.** Backtest the composite exactly as
  Phase 4s left it. Do **not** optimize any parameter against the
  backtest. A number tuned toward is not evidence. If the measurement
  shows the composite needs improvement, that is a *future* phase — not
  this one.
- **Look-ahead bias is the enemy, and it must be audited per factor.**
  Each of the ten analysts draws on different data with different
  point-in-time integrity. W1's first task is an honest per-factor PIT
  audit. A factor that cannot be scored honestly point-in-time must be
  **excluded or caveated — never faked.** Faking PIT for a hard factor
  is a *negative* deliverable.
- **The verdict may be negative or partial — report it honestly.** "No
  reliable edge," "edge on sp500 only," "the edge is three factors" —
  any of these is the honest deliverable if the data shows it. Do not
  dress up a weak result. (Phase 4r already found Williams and Lynch
  NOT VALIDATED — honest negative findings are normal and valuable
  here.)

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4t@tradeiq.local"
git config user.name "Executor 4t"

npm ci    # if it fails on cross-platform optional deps, fall back to: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4t-composite-edge-validation
```

If baseline fails, STOP and report. Bump APP_VERSION one patch in
`src/App.jsx`. MODEL_VERSION unchanged — 4t measures the composite, it
does not change it.

**Environment note:** if commits fail from `/home/claude/TradeIQ`, the
signing server may expect commits from `/home/user/TradeIQ` (or a
`/tmp` path) — relocate the repo and commit there.

Read `briefs/phase-4t-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL. Backtests run
**server-side on Netlify**, which has the Firebase/Polygon/Finnhub
credentials — you fire runs by `curl`-ing trigger endpoints and poll
the status endpoints. You do not need local API keys.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/shared/analyst-runner.ts` — the ten-analyst
  composite (corrected by Phase 4s: directional `signed = score-50`,
  conflict-aware tier/dampening). This is what 4t validates.
- `netlify/functions/analysts/*.ts` — the ten analyst implementations;
  each computes a 0–100 bullishness score from its own data sources.
- `netlify/functions/shared/backtest/score-at-date.ts` — the
  point-in-time scoring path. Has PIT scoring for **prophet** and (from
  Phase 4r W2) for **williams / lynch** styles. **It does not yet have
  a PIT path for the ten-analyst composite (`board: 'target'`) — W1
  builds that.**
- `netlify/functions/backtest-runs-trigger.ts` — `/api/backtest-runs/
  start`; `SUPPORTED_BOARDS = ['prophet','williams','lynch']`. `target`
  is currently blocked at 400 — **W1 adds `target` once its PIT path is
  built and audited.**
- `netlify/functions/shared/backtest/engine-batched.ts`,
  `run-backtest-background.ts` — the backtest engine + worker. Phase 4u
  bounded the checkpoint cursor — large runs (the russell2k composite)
  now checkpoint safely.
- `netlify/functions/backtest-runs-list.ts` /
  `backtest-runs-get.ts` — run status; `/api/backtest-runs?
  includeIncomplete=1` surfaces failed/running runs (Phase 4u W2).
- `reports/phase-4n/pit-integrity-attestation.md` — the precedent for
  honestly classifying point-in-time data integrity per factor; the
  Williams/Lynch PIT work is your pattern to extend.
- `configs/williams-sp500-2018-2024-weekly-top20.json`,
  `lynch-sp500-2018-2024-quarterly-top20.json` — config shape
  reference for the runs you will create.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/backtest/score-at-date.ts` — the new PIT
  composite path
- `netlify/functions/backtest-runs-trigger.ts` — add `target` to
  `SUPPORTED_BOARDS` once W1's PIT path exists
- `netlify/functions/analysts/*.ts` — **read-only for understanding;**
  edit ONLY if a genuine point-in-time accessor is required and it does
  not change the analyst's scoring logic — and flag any such change
  loudly in the hand-off
- `configs/` — new 4t backtest config files
- test files for the above
- `src/App.jsx` — APP_VERSION bump
- `reports/phase-4t/pit-audit.md`, `verdict.md`, `verification.md`
- `briefs/phase-4t-pr-description.md`
- `ORCHESTRATOR.md` — mark 4t done at the end

## 2.3 Files you may NOT touch

- The composite scoring math in `analyst-runner.ts` — Phase 4s fixed
  it; 4t **measures** it, does not change it
- The analysts' scoring logic — 4t does not tune factors
- Prophet and its portfolio code — a separate scorer; out of scope
- The reinvoke / cursor code (`shared/backtest-resume/*`,
  `engine-batched.ts` cursor shape) — Phases 4r-W1b and 4u own it
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

## 2.4 Environment notes

- Any new `/api/` route needs a matching `[[redirects]]` block in
  `netlify.toml`.
- Any new Firestore query shape may need a composite index in
  `firestore.indexes.json` — a `FAILED_PRECONDITION` at runtime is the
  symptom.
- The Phase 4u cursor fix means the russell2k composite run
  (~2,000 tickers) checkpoints safely — but it is still a long run;
  expect many invocations.

---

# PART 3 — THE WORK (order W1 → ship + verify → W2 → W3)

W1 ships as its own PR and is verified before W2/W3 — the analysis is
only as honest as the scoring path under it.

## W1 — Point-in-time scoring path for the ten-analyst composite

1. **Per-factor PIT audit FIRST.** For each of the ten analysts,
   determine: can it be scored *as of a historical date* without
   look-ahead, and from what data? Point-in-time integrity differs by
   factor — price bars (Technical, Flow) are PIT-clean; fundamentals
   (Fundamental, Earnings) carry restatement risk; news (News) needs
   news timestamped on/before the as-of date; insider data is keyed to
   filing dates; Macro/Sector/Political/Patents each have their own
   as-of question. Classify every factor **PIT-clean / PIT-with-caveat
   / not-PIT-able** in `reports/phase-4t/pit-audit.md`.
2. **Build the path.** Extend `score-at-date.ts` so it can compute the
   full ten-analyst composite as of a historical date — the equivalent
   of the prophet/williams/lynch PIT paths, for `board: 'target'`. No
   look-ahead in any PIT-clean factor; excluded/caveated handling for
   the rest. A factor that cannot be scored honestly is **excluded or
   caveated — never faked.**
3. **Enable the board.** Add `target` to `SUPPORTED_BOARDS` in
   `backtest-runs-trigger.ts` once the PIT path exists.
4. **W1 ships as its own PR** — the PIT path + the audit. Orchestrator
   reviews the audit's honesty and spot-checks the path, merges,
   verifies, before W2/W3.

## W2 — Backtest the composite, out-of-sample, both universes

- Backtest the ten-analyst composite on **`sp500` and `russell2k`
  separately** — window **2018-01-31 → 2024-12-31**.
- Test **both tails**: do high-composite stocks out-perform AND do
  low-composite stocks under-perform? The composite's value as a
  winner/loser flag depends on both.
- **Measurement, not optimization** — backtest the composite as-is. Do
  not tune. Where a parameter must be chosen (e.g. holding horizon),
  report results at a small set of standard fixed horizons, not the
  flattering one.
- Report: forward return by composite decile/tier, hit rate, Sharpe,
  max drawdown, and **rolling-window consistency** (a flattering
  full-window number can hide period-to-period inconsistency — the
  4e-1 rolling test is the precedent). Benchmark: **SPY for sp500, the
  Russell 2000 index / IWM for russell2k.**

## W3 — Factor attribution + honest verdict

- **Decompose the edge.** Leave-one-out / ablation runs (or a
  per-factor information measure) ranking each of the ten analysts'
  contribution — which factors carry the edge, which are noise, which
  may hurt.
- **The verdict** — `reports/phase-4t/verdict.md` — does the composite
  have an edge worth trusting? Stated plainly: the large-cap vs
  small-cap split, the per-factor attribution, the rolling-window
  consistency, and every PIT caveat from W1. **A negative or partial
  verdict is the honest deliverable if that is what the data shows.**

---

# PART 4 — TESTS

- W1: tests for the PIT composite path — no look-ahead in PIT-clean
  factors; correct excluded/caveated handling.
- Mock data sources / Firestore; no network in unit tests.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- W1 is its own PR. W2/W3 may be a second PR (report-heavy) or
  orchestrator-driven runs — coordinate via the hand-off.
- APP_VERSION bumped one patch. MODEL_VERSION unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- All PRs ready-for-review, **not draft**.

---

# PART 6 — PR + ACCEPTANCE

W1 PR:

```bash
git push -u origin phase-4t-composite-edge-validation
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4t W1 - point-in-time scoring path for the ten-analyst composite",
    "head": "phase-4t-composite-edge-validation",
    "base": "main",
    "body": "See briefs/phase-4t-brief.md PART IV W1 and reports/phase-4t/pit-audit.md. Adds a point-in-time scoring path for the full ten-analyst composite to the backtest engine, with an honest per-factor PIT-integrity audit. Enables board=target for backtests."
  }'
```

**Open every PR ready-for-review, NOT a draft.**

Post-W1-merge, the orchestrator verifies, then W2/W3 proceed (the
russell2k composite run is long — the Phase 4u cursor fix makes it
safe). The verdict is reviewed with the owner.

---

# PART 7 — HAND-OFF FORMAT

After W1, post:

```
PHASE 4t W1 — PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Per-factor PIT audit (reports/phase-4t/pit-audit.md):
- PIT-clean:        <factors>
- PIT-with-caveat:  <factors + the caveat>
- not-PIT-able:     <factors + why; excluded or caveated>

PIT composite path:
- <how board=target is scored as-of-date; what's excluded/caveated>
- backtest-runs-trigger: target added to SUPPORTED_BOARDS

Verification:
- tsc --noEmit: clean / npm test: <N> (was <baseline>) / build: clean

Acceptance: DEFERRED — orchestrator review + merge; W2/W3 follow.
```

After W2/W3, post the backtest metrics (sp500 + russell2k separately,
both tails, rolling consistency), the factor attribution ranking, and
the plain-words verdict.

---

# PART 8 — FAILURE MODES TO AVOID

- **Tuning the composite against the backtest.** 4t measures. A tuned
  number is not evidence.
- **Faking point-in-time data** for a hard factor (news, fundamentals)
  — exclude or caveat it honestly instead.
- **Blending sp500 and russell2k** — validate them separately.
- **Reporting only the flattering full-window number** — rolling-window
  consistency is required.
- **Dressing up a weak verdict** — a negative or partial result,
  honestly reported, is the deliverable.
- **Changing the composite or the analysts' scoring logic** — out of
  scope; Phase 4s owns the composite.
- **Adding new factors** (e.g. contracts) — out of scope; 4t validates
  the existing ten.
- **Opening a PR as a draft.**

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4t of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4t-executor.md — that's your full assignment —
   then read briefs/phase-4t-brief.md for the full rationale.

Everything you need is in those two files. Phase 4t answers the most
important question in the project: does TradeIQ's target board —
the ten-analyst composite (technical, fundamental, news, insider, and
six more) — actually have a real, out-of-sample edge? It has never been
backtested; the composite was only just fixed (Phase 4s). W1 build a
point-in-time scoring path for the full ten-analyst composite in the
backtest engine, with a mandatory honest per-factor PIT-integrity audit
(reports/phase-4t/pit-audit.md) — every factor classified PIT-clean /
PIT-with-caveat / not-PIT-able; a factor that can't be scored honestly
point-in-time is excluded or caveated, NEVER faked; then add `target`
to SUPPORTED_BOARDS. W1 ships as its own PR. W2 backtest the composite
OUT-OF-SAMPLE on sp500 and russell2k SEPARATELY (window 2018-01-31 to
2024-12-31), both tails (high AND low composite), standard fixed
horizons, rolling-window consistency, benchmark SPY / Russell-2000. W3
factor attribution (leave-one-out — which of the ten carry the edge) +
an honest verdict (reports/phase-4t/verdict.md) that may be negative or
partial. CORE DISCIPLINE: 4t MEASURES, it does not TUNE — never
optimize a parameter against the backtest; and the verdict is allowed
to come back negative — report it honestly (Phase 4r already found
Williams and Lynch NOT VALIDATED; honest negatives are normal here).
Backtests run server-side on Netlify (it has the credentials) — fire
via curl, poll the status endpoints; the Phase 4u cursor fix makes the
big russell2k run safe. If commits fail from /home/claude/TradeIQ,
relocate to /home/user/TradeIQ. Open all PRs ready-for-review, not
drafts. Start with PART 1 once you've read both. Substantial multi-part
phase, ~5-8 hours.
