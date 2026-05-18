# Phase 4r W1 — Rolling-window cron-stall fix

Closes the W1 half of `briefs/phase-4r-brief.md` and
`kickoffs/phase-4r-executor.md`. Diagnose-before-fix per the russell2k
4o/4p model. W2 + W3 land in a separate PR after the orchestrator
verifies 8/8 live.

## Diagnosis (full: [`reports/phase-4r/diagnosis.md`](reports/phase-4r/diagnosis.md))

The brief framed this as "the cron has stalled." It hasn't — the
dispatch race was fixed in PR #30 on 2026-05-15. The actual root
cause is structurally different and has two confirmed components,
neither speculated:

1. **Cron strategy is too slow to ever reach 8/8.** `scan-portfolio-
   backtest-cron.ts` picks one window per weekday by `dayOfYear % 13`.
   Only 8 of 13 slots are rolling-*. Once a rolling-* is `done`,
   subsequent cron firings re-pick already-done windows ~12/13 days
   — wasted compute, no progress. Going 1/8 → 8/8 takes 7–12 weeks
   on a perfectly green path.

2. **Silent v1/v2 rule-version mix.** Phase 4i (commit 636c1d9,
   merged 2026-05-16 19:44 UTC) flipped `RULE_CONFIG_BASE.version`
   from `'v1'` to `'v2'`. But (a) the version was never written onto
   the result doc, (b) `portfolio-verdict.ts` hardcoded
   `Rule version: v1`, and (c) `deriveVerdict()` counted any `done`
   doc toward the ≥5/8-rolling rule without version filtering. The
   one existing rolling result (`rolling-2021`) is v1; the full
   result is v2. When more rolling-* finish under v2, the verdict
   would silently aggregate v1 + v2 docs as if they were the same
   strategy.

Live-state probe at diagnosis time (2026-05-18 17:07 UTC) — 8 docs
total in `portfolioBacktests`, of which one v1 rolling done, two
v2/v1 full done, two pre-bgfix-2 pendings (harmless), one stuck
running (harmless).

## Rule-version question — reasoned, not picked silently

> Per kickoff: "Determine whether the stuck series is a v1 series to
> complete or must be re-run under v2 — report your reasoning, do not
> pick silently."

**The series must be re-run under v2.** Reasoning ([diagnosis.md](reports/phase-4r/diagnosis.md) "Rule-version question"):

- Phase 4i flipped production to v2 specifically because v1 ran 1
  swap across 418 weekly rebalances — buy-and-hold, not the active
  strategy Chad evaluated.
- A v1 binding verdict in 2026-05-18 would describe a strategy the
  codebase no longer runs.
- The one v1 rolling result will be displaced by a v2 re-run. The
  rolling-2021 numbers visible in today's verdict will change once
  re-fired under v2.

**Consequential flag to the orchestrator:** anyone with a screenshot
of today's verdict will see different numbers after deploy.

## Fix (full: [`reports/phase-4r/fix.md`](reports/phase-4r/fix.md))

1. **Cron strategy: pick the next undone window.**
   `scan-portfolio-backtest-cron.ts` — replace `dayOfYear % 13` with a
   Firestore-aware selection: read each window's latest doc, find the
   first window in the priority list (8 rolling-* first, then named
   comparisons) whose latest is NOT `done` at the active version,
   fire it. Legacy `dayOfYear % 13` is the fallback if Firestore
   throws (a stuck cron is worse than a wasteful one).

2. **Persist `version` on result docs.** `run-portfolio-backtest-
   background.ts` now writes `config.version` onto the terminal
   summary. Pre-4r docs (no `version`) are treated as `v1`.

3. **Verdict endpoint: version-aware.** `portfolio-verdict.ts` reads
   an `ACTIVE_VERSION` (default `'v2'`, env-overridable). Rolling-*
   `done` docs at a stale version don't count toward the binding
   rule; they're surfaced via a `⚠️ Stale rule version detected`
   banner. The hardcoded `Rule version: v1` is replaced with the
   resolved active version.

4. **New `/api/backtest-status` diagnostic.** Mirrors how Phase 4o
   built `/api/scan-status`. Read-only. Surfaces per-window latest
   run, done-for-active-version count toward 8/8, missing rolling
   list, stale-pending / stale-running inventory.

5. **APP_VERSION 0.19.0 → 0.19.1-alpha.**

6. **ORCHESTRATOR.md** — the stale "4e-1-finish verdicts complete"
   row is corrected; 4r row reflects W1 PR open.

## Verification

- `tsc --noEmit` — clean
- `npm test` — **977 passing** (was 956 on `main`; **+21 net** across
  new tests in `__tests__/scan-portfolio-backtest-cron.test.ts`,
  `__tests__/backtest-status.test.ts`,
  `__tests__/portfolio-verdict.test.ts`)
- `npm run build` — clean
- MODEL_VERSION unchanged — W1 runs the engine, doesn't change
  scoring.

## Acceptance for the orchestrator (post-merge)

1. Wait for Netlify deploy.
2. Smoke-test:
   ```
   curl https://tradeiq-alpha.netlify.app/api/backtest-status | jq '.rolling'
   ```
   Should show `done: 0, total: 8, missing: [all 8]` because every
   existing rolling doc is v1 (rolling-2021) or missing (the rest).
3. **Option A** — let the next weekday 22:00 UTC cron firing pick
   rolling-2018 (or whichever is first-undone), and let the cron
   advance one rolling window per weekday. ~5–7 weekdays to 8/8.
4. **Option B (faster)** — fire all 7 missing rolling windows
   in parallel:
   ```
   for w in rolling-2018 rolling-2019 rolling-2020 rolling-2021 \
            rolling-2022 rolling-2023 rolling-2024 rolling-2025; do
     curl -X POST https://tradeiq-alpha.netlify.app/.netlify/functions/portfolio-backtest-trigger \
       -H 'Content-Type: application/json' -d "{\"window\":\"$w\"}"
     sleep 1
   done
   ```
   Each finishes in ~3 min cold. Watch:
   ```
   watch -n 30 'curl -s https://tradeiq-alpha.netlify.app/api/backtest-status | jq ".rolling"'
   ```
5. Verify `/api/portfolio-verdict` returns a non-PENDING verdict for
   rule v2. **Only then start W2 + W3.**

## What this PR is NOT

- Not a guess. The diagnosis names the structural cause and the
  version mix from live data, not from a hunch.
- Not a one-shot kick endpoint. The orchestrator can fire missing
  windows manually via the existing `portfolio-backtest-trigger`;
  adding a new admin endpoint just for 4r would be scope creep.
- Not W2 / W3. Per the sequencing rule, those start only after the
  orchestrator merges this PR and confirms 8/8 live.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
