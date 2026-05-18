# Phase 4r W1 — Rolling-window stall diagnosis

**Date:** 2026-05-18
**Method:** diagnose-before-fix (Phase 4o/4p discipline). Probed live
`/api/portfolio-verdict` and `/api/portfolio-backtest-runs` against the
production deploy, cross-referenced the result against the cron / trigger
/ background-runner source. No code was changed before the cause was
confirmed.

## TL;DR

**The brief framed this as "the cron has stalled." It hasn't — the
dispatch race was fixed in PR #30 on 2026-05-15. The actual root cause
is structurally different and has two components.**

1. **Cron strategy is too slow to ever reach 8/8.** The cron picks one
   window per weekday by `dayOfYear % 13`. Of 13 windows in the cycle, 8
   are rolling-*. Once one rolling-* is `done`, subsequent cron firings
   re-pick already-done windows ~12/13 days, overwriting them and never
   advancing the rolling-N/8 count. Going from 1/8 → 8/8 takes 7–12
   weeks of weekday cron firings on a perfectly green path.
2. **The portfolio rule version was switched v1 → v2 between when the
   one done rolling result was written and when the one done full
   result was written**, but neither doc records its rule version, so
   the verdict aggregates rule-version-mixed data without warning.
   `rolling-2021` is a v1 result (1 swap, buy-and-hold); `full` is a v2
   result (418 swaps, active weekly rebalance). The verdict markdown
   hardcodes "Rule version: v1" — stale.

A "fix" that just kicks the cron faster would still produce a verdict
on rule-version-mixed data. Both halves matter.

## Live state at diagnosis time (2026-05-18 17:07 UTC)

`GET /api/portfolio-verdict` returns:

```
verdict: PENDING LIVE-DATA RUN
Full-window: done.  Audit: done.  Rolling: 1/8 done.
Rule version: v1   ← hardcoded; misleading
```

`GET /api/portfolio-backtest-runs?limit=30` returns **8 docs total** in
`portfolioBacktests/`:

| Run ID                                | Window         | Status   | When             | Rule (inferred) |
|---------------------------------------|----------------|----------|------------------|----------------:|
| pb-full-202605161946-osiwpg           | full           | done     | 2026-05-16 19:46 | **v2** (418 swaps, post-4i) |
| pb-full-202605160103-5cs65b           | full           | done     | 2026-05-16 01:03 | v1 (1 swap)     |
| pb-short-demo-202605160100-wzs336     | short-demo     | done     | 2026-05-16 01:00 | v1              |
| pb-rolling-2021-202605152206-e9g1ai   | rolling-2021   | done     | 2026-05-15 22:06 | **v1** (1 swap, pre-4i) |
| pb-full-202605151418-8v4k66           | full           | running  | 2026-05-15 14:18 | (stuck) |
| pb-short-demo-202605151412-89zcqq     | short-demo     | done     | 2026-05-15 14:12 | v1 |
| pb-full-202605150933-fqrsid           | full           | pending  | 2026-05-15 09:33 | (pre-bgfix-2 stuck) |
| pb-rolling-2022-202605142200-008f3z   | rolling-2022   | pending  | 2026-05-14 22:00 | (pre-bgfix-2 stuck) |

**Of 8 rolling-* windows the verdict's binding rule reads, only
rolling-2021 has a `done` doc — and it's v1.** Seven rolling-* windows
have never been run.

## Component 1 — cron strategy is structurally slow

`netlify/functions/scan-portfolio-backtest-cron.ts` schedule `0 22 * * 1-5`
(Mon–Fri 22:00 UTC). The handler:

```ts
const dayOfYear = ...
return WINDOW_CYCLE[dayOfYear % WINDOW_CYCLE.length];
```

Picks one of 13 windows per weekday. Of those 13 slots, 8 are rolling-*,
5 are named (`full`, `half-2018`, `half-2022`, `covid`, `rate-hikes`).

Each weekday: the cron fires the chosen window's trigger → background
runner → result doc. If the chosen window was already `done`, the new
doc overwrites the old `latest` for that window with identical-config
results. The rolling-N/8 count doesn't advance.

For an empty system to reach 8/8 takes 8 distinct rolling-* days. But
every day the cron has a 5/13 chance of picking a non-rolling slot
(wasted), and an increasing chance over time of re-picking an
already-done rolling slot (also wasted). **Median completion time:
several weeks.** And that's assuming no failed runs and no further
strategy changes.

## Component 2 — silent v1/v2 rule-version mix

`netlify/functions/run-portfolio-backtest-background.ts` defines
`RULE_CONFIG_BASE` with a `version` field — switched from `'v1'` to
`'v2'` by Phase 4i (commit 636c1d9, merged 2026-05-16 19:44 UTC). But:

- The version was **never written onto the result doc.** The summary
  written by the background runner had no `version` field.
- `portfolio-verdict.ts` **hardcoded `Rule version: v1`** in its
  markdown.
- The verdict's `deriveVerdict()` accepted any `done` doc toward the
  ≥5/8-rolling-windows count — no version check.

Net effect: when more rolling-* windows finish under v2, the verdict
will aggregate them with the v1 rolling-2021 result. The number it
prints would not correspond to any single rule's behavior across all
8 windows. That's not a verdict — that's a fraud.

## Component 3 — pre-bgfix-2 stuck docs (harmless artifact)

`pb-rolling-2022-202605142200-008f3z` (pending) and
`pb-full-202605150933-fqrsid` (pending) — both started before the
dispatch-race fix in PR #30 (1a8a003, 2026-05-15 10:10 EDT). They sit
in the collection but don't block anything: the trigger creates a new
runId per fire, so a future cron run of `rolling-2022` will produce a
new doc and the verdict's "latest per window" lookup naturally
supersedes the stale pending. The new W1 cron strategy treats a
pending latest as "undone" — meaning rolling-2022 is on the
fire-next list, which is the desired outcome.

`pb-full-202605151418-8v4k66` (running since 2026-05-15 14:51) is a
checkpoint-resume orphan — but the v2 `full` result on 2026-05-16
19:46 superseded it as `full`'s latest, so it has zero functional
effect. Could be cleaned up by a separate recovery sweep; W1's scope
doesn't require it.

## Rule-version question — reasoned, not picked silently

> Phase 4r kickoff PART 3 W1 step 3: "Determine whether the stuck series
> is a v1 series to complete or must be re-run under v2 — report your
> reasoning, do not pick silently. Flag it to the orchestrator if
> consequential."

**Reasoning:**

1. The PRODUCTION code under `RULE_CONFIG_BASE` is v2 since Phase 4i
   merged 2026-05-16 19:44 UTC. Any new run uses v2.
2. v1 was found by Phase 4i to be effectively buy-and-hold (1 swap
   across 418 weekly rebalances). It is not the strategy Chad wants to
   evaluate; Phase 4i was specifically written to fix this.
3. A v1 binding verdict computed in 2026-05-18 would be a number
   describing a strategy the codebase no longer runs.
4. The only existing rolling-* result (rolling-2021) is v1. Six other
   rolling-* windows have never been run. **The series must be re-run
   under v2.**

**Decision:** target verdict is v2.

**Consequential to flag:** the v1 `rolling-2021` result will be
displaced by a v2 re-run. The verdict markdown shows the v1 result in
its rolling-1y table today; once a v2 rolling-2021 lands, those
numbers will change (likely substantially — v2 turnover is dramatically
higher). This is expected and correct, but anyone who saved a
screenshot of today's verdict will see a different number tomorrow.

## Fix (separate document — this report is the diagnosis)

See `reports/phase-4r/fix.md` for the change set + acceptance steps.

## Failure mode I rejected

A "fire-all-undone-rolling-windows-in-parallel" admin endpoint. It would
drive 1/8 → 8/8 in ~5 minutes by firing 7 background workers at once.
Rejected because (a) Polygon free-tier rate limits make 7 concurrent
backtests risky, (b) the cron fix already gets us to 8/8 in 7 weekdays
without operator action, (c) the orchestrator can fire missing windows
manually via the existing `portfolio-backtest-trigger` endpoint if a
faster timeline is needed. Adding a new admin endpoint just for this
one phase would be scope creep.
