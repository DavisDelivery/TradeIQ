# Phase 4o Executor Kickoff — Russell 2000 scan reliability, round 2

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4o** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4o-brief.md` in the
repo (full forensics + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. Several boards are populated by
scheduled "scans" that sweep a universe of tickers, call external data
APIs (Finnhub, Polygon), and write a snapshot to Firestore. Large
universes (russell2k ≈ 2,000 names) use a checkpoint-resume pattern: a
thin scheduled trigger fires a background worker that batches the
universe, checkpoints a cursor, and self-reinvokes until done. Owner:
Chad Davis. Stack: TypeScript Netlify functions + React/Vite + Firestore.

## The problem you're fixing (summary — full forensics in the brief)

**Both russell2k scans are broken**, for two different reasons.

- **Bug A (root cause CONFIRMED) — insider russell2k scan.** It fires
  ~2,000+ Finnhub calls at concurrency 8 with no pacing, gets
  rate-limited (HTTP 429), and `getFinnhubInsiderTransactions` swallows
  every 429 into an empty result (`return []` after only a
  `console.warn`). The scan walks the whole universe, writes a terminal
  snapshot reporting `universeChecked: 2037` — and it's empty
  (`results: []`, `warnings: null`). A silent failure. sp500/ndx/dow
  (208/70/27 calls) stay under the limit and work fine.
- **Bug B (needs DIAGNOSIS) — target-board russell2k scan (Phase 4h).**
  It never writes a terminal snapshot at all; the board serves a
  >24h-stale snapshot, `companyName`/`sector` null. Suspected: a
  self-reinvoke handoff stall mid-chain. NOT yet diagnosed — diagnosing
  it is part of your job.

## Your assignment in one sentence

Make Finnhub access rate-limit-aware so the russell2k insider scan
completes with real data, diagnose-and-fix the target-board russell2k
stall, and add a systemic guard so a degraded scan can never again
silently publish an empty snapshot — shipped as one PR with full tests.

## Context you need (no decisions to re-litigate)

- **Finnhub tier.** You cannot see Chad's Finnhub dashboard. Throttle
  conservatively (Finnhub free tier ≈ 60 calls/min; paid tiers higher).
  In your hand-off, document the call-rate you throttled to AND compute
  how long a fully-paced russell2k insider scan takes + whether the
  checkpoint chain completes it in a nightly window. That math is the
  input to a possible Chad decision — surface it, don't decide it.
- These scans have **no LLM/token cost** — they are API calls + math.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4o@tradeiq.local"
git config user.name "Executor 4o"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # note the baseline count
npm run build                # must complete cleanly

git checkout -b phase-4o-russell-scan-reliability
```

If baseline fails, STOP and report with exact output. Bump APP_VERSION
one patch from whatever is on `main` (target ~`0.18.8-alpha`).

Read `briefs/phase-4o-brief.md` before writing code — it has the full
forensic evidence for Bug A and the honest status of Bug B.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`. Live verification is post-merge; the deploy has
Finnhub + Polygon + Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/shared/data-provider.ts` — `getFinnhubInsiderTransactions`
  (the 429-swallow bug is here), `getDailyBars`, `getPreviousClose`,
  `finnhubKey()`. Finnhub base + `FINNHUB_API_KEY` env var.
- `netlify/functions/shared/scan-insider.ts` — `runInsiderScan`,
  `runInsiderScanBatch`, `mapWithConcurrency` usage.
- `netlify/functions/scan-insider-russell2k-background.ts` — the insider
  checkpoint-resume worker; `scan-insider-{russell2k,sp500,ndx,dow}.ts`
  are the thin triggers (the four crons to stagger).
- `netlify/functions/scan-target-board-russell2k.ts` +
  `-background.ts` — the Phase 4h target-board scan (Bug B).
- `netlify/functions/shared/scan-resume/cursor.ts`,
  `shared/backtest-resume/{watchdog,reinvoke}.ts` — the checkpoint
  machinery (cursor read/write, watchdog, self-reinvoke).
- `netlify/functions/shared/snapshot-store.ts` — `writeSnapshot`
  (atomic `_latest` swap), `latestSnapshot`, `FRESHNESS_BUDGETS_MS`.
  The W3 guard lives around the terminal write.
- `netlify.toml` — `/api/*` routes are mapped **one redirect rule per
  endpoint** (NOT a wildcard). Any NEW `/api/` endpoint you add needs
  its own `[[redirects]]` block here, or it falls through to the SPA.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/shared/data-provider.ts` — W1 (Finnhub throttle +
  429 retry)
- `netlify/functions/shared/scan-insider.ts` — W1 (concurrency)
- `netlify/functions/scan-insider-{russell2k,sp500,ndx,dow}.ts` — W1
  (stagger cron schedules)
- a new `shared/rate-limiter.ts` (or similar) — W1, if you build a
  reusable limiter
- `netlify/functions/scan-target-board-russell2k.ts` + `-background.ts`
  — W2
- `netlify/functions/shared/scan-resume/*` — W2/W3, ONLY if the fix
  genuinely needs it; prefer minimal changes
- `netlify/functions/shared/snapshot-store.ts` — W3 (degraded-publish
  guard)
- a new debug/inspection endpoint for W2 (+ its `netlify.toml`
  redirect rule)
- test files for all of the above
- `briefs/phase-4o-pr-description.md` + `reports/phase-4o/verification.md`
- `src/App.jsx` — APP_VERSION bump
- `ORCHESTRATOR.md` — mark 4o done at the end

## 2.3 Files you may NOT touch

- The insider classification logic, the analyst pipeline, the
  target-board scoring — 4o is scan *reliability* only
- `insider-board.ts` `index=all` aggregation (Phase 4l W1 — verified
  working, leave it)
- Any UI / `src/` board views
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

---

# PART 3 — THE WORK (order W1 → W3 → W2)

## W1 — Rate-limit-aware Finnhub access (fixes Bug A)

- **Throttle Finnhub calls.** Add a pacing mechanism (token-bucket /
  rate limiter) so the scan emits Finnhub calls no faster than the
  plan allows. Module-scope pacing within an invocation is sufficient
  (the checkpoint chain runs one invocation at a time).
- **Lower the russell2k scan concurrency** from 8 to a value
  consistent with the paced rate.
- **429 backoff-and-retry in `getFinnhubInsiderTransactions`.** On a
  429, wait (exponential backoff, a few attempts) and retry. A 429
  means "retry later," NOT "no data." Only after retries are exhausted
  does it resolve — and then as a *flagged error*, never a silent `[]`
  (W3 consumes the flag).
- **Stagger the four insider-scan cron schedules** — they all fire at
  `30 21 * * 1-5` today and compete for Finnhub quota. Give each its
  own slot a few minutes apart, russell2k first.
- Document, in the hand-off, the throttled call rate and the
  computed russell2k scan completion time (see "Context" above).

## W2 — Diagnose and fix the target-board russell2k stall (Bug B)

- **Instrument first.** There is no public read for the scan-run
  cursor docs. Add a minimal debug/inspection endpoint (e.g.
  `/api/scan-status?scan=...`) — **with its `netlify.toml` redirect
  rule** — that exposes the latest russell2k scan run's cursor:
  `nextTickerIndex`, `invocationCount`, `lastError`, `startedAt`,
  watchdog/terminal state. This makes the stall visible and is a
  deliverable in its own right.
- **Then diagnose** the self-reinvoke handoff: does the reinvoke fetch
  fire? is it awaited via `Context.waitUntil`? does the reinvoke
  payload carry the `runId` (losing it makes the next invocation start
  fresh)? does the watchdog trip cleanly? is the worker URL correct?
- **Then fix** the actual cause. Do NOT ship a guessed fix — if
  instrumentation does not make the cause clear, ship the diagnostic
  endpoint, document findings in the hand-off, and stop. We iterate.

## W3 — Degraded scans must fail loud, not publish empty (systemic)

- **The terminal write must not atomic-swap a degraded result over a
  good snapshot.** Before `writeSnapshot` advances `_latest`, assess
  the assembled result: if it is empty, or far below a sane floor, or
  the run's error/429 rate is high → either keep the previous snapshot
  and record the run failed, or write the snapshot flagged `degraded`
  so the read endpoint surfaces `stale`/`degraded` instead of serving
  an empty board as clean.
- The floor must be sane — block only on clearly-broken (0 rows / high
  error rate), never on ordinary low yield.
- **Propagate rate-limit + error counts** from
  `getFinnhubInsiderTransactions` up through the batch result, the
  cursor, and into the snapshot `warnings`. A degraded scan is always
  visible.
- Generalize this in the shared scan-resume / snapshot-store layer so
  it protects every board, not just russell2k insider.

---

# PART 4 — TESTS

- W1: the rate limiter / pacing caps the call rate; 429 triggers
  backoff-and-retry (not a silent `[]`); concurrency is lowered.
- W2: the debug endpoint returns cursor state; plus whatever the
  diagnosis-driven fix needs.
- W3: an empty assembled result does NOT swap `_latest` (previous
  snapshot survives); a high-error-rate run is flagged `degraded`;
  warning/error counts propagate into the snapshot.
- Don't network in unit tests — mock Finnhub + Polygon + Firestore.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + verification report.
- APP_VERSION bumped one patch in `src/App.jsx`. MODEL_VERSION
  unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Any new `/api/` endpoint gets a matching `[[redirects]]` block in
  `netlify.toml` — this is a hard rule (a prior phase shipped an
  endpoint that fell through to the SPA for lack of a redirect).

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4o-russell-scan-reliability
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4o - russell2k scan reliability round 2",
    "head": "phase-4o-russell-scan-reliability",
    "base": "main",
    "body": "See briefs/phase-4o-brief.md and reports/phase-4o/verification.md. W1 rate-limit-aware Finnhub access (throttle + 429 backoff-and-retry + staggered crons); W2 instrument + diagnose + fix the target-board russell2k stall; W3 systemic guard so a degraded scan cannot publish an empty snapshot over a good one."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Live verification is post-merge by the orchestrator: fire both
russell2k scans, confirm the insider scan completes with a non-empty
snapshot, confirm the target scan writes a fresh terminal snapshot (or
review the W2 diagnostic output), confirm the degraded guard holds.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: Finnhub throttle (rate <X>/min), concurrency <8 -> N>, 429
      backoff-and-retry, crons staggered to <slots>
- W2: debug endpoint /api/<name> + netlify.toml rule; diagnosis:
      <what the stall turned out to be>; fix: <what / or "diagnostic
      shipped, cause still under investigation">
- W3: degraded-publish guard in snapshot-store; warning/error
      propagation

Finnhub math: throttled to <X>/min -> a full russell2k insider scan
  is ~<N> min -> completes in <K> checkpoint invocations -> [fits a
  nightly window | does NOT fit; flag for Chad]

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Acceptance: DEFERRED to post-merge (orchestrator fires both scans)

Known limitations:
- <anything worth flagging — especially if Bug B needed iteration>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Throttling so hard the scan can't finish even across a checkpoint
  chain.** Pace to ~80–90% of Finnhub's real limit, not a fraction.
- **Shipping a guessed fix for Bug B.** Instrument, diagnose, then fix.
  If the cause stays unclear, ship the diagnostic and report.
- **A W3 guard so strict it never publishes.** Block only on
  clearly-broken, not on low yield.
- **Adding a debug endpoint without its `netlify.toml` redirect rule.**
- **Leaving 429s as a silent `[]`** — they must retry, then flag.
- **Networking in unit tests.**
- **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

4h, 4j, 4l all merged. 4l's `index=all` aggregation works — don't
touch it. The Williams/Lynch phases (4m/4n) and desktop (4k) are
unrelated and not yet started. No other agent should be in the scan /
data-provider files while you work — if you hit an unexpected conflict
on `main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4o of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4o-executor.md — that's your full assignment —
   then read briefs/phase-4o-brief.md for the forensics and architecture.

Everything you need is in those two files: the two russell2k scan bugs
(Bug A confirmed — Finnhub 429 rate-limiting swallowed silently; Bug B
needs diagnosis — target-scan stall), the three workstreams (rate-limit-
aware Finnhub access, instrument+diagnose+fix the stall, systemic
degraded-publish guard), the test plan, and the failure modes. Any new
/api/ endpoint needs a netlify.toml redirect rule. Open the PR
ready-for-review, not as a draft. Start with PART 1 once you've read
both end-to-end. ~3-4 hour session.
