# Phase 4r W1 — Fix

Companion to [`diagnosis.md`](./diagnosis.md). The diagnosis names two
root causes; this is the change set and the acceptance steps.

## Change set

### 1. Cron strategy: pick the next undone window

`netlify/functions/scan-portfolio-backtest-cron.ts` — `dayOfYear % 13`
replaced by a Firestore-aware selection:

1. Read the latest doc per window from `portfolioBacktests`.
2. Iterate a priority list: `[rolling-2018…rolling-2025, full,
   half-2018, half-2022, covid, rate-hikes]`.
3. Pick the first window whose latest doc is NOT `done` at the active
   rule version (default `'v2'`, env-overridable via
   `PORTFOLIO_RULE_VERSION`).
4. If every priority window is already done at the active version,
   pick the oldest rolling window to re-validate.
5. **Fallback:** if the Firestore query throws, fall back to the
   legacy `dayOfYear % 13` picker. A stuck cron is worse than a
   wasteful one.

Tests: `netlify/functions/__tests__/scan-portfolio-backtest-cron.test.ts`
extended with 8 new cases covering empty-collection, stale-version,
pending-as-undone, all-done-revalidate, legacy-fallback, and the
end-to-end `runCron` dispatch.

### 2. Persist `version` on result docs

`netlify/functions/run-portfolio-backtest-background.ts` — the terminal
summary write now includes `version: config.version` so future result
docs carry the rule version they ran under. Pre-Phase-4r docs have no
`version` field; consumers treat that as `'v1'` (pre-4i).

### 3. Verdict endpoint: version-aware

`netlify/functions/portfolio-verdict.ts` — three changes:

- New `ACTIVE_VERSION` constant (env-driven, defaults to `'v2'`).
- `deriveVerdict()` only counts a rolling-* `done` doc toward the
  ≥5/8-rolling rule if its version equals `ACTIVE_VERSION`.
- `staleVersionWindows` field added to the verdict result and
  surfaced as a "⚠️ Stale rule version detected" banner in the
  markdown. The hardcoded `"Rule version: v1"` line is replaced with
  the dynamically-resolved active version.

Tests: new `netlify/functions/__tests__/portfolio-verdict.test.ts`
with 5 cases covering pending-on-empty, pending-on-v1-only, SHIP at
8/8 v2, the v1-in-rolling stays pending, dynamic rule-version
display.

### 4. `/api/backtest-status` diagnostic endpoint (new)

`netlify/functions/backtest-status.ts` + `netlify.toml` redirect.
Read-only. Surfaces per-window latest run state, the done-for-active-
version count toward 8/8, the missing rolling-windows list, and a
stale-pending / stale-running inventory. Mirrors the
`/api/scan-status` pattern Phase 4o built for the russell2k scan
chain.

Tests: `netlify/functions/__tests__/backtest-status.test.ts` (8
cases).

### 5. APP_VERSION + ORCHESTRATOR

- `src/App.jsx`: 0.19.0-alpha → 0.19.1-alpha.
- `ORCHESTRATOR.md`: 4e-1-finish row corrected from "verdicts
  complete" to the live state; 4r row added.

## Why this is a confirmed fix, not a guessed fix

- **Cron strategy:** the diagnosis showed only `rolling-2021` and
  `full` are done, and the cron picks any-of-13 randomly per weekday
  — by inspection, every cron firing on a non-rolling slot is
  wasted. The new strategy picks ONLY undone-at-active-version
  windows. Once deployed, the very next cron firing (Mon 22:00 UTC)
  is guaranteed to fire a missing rolling window.
- **Version mix:** the diagnosis showed rolling-2021 is v1 and full
  is v2 by inspection of the swap counts in the live `portfolio-
  backtest-runs` response (rolling-2021 swapCount=1 = v1; full
  swapCount=418 = v2 active weekly rebalance). The verdict
  hardcoded "v1". Both halves of the contamination are now closed.

The fix is not speculation — it's structurally what the system
needed to advance.

## Acceptance steps for the orchestrator (post-merge)

1. **Wait for Netlify deploy.** Or trigger a manual deploy.
2. **Smoke-test the diagnostic.**
   ```
   curl https://tradeiq-alpha.netlify.app/api/backtest-status | jq '.rolling'
   ```
   Should show `done: 0, total: 8, missing: [rolling-2018, …, rolling-2025]`
   because all existing rolling docs are v1 or missing.
3. **Option A — wait for the cron.** The next weekday 22:00 UTC firing
   will pick rolling-2018 (or whichever is first-undone at that
   moment) and drive one window to done. ~5 weekdays to 8/8.
4. **Option B — fire the 7 missing rolling windows immediately.**
   ```
   for w in rolling-2018 rolling-2019 rolling-2020 rolling-2021 \
            rolling-2022 rolling-2023 rolling-2024 rolling-2025; do
     curl -X POST https://tradeiq-alpha.netlify.app/.netlify/functions/portfolio-backtest-trigger \
       -H 'Content-Type: application/json' \
       -d "{\"window\":\"$w\"}"
     sleep 1
   done
   ```
   Each takes ~3-30 min depending on cache warmth. They run in
   parallel via separate background functions. Watch progress:
   ```
   watch -n 30 'curl -s https://tradeiq-alpha.netlify.app/api/backtest-status | jq ".rolling"'
   ```
5. **Verify 8/8 + non-PENDING verdict.**
   ```
   curl https://tradeiq-alpha.netlify.app/api/portfolio-verdict | jq '.verdict'
   ```
   Should return one of `"SHIP"`, `"SHIP WITH CAVEATS"`, or
   `"DON'T SHIP"`. **Whichever it is, that's the binding 4e-1
   verdict for rule v2.**
6. **Only then proceed to W2 + W3.** Per the Phase 4r sequencing
   rule.
