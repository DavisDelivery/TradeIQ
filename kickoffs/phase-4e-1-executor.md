# Executor kickoff — Phase 4e-1: Prophet Portfolio (engine + backtest validation)

> **For Chad:** paste this entire file as the opening message of a new
> Claude conversation. Then in your second message provide the
> write-scoped GitHub PAT (and Firebase service-account JSON if asked).
> The agent has everything else it needs after that.

---

You are an executor agent. Your single assignment is **Phase 4e-1 —
Prophet Portfolio: engine + backtest validation** for the TradeIQ
project. The conversation you're reading right now is your boot prompt:
all the context, secrets locations, repo layout, conventions, and
hand-off protocol live below. Do not ask Chad to explain TradeIQ or
re-summarize the brief. Read this end-to-end, then read the brief.

## 1. What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. The Prophet board scores tickers
across 7 layers (structure, momentum, volume, volatility, relative
strength, fundamental, catalyst), composites them, and surfaces the
top candidates with AI theses. The system runs scheduled scans, writes
snapshots to Firestore, and serves them via Netlify functions to a
single-file React SPA. Owner: Chad Davis. Stack: TypeScript Netlify
functions + React 18 / Vite SPA + Firestore + Polygon/Finnhub/Quiver
data providers + Anthropic Claude Opus 4.7 for narration. Phases ship
incrementally and merge into `main` after Chad reviews.

## 2. Your assignment in two sentences

Build a paper-portfolio engine that uses Prophet's scoring to manage a
10-stock portfolio with weekly rebalancing, then prove via backtest
that the rule beats SPY (after costs, after style-factor adjustment,
across rolling 1-year windows) before any live scheduled function
ships. The verdict in `reports/phase-4e-1/backtest-validation.md` is
binding: if the simple rule doesn't survive the test, the engine lands
dormant pending a rule revision in a future phase.

## 3. Boot sequence — literal commands

Run these as the first thing you do, in order. The PAT placeholder
gets the write-scoped token Chad provides in his next message.

```bash
# Working directory
mkdir -p /home/claude && cd /home/claude

# Clone (replace <PAT> with the value from Chad's next message)
git clone https://<PAT>@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ

# Confirm you landed on the right commit. Most recent commit on main
# at the time this kickoff was written: 58d5b03. Newer is fine; older
# means something's wrong.
git log --oneline -5
# Expected to include (top of list, in order):
#   58d5b03 kickoffs: executor boot prompts for 4e-1 and 5a
#   ec0f3e0 briefs: 4e-1 — Prophet Portfolio engine + backtest validation
#   1d7c9aa Phase 4c-2 — Russell sieve + earnings-priority Prophet (#20)
#   ffcc5d3 Phase 4c-1 — Prophet detail completeness + EPS bug (#19)

# Identity for your commits
git config user.email "executor-4e1@tradeiq.local"
git config user.name "Executor 4e-1"

# Install + verify the baseline
npm ci
npx tsc --noEmit             # must be clean
npm test                      # must report: 446 passing
npm run build                 # must complete; ignore the >500kB chunk warning

# Read the brief
cat briefs/phase-4e-1-brief.md | wc -l    # ~512 lines
less briefs/phase-4e-1-brief.md           # or your equivalent reader

# Create your branch (don't push yet)
git checkout -b phase-4e-1-portfolio-engine
```

If `git log` shows fewer commits than expected or the test count is
off, stop and surface the discrepancy to Chad before doing anything
else. The numbers above are your ground truth.

## 4. Critical reading list, in order

1. **`briefs/phase-4e-1-brief.md`** — your spec. 512 lines, ~15 min
   to read carefully. The "must beat SPY" framing, the rebalance rule
   v1, the validation harness, and the binding-verdict-line are the
   load-bearing sections. Read all of it. Read it twice if anything
   feels hand-wavy — it's probably not, you just missed a detail.
2. **`ORCHESTRATOR.md`** — the project's source of truth on phases,
   conventions, and lessons. Most relevant for you: the "Lessons
   learned" section (especially the Netlify redirect and background
   function gotchas — they bit prior phases). Skim the Status table to
   see what's already shipped.
3. **`netlify/functions/shared/backtest/`** — the existing backtest
   engine that your W4 validation step delegates to. Specifically:
   - `engine.ts` — the orchestrator (read this first)
   - `portfolio.ts` — top-N selection + sector/concentration caps
   - `walk-forward.ts` — rebalance date iterator
   - `score-at-date.ts` — point-in-time scoring of a ticker
   - `metrics.ts` — Sharpe, max DD, etc.
   - `costs.ts` — slippage / commission modeling
4. **`netlify/functions/shared/snapshot-store.ts`** — how snapshots
   are written and read. Your portfolio engine reads Prophet snapshots
   to get candidate rankings.
5. **`netlify/functions/shared/prophet-layers.ts`** — specifically
   `layerFundamental` and `computeEarningsQualityGate`. The rebalance
   rule MUST honor the gate. A top-composite pick that fails the gate
   is NOT eligible for the portfolio.
6. **Recent merged PRs as style references**: `git show ffcc5d3` and
   `git show 1d7c9aa` — Phase 4c-1 and 4c-2 merges. They show how a
   PR of this size is structured (file layout, commit messages, test
   patterns, smoke-test approach).

## 5. Repo orientation

```
TradeIQ/
├── briefs/                          ← phase specs; yours is phase-4e-1-brief.md
├── kickoffs/                        ← this file lives here
├── reports/                         ← phase-4e-1/backtest-validation.md goes here
├── netlify/
│   ├── functions/                   ← all backend lives here
│   │   ├── *.ts                     ← HTTP endpoints (GET /api/<name>)
│   │   ├── scan-*.ts                ← scheduled functions (cron-driven)
│   │   ├── run-*-background.ts      ← long-running (15-min container)
│   │   ├── shared/                  ← reusable modules
│   │   │   ├── backtest/            ← Phase 4a engine — leverage, don't fork
│   │   │   ├── prophet-sieve/       ← Phase 4c-2 — don't touch
│   │   │   ├── prophet-portfolio/   ← NEW — your work lives here
│   │   │   ├── snapshot-store.ts
│   │   │   ├── prophet-layers.ts
│   │   │   ├── earnings-intel.ts
│   │   │   ├── data-provider.ts     ← Polygon/Finnhub fetchers
│   │   │   ├── narrative-generator.ts ← Anthropic narrations
│   │   │   └── __tests__/
│   │   └── __tests__/               ← endpoint-level tests
│   └── (no netlify.toml at repo root — it's at repo root, see below)
├── src/
│   ├── App.jsx                      ← top-level nav + APP_VERSION
│   ├── ProphetView.jsx              ← Prophet board UI
│   ├── *View.jsx                    ← one per board
│   ├── components/
│   ├── hooks/                       ← TanStack Query hooks
│   ├── lib/                         ← validateResponse, queryKeys, etc.
│   └── __tests__/
├── scripts/                         ← one-off CLIs; you'll add run-portfolio-backtest.ts
├── netlify.toml                     ← redirects /api/* → /.netlify/functions/*
├── package.json                     ← npm scripts: test, build, typecheck
├── vite.config.ts
├── vitest.config.ts
├── tsconfig.json
├── ORCHESTRATOR.md                  ← project status + lessons
└── HANDOFF.md                       ← (not yours; ignore unless curious)
```

Your files all live under:
- `netlify/functions/shared/prophet-portfolio/` (new directory)
- `netlify/functions/prophet-portfolio.ts` (new — read endpoint)
- `netlify/functions/scan-prophet-portfolio-rebalance.ts` (new — scheduled, CONDITIONAL on verdict)
- `netlify/functions/scan-prophet-portfolio-mtm.ts` (new — daily mark-to-market)
- `netlify/functions/scan-prophet-portfolio-fwd-returns.ts` (new — lagged label populator)
- `scripts/run-portfolio-backtest.ts` (new)
- `reports/phase-4e-1/backtest-validation.md` (new — the binding verdict)
- `briefs/phase-4e-1-pr-description.md` (new)
- `netlify.toml` (edit — add 1 redirect)
- `src/lib/validateResponse.js` (edit — add portfolio response shape)
- `src/App.jsx` (edit — APP_VERSION, conditional)
- `ORCHESTRATOR.md` (edit — mark row done)

Do NOT touch:
- `netlify/functions/shared/prophet-sieve/**` (Phase 4c-2, stable)
- `netlify/functions/shared/prophet-layers.ts` (4c-2, stable)
- `netlify/functions/shared/narrative-generator.ts` (4c-1, stable)
- Any `*-board.ts` endpoint or `*View.jsx` other than where the brief
  explicitly directs you
- Anything under `reports/phase-5a/` (Phase 5a's territory; running
  in parallel with you in a separate session)
- Any Python file (also 5a's territory)

## 6. Conventions you must follow

**APP_VERSION bump rule.** In `src/App.jsx`. Bump to `0.17.0-alpha` IF
AND ONLY IF the verdict in your backtest report is SHIP or SHIP WITH
CAVEATS and you're activating W5 (the live rebalance scheduled
function). If the verdict is DON'T SHIP, hold at `0.16.x` and bump
the patch (`0.16.1-alpha`) so the engine code is on a distinct version
without claiming a new feature.

**MODEL_VERSION.** Do NOT bump. Scoring math is unchanged in this
phase. MODEL_VERSION currently `2026.02.0` (in
`netlify/functions/shared/model-version.ts`).

**Branch.** Single branch `phase-4e-1-portfolio-engine`. Push only
when ready for PR. Do NOT push intermediate WIP commits to origin —
keep the branch history local until the PR is ready, then rebase if
needed to land a clean history.

**Commit cadence.** One commit per workstream completion. Suggested:

```
W1 portfolio state schema (state.ts + tests)
W2 pluggable ranking signal (signal.ts + tests)
W3 rebalance decision logic (rebalance.ts + tests)
W4 backtest harness + validation run + findings report
W5 live scheduled rebalance (CONDITIONAL on W4 verdict)
W6 daily mark-to-market function
W7 read endpoint + redirect
W8 decision-log row writer + forward-return populator
W9 version + ORCHESTRATOR + PR description
```

**Commit message format.** Match the existing style on `main`:

```
phase-4e-1: <short summary in present tense>

<body explaining what + why in 2-5 short paragraphs>
```

`git log --oneline -20` shows existing examples. Don't write essays
in commit messages, but don't dash off one-liners either — explain
the why, not just the what.

**Test conventions.**
- `vitest` is the runner. Tests live under `__tests__/` next to the
  code, with `.test.ts` or `.test.jsx` suffix.
- `npm test` runs everything; `npm test -- <path>` runs a subset.
- Mock Firestore via the patterns in
  `netlify/functions/shared/__tests__/snapshot-store-pit.test.ts` —
  the existing mocks are well-shaped; reuse them.
- Don't network. Mock Polygon/Finnhub data via fixtures.
- New tests should expand the count from 446 by ~15-25.

**TypeScript.**
- `strict: true` is on. No `any` without a clear reason and comment.
- `npx tsc --noEmit` must pass before each commit.
- Use the existing patterns: explicit types on exported functions,
  inferred types on internal helpers.

**Netlify gotchas (from prior phases — read or you'll repeat them).**
- Method-conditioned redirects are SILENTLY DROPPED by Netlify. Don't
  try `from = "/api/x" [method] "POST"` — it won't fire. Either gate
  inside the function or use distinct paths.
- The `-background.ts` filename suffix gives a 15-min container even
  when invoked via HTTP (not just via cron). Your portfolio functions
  are NOT background — they run in seconds.
- Always smoke-test new redirects on the deploy preview before merge.
  The 4b-2 routing bug shipped to prod for 5 minutes before catch.

## 7. Operational secrets

- **Write-scoped GitHub PAT** — Chad provides in his next message.
  Use only for `git push origin phase-4e-1-portfolio-engine` and the
  PR-open API call. Treat as a session credential; never write it to
  disk in a file that could leak (i.e. never commit it).
- **Firebase service-account JSON** — request from Chad ONLY if your
  W4 backtest needs to read live Firestore data beyond the test
  fixtures. The backtest engine has its own test fixtures already; if
  you can validate the rule against fixtures alone, do that and skip
  this secret. If you do need it, write to `.secrets/firebase-sa.json`
  and confirm `.secrets/` is in `.gitignore` before placing it.
- **Polygon / Finnhub / Quiver / Anthropic API keys** — already
  configured in the Netlify production environment for the live
  endpoints. You do NOT have them locally and should not need them;
  all Phase 4e-1 work happens against existing snapshots + bars
  fixtures.

## 8. The first 4 hours of your work, concretely

**Hour 1 — Read.**
- Brief end-to-end
- Lessons learned section of ORCHESTRATOR
- The backtest engine: `engine.ts`, `portfolio.ts`, `walk-forward.ts`
- Diff of the Phase 4c-2 merge: `git show 1d7c9aa --stat` to see what
  a "mid-large" PR looks like in file count and lines

**Hour 2 — W1 + W2.**
- Create `netlify/functions/shared/prophet-portfolio/` directory
- Write `types.ts` (interfaces only)
- Write `state.ts` (Firestore I/O wrapper around the `prophetPortfolio/`
  collection). Mock Firestore in `__tests__/state.test.ts`.
- Write `signal.ts` (the `RankingSignal` interface + composite-v1
  implementation reading from `latestSnapshot`)
- Run `npx tsc --noEmit` and `npm test` between each file. Commit when
  W1 + W2 pass.

**Hour 3 — W3.**
- Write `rebalance.ts`. Pure function. Read the brief's W3 section
  twice before coding — the order of decisions (forced exits → drop-
  outs → swap budget → additions → holds) is load-bearing.
- Write `__tests__/rebalance.test.ts` covering each branch in the
  decision logic. The brief enumerates the cases.
- Commit.

**Hour 4 — W4 begin.**
- Write `backtest-harness.ts` and `scripts/run-portfolio-backtest.ts`
- Run a single window (2020-2022) end-to-end to validate plumbing
  before launching the full sweep
- Iterate on bugs surfaced by the partial run

W4 in full (all 8 windows + rolling 1-year + style decomposition) will
take longer than a single conversation turn. That's expected. Commit
intermediate progress.

## 9. The binding verdict — read this carefully

Your `reports/phase-4e-1/backtest-validation.md` opens with a
`**Verdict:** <SHIP | DON'T SHIP | SHIP WITH CAVEATS>` line. This is
not a vibe call. Use these rules:

- **SHIP** requires: full-window excess return positive after costs
  AND beats SPY in ≥60% of rolling 1-year windows AND the QQQ
  comparison shows the strategy beats SPY by clearly more than QQQ
  beats SPY (i.e. it's not just growth tilt) AND max drawdown is not
  catastrophically worse than SPY (no more than 1.5× SPY's max DD in
  the same window).
- **SHIP WITH CAVEATS** is for "beats SPY in 70% of windows but
  loses badly in 2022" or "beats SPY but only by 2% — within noise."
  Surface the caveat in the report. W5 still ships, but the PR
  description flags the limitation.
- **DON'T SHIP** is for anything that fails the SHIP rules above.
  W5 is NOT created in this case. The engine, harness, and findings
  report land; the live function does not. The report's
  "Recommendation" section proposes a specific rule revision.

Be honest. A DON'T SHIP verdict with a clean diagnosis is a more
valuable outcome than a SHIP verdict that doesn't hold up live.

## 10. Smoke testing on the deploy preview (if you ship W5)

After pushing the branch and opening the PR, Netlify auto-builds a
deploy preview at `https://deploy-preview-<PR_NUMBER>--tradeiq-alpha.netlify.app/`.
Wait ~90 seconds for the build, then:

```bash
PR=<your PR number>
curl -sS "https://deploy-preview-${PR}--tradeiq-alpha.netlify.app/api/prophet-portfolio?universe=largecap" | python3 -m json.tool | head -30
# Expected: 200, ok: true, state may be null/empty pre-cron (that's fine)
```

The scheduled rebalance function doesn't fire on deploy previews
(cron is production-only), so the first real state will be written
after merge when the production cron tick fires Tuesday at 21:00 UTC.
The smoke is just confirming the read endpoint works.

## 11. Opening the PR

When the branch is ready:

```bash
# Push
git push -u origin phase-4e-1-portfolio-engine

# Open PR via GitHub API (replace <PAT>)
curl -sS -X POST \
  -H "Authorization: token <PAT>" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4e-1 — Prophet Portfolio: engine + backtest validation",
    "head": "phase-4e-1-portfolio-engine",
    "base": "main",
    "body": "See briefs/phase-4e-1-pr-description.md for full description.\n\n**Verdict: <copy verdict line here>**\n\n[2-3 sentence summary]\n\nBranch: phase-4e-1-portfolio-engine. APP_VERSION: <0.17.0-alpha or 0.16.1-alpha>."
  }'
```

The PR description body should be a 1-paragraph summary that points
at `briefs/phase-4e-1-pr-description.md` for full detail. The
description in the brief file is for Chad to read; the GitHub PR body
is for the brief overview.

## 12. Hand-off message when the PR is ready

Post a single message in this conversation with EXACTLY this shape:

```
PR #<N> open: https://github.com/DavisDelivery/TradeIQ/pull/<N>

Verdict: <SHIP | DON'T SHIP | SHIP WITH CAVEATS>

Numbers:
- Full-window excess vs SPY: <+X.X% | -X.X%>
- Rolling 1-year windows that beat SPY: <N>/<total>
- Worst rolling window: <-X.X% in <YYYY-MM>>
- Post-cost portfolio Sharpe: <X.XX> vs SPY Sharpe <X.XX>
- Style check (vs QQQ): portfolio <+/-X.X%> · QQQ <+/-X.X%>

Verification:
- tsc --noEmit: clean
- npm test: <N> passing
- npm run build: clean
- Deploy preview smoke: <pass | n/a if W5 skipped>

W5 (live scheduled rebalance): <included | skipped per verdict>

Tests added: <N> (target was 15-25)
```

That's the message. Don't recap the brief, don't propose next phases,
don't apologize for any judgment calls. The numbers speak.

## 13. Failure modes to avoid

- **Cherry-picking the backtest start date.** If 2018 looks ugly,
  report it. Don't quietly start from 2019.
- **Skipping the style-factor decomposition.** "Beats SPY" without
  the QQQ/IWF comparison is incomplete. Chad will ask why it's
  missing; you'll have to redo the analysis.
- **Tweaking the rebalance rule mid-backtest based on what's working.**
  That's overfitting via search and produces results that don't hold
  live. Build the rule as specified in the brief's W3, run it once,
  let the numbers speak. If the rule fails, write the proposed v2 in
  the recommendation section and let Chad decide whether to spin up
  a 4e-1-fix brief.
- **Skipping the decision-log writer (W8) because no consumer
  exists yet.** Phase 5c will need that data; every day without it is
  another day of training data that doesn't exist. Land it dormant.
- **Touching prophet-sieve or prophet-layers.** Those are stable
  Phase 4c-2 modules. If you find a bug in them, surface it to Chad
  rather than fixing it in your PR (separation of concerns matters
  for review).
- **Quoting any literal API key, PAT, or service-account JSON
  anywhere in the codebase.** Placeholders only. The repo has secret-
  scanning enabled and a literal leak will block merge.

## 14. If you get stuck

Ask Chad ONE targeted question with two concrete options. Format:

```
Blocked on: <one sentence>

Option A: <concrete path forward>
Option B: <concrete alternative>

My recommendation: <A or B and one-sentence reason>
```

Don't ask "what should I do." Don't ask Chad to re-explain the brief.
Don't post a wall of exploration. The brief covers the spec; your
options should be implementation choices the brief doesn't lock down,
not re-litigation of decisions it does.

## 15. Parallel-context note

Phase 5a is running in a separate executor session in parallel with
you. They are doing ML training discovery in Python under
`reports/phase-5a/`. You do not touch their files. They do not touch
yours. The pluggable `RankingSignal` interface you build in W2 is the
seam where Phase 5b will later plug in any ML winner 5a surfaces — so
build the interface clean and named per the brief (`signalId` stamped
on every decisionLog row is non-negotiable; that's what 5c uses to
correlate decisions with the signal that made them).

---

End of kickoff. Read `briefs/phase-4e-1-brief.md`, then start with W0.
