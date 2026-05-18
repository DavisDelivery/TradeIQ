# Phase 4o — russell2k scan reliability, round 2

**Branch:** `claude/phase-4o-executor-khP9C`
**APP_VERSION:** `0.18.6-alpha` → `0.18.8-alpha`
**MODEL_VERSION:** unchanged
**Brief:** `briefs/phase-4o-brief.md`
**Kickoff:** `kickoffs/phase-4o-executor.md`
**Verification report:** `reports/phase-4o/verification.md`

## Summary

Both russell2k scans were broken. Bug A (insider) was a confirmed
silent failure: the scan walked all ~2,037 names, got Finnhub-429'd on
most of them, and silently published `results: []` over the previous
good snapshot. Bug B (target-board) was suspected as a self-reinvoke
handoff stall but had not been freshly diagnosed.

This PR:

- **W1 — Rate-limit-aware Finnhub access.** New
  `shared/rate-limiter.ts` (token bucket + 429-aware fetch wrapper).
  `getFinnhubInsiderTransactionsWithStatus` returns
  `{ data, rateLimited, rateLimitExhausted, errorMessage? }` so the
  russell2k scan can propagate failure counts up. Default 55 calls/min
  (override `FINNHUB_RPM` env var); 3 retries with exponential backoff
  capped at 8s, `Retry-After` honored. russell2k insider concurrency
  lowered from 8 → 4 so the cold-start burst doesn't blow through the
  bucket capacity. The four insider crons (russell2k / sp500 / ndx /
  dow) are staggered to 21:30 / 21:35 / 21:40 / 21:45 UTC so they no
  longer compete for the same minute of Finnhub quota.

- **W2 — Diagnose-and-fix the target-board stall.** New
  `GET /api/scan-status?board=…&universe=…` reads the latest
  `scanRuns/{runId}` doc and exposes the cursor: `nextTickerIndex`,
  `invocationCount`, `lastError`, the new `lastReinvokeAt` /
  `reinvokeAttempts` fields, plus derived `invocationAgeMs` and
  `scanAgeMs`. Netlify redirect rule added. Both russell2k workers now
  stamp the cursor *before* dispatching the self-reinvoke fetch so a
  stalled chain leaves a forensic trace. No reinvoke-layer logic change
  shipped — per the kickoff, instrument first; if the cause stays
  unclear after the next live run, iterate.

- **W3 — Degraded scans must fail loud, not publish empty.** New pure
  `assessSnapshotPublish(input)` in `snapshot-store.ts` returns
  `'publish' | 'publish-degraded' | 'skip'`. Both russell2k bg-workers
  consult it on the terminal batch — empty rows on a large universe
  triggers `skip` (the Bug A pattern, never atomic-swaps `_latest`),
  high failure rate triggers `skip` for full incompleteness, moderate
  failure rate triggers `publish-degraded` with a flag the read
  endpoint can render. New `BoardSnapshot.degraded` + `degradedReason`
  fields. Rate-limit + error counts propagate into the snapshot's
  `warnings[]`.

## Finnhub math (the § X decision)

With the W1 token bucket at default 55 rpm, a russell2k insider scan
takes ~37 min of Finnhub call wall-clock → completes in ~3 checkpoint
invocations → **fits the nightly window comfortably**. No Finnhub plan
upgrade needed at the default. If Chad upgrades the Finnhub plan to,
e.g., 300 rpm, set `FINNHUB_RPM=275` in the Netlify env and the scan
finishes in a single invocation (~7 min). Same code path.

## Tests

- Baseline (`main`): 842 passing across 89 files.
- This PR: **880 passing across 94 files** (+38 tests, +5 files).
- New files: `rate-limiter.test.ts`, `data-provider-insider-429.test.ts`,
  `publish-guard.test.ts`,
  `scan-insider-russell2k-background.degraded-guard.test.ts`,
  `scan-status.test.ts`.

## Live acceptance

Deferred to orchestrator post-merge. The verification report's "Live
acceptance criteria" section spells out the three checks the orchestrator
runs (fire russell2k insider; fire russell2k target-board OR inspect via
`/api/scan-status`; confirm W3 guard holds against a forced-degraded
run).

## Known limitations

Bug B's actual cause is not yet identified. The W2 deliverable — the
diagnostic endpoint plus the cursor's new `lastReinvokeAt` /
`reinvokeAttempts` fields — is the instrumentation needed to pinpoint
the stall on the next live scan run. The hand-off in
`reports/phase-4o/verification.md` documents how to read the diagnostic
output to localize the cause (reinvoke layer vs. batch loop vs.
watchdog).
