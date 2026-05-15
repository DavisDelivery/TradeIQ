# Phase 4f — Stub-analyst audit + repair + institutional-flow data (PARTIAL)

**Verdict:** PENDING LIVE-DATA RUN for the audit; W3+W5+W7 partial repair ships.

## What's in

Audit infrastructure (W1):
- `netlify/functions/shared/stub-audit.ts` — pure compute layer (classification, ingestion for both Prophet + Target snapshot shapes). 9 tests.
- `netlify/functions/audit-stub-analysts.ts` — `GET /api/audit-stub-analysts?days=30&board=both&universe=both[&fmt=md]`. Synchronous, fits the 26s budget via 8x concurrent snapshot reads. Archives to `stubAudits/runs/{stamp}`.
- `netlify/functions/scan-stub-audit-cron.ts` — weekly cron (Sunday 19:00 UTC, an hour offset from the existing Prophet-only cron from PR #23).
- `scripts/audit-stub-analysts.ts` — CLI mirror for direct-Firestore reads.
- `netlify.toml` — one new redirect.
- `reports/phase-4f/audit.md` — scaffolding + runbook; PENDING.

Institutional-flow modules (W4):
- `netlify/functions/shared/institutional-flow/types.ts` — shared types.
- `netlify/functions/shared/institutional-flow/dark-pool.ts` — TRF + condition-code based off-exchange ratio, 5d/30d rolling baseline, z-score. 11 tests.
- `netlify/functions/shared/institutional-flow/options-unusual.ts` — bullish/bearish premium bucketing, sweep + block + OI-spike counters, composite 0-100 unusualScore. 12 tests.
- `netlify/functions/shared/institutional-flow/block-trades.ts` — block detection (≥10K shares OR ≥$200K notional), bid/ask + VWAP fallback classifiers. 6 tests.
- `netlify/functions/shared/institutional-flow/polygon-trades.ts` — sample-based trade fetcher (up to 5 pages × 50K each). Handles pagination; tests are at the scanner layer.

Scheduled scanner (W7):
- `netlify/functions/scan-institutional-flow-largecap.ts` — weekday 22:00 UTC. Computes dark-pool + block-trades per largecap ticker and caches to `institutionalFlow/largecap/{ticker}/{YYYY-MM-DD}`. options-unusual is shipped + tested but not yet wired into the scan (Polygon options-ticks fetcher is a follow-up). 3 integration tests.

Repair + reweighting (W3+W5 partial):
- `netlify/functions/shared/compose-weights.ts` — pure `composeWeights()` helper that skips no-data analysts and proportionally rescales the survivors so they sum to 1.0. 8 tests.
- `netlify/functions/shared/analyst-runner.ts` — Phase 4f W3 repair: insider/patent/political analysts now emit `signals: { _noData: true, _reason: 'no_data' }` when upstream activity is null, instead of the historical `score: 50, direction: 'neutral'` stub. The composite math + `analystContributions` use the rescaled weights.
- `netlify/functions/shared/types.ts` — Target gains `scoredAnalysts?: string[]` + `noDataAnalysts?: string[]` for UI provenance.

Versions:
- APP_VERSION → `0.18.0-alpha`
- MODEL_VERSION → `2026.03.0` (composite math changes; historical snapshots stay on 2026.02.0 for honest backtest replay)

## What's NOT in (deferred to 4f-follow-up)

- **W3 (further repairs)**: macro-regime, earnings-analyst, and any other stubs the live audit identifies as `threshold_misconfig` or `latency`. Code inspection couldn't distinguish those without sampled data.
- **W4d**: Quiver Form 4 path verification/repair. Same — gated on live audit findings.
- **W5 UI badges**: `LIVE` / `NO_DATA` / `REMOVED` badges in `AnalystContributions.jsx`. Frontend; bundled into 4f-follow-up since the data plumbing is now in place (`Target.scoredAnalysts` + `Target.noDataAnalysts`).
- **W5 permanent removals**: no analyst is structurally removed in this PR. `composeWeights` handles permanent removal automatically when the corresponding `ANALYST_WEIGHTS` entry is set to 0; awaits live audit.
- **W6 backtest comparison**: gated on 4e-1-finish landing real backtest data. Same harness, same data dependency.
- **options-unusual wiring into the scheduled scanner**: ships as a tested module ready to plug in once a Polygon options-tick fetcher is built (per-ticker strike enumeration + chain).

## How the verdict populates itself

After merge + deploy:

- Sunday 19:00 UTC → `scan-stub-audit-cron.ts` fires `/api/audit-stub-analysts` → archive row at `stubAudits/runs/{stamp}` with verdicts for all 4 quadrants.
- Weekday 22:00 UTC → `scan-institutional-flow-largecap.ts` fires → daily dark-pool + block-trade signals per largecap ticker.
- At any time: `curl https://tradeiq-alpha.netlify.app/api/audit-stub-analysts?fmt=md` returns the live audit as Markdown.

To freeze the audit into the repo:

```
curl 'https://tradeiq-alpha.netlify.app/api/audit-stub-analysts?fmt=md' \
  > reports/phase-4f/audit.md
git add reports/phase-4f/audit.md && git commit -m "phase-4f: freeze stub audit"
```

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — 522 → 571 (+49 new across 7 test files)
- `npm run build` — clean (953 kB chunk warning is pre-existing)

## Why partial and not full

Code-level certainty (the screenshot + visible null-defaults in `analyst-runner.ts`) supports the W3+W5 repairs that ship today. Statistical certainty (which stubs are `threshold_misconfig` vs `latency` vs `no_upstream`) requires the live audit which requires `FIREBASE_SERVICE_ACCOUNT` which the executor session doesn't have. Following 4e-1's precedent: ship what's honest and unblocked; defer what needs live data; let cron close the loop.

The composite math is forward-compatible — `composeWeights` already handles permanent removals (set `ANALYST_WEIGHTS[name] = 0` and the survivors rescale automatically). The 4f-follow-up after the live audit fires will be a small PR.
