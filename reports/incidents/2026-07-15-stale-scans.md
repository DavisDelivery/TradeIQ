# Incident: stale boards — prophet ×3, lynch-sp500, target-ndx (+ Tuesday's dow/ndx in-handler cohort)

**Status:** root-caused + fixed (PR: earnings-history live cache). Written 2026-07-15 ~01:15 UTC.

## Symptom timeline

| Cohort | Boards | Last good | First failed |
|---|---|---|---|
| 1 | prophet all/largecap/russell2k, lynch-sp500, target-ndx | Fri 2026-07-10 21:33–22:12 UTC | Mon 2026-07-13 13:00 UTC |
| 2 | target-dow, catalyst-dow/ndx, insider-dow/ndx, lynch-ndx | Mon 2026-07-13 21:33–22:06 UTC | Tue 2026-07-14 13:00 UTC |

Unaffected throughout: every board×universe served by a `*-background`
worker (insider/catalyst/target/lynch sp500+russell2k, fable, earnings)
and the fast Polygon-only in-handler scans (williams ×4, crosses,
lynch-dow).

Monday's failure was initially attributed to FABLE-2 campaign Finnhub
saturation. **Falsified** Tue night: the campaign was idle 13:00–21:30
UTC and prophet failed every slot anyway.

## Evidence

- `/api/snapshot-history?board=prophet&universe=all`: run docs exist for
  EVERY Tuesday slot (universeChecked 2381, 22–36 picks) — the workers ran
  all day. `_latest` stayed at Jul 10 because every run carried
  `status: 'partial'` (writeSnapshot's partial-safe guard correctly refused
  promotion).
- Sieve meta comparison ('all'):
  - Jul 10 21:37 (last promoted): stage2 scored **487 in 11,146 ms**.
  - Jul 15 00:56 (quiet-time manual run): stage2 scored **232 in
    244,441 ms** → budget hit → partial. Throughput ≈ 0.95/s = the
    Finnhub token-bucket rate (55/min). Same survivor count (487).
- lynch-sp500 / target-ndx: **zero** run docs since Jul 10 — those
  in-handler scheduled functions died before their unconditional
  `writeSnapshot` (container killed / fatal path), leaving no trace.
- Off-cluster probes both succeeded (seed target-ndx 00:52 → snapshot
  00:55; manual prophet-all worker ran fully, still partial) — proving
  scan code fine, stage-2 slowdown intrinsic, cohort-2 deaths
  contention-dependent.

## Root cause

**PR #105 (Sun Jul 12) paced `getEarningsHistory` through the shared
Finnhub token bucket** (`getFinnhubBucket().acquire()` + 429-aware retry).
Correct medicine for the PEAD study's burst problem — the old unpaced
fetch silently returned `[]` under 429. But it repriced every LIVE
large-universe scan that calls it per ticker:

- prophet stage 2 (`getEarningsIntel` → `getEarningsHistory`) on ~487
  survivors ≈ 9 min of tokens vs a 244 s stage budget → `partial` every
  run → never promoted (cohort 1, Monday onward — first slots after the
  Sunday deploy).
- lynch-sp500: 503 × the same call ≈ +9 min onto an ~11-min scan → blew
  the 15-min container → killed with no run doc.
- target-ndx: analyst-runner calls it per deep-pass ticker; on top,
  prophet's now-CONTINUOUS token burn every 30-min slot raised account-
  level 429 pressure at exactly the scan slots.
- Tuesday (#110: Finnhub `initialTokens: 8` + patient insider retry)
  added cold-start + retry latency to every Finnhub scan — the small
  dow/ndx in-handler scans that barely fit on Monday crossed the line
  (cohort 2).

Underlying disease: **refetching quarterly-stable data 18×/day per ticker
at 55/min**. Nothing cached `stock/earnings` in live mode.

## Fix (this PR)

`shared/provider-live-cache.ts` — Firestore-backed, TTL'd, cross-container
live cache (in-process L1 in front; `providerLiveCache` collection), wired
into `getEarningsHistory` live mode only:

- non-empty histories cached 26 h; legit empties 6 h (an ETF stays empty,
  but empty is also what a plan gap looks like — re-verify often);
- M8 discipline: HTTP !ok / parse-fallback / thrown transport / join-
  degraded results are never cached;
- PIT calls (`asOfDate`) bypass entirely — backtest paths unchanged;
- cache failures degrade to plain fetch (never less reliable than before).

Per-ticker entries expire on their own clocks → daily refresh rolls
gradually across slots; no full-universe cold sweep after day one. Warm-
cache stage 2 returns to ~Friday throughput; lynch-sp500 fits its
container again; prophet stops burning 55/min continuously, decongesting
the account for the small in-handler scans.

## Verification plan

1. Post-deploy: seed prophet ×3, lynch-sp500, target-ndx, target-dow,
   catalyst-dow/ndx, insider-dow/ndx, lynch-ndx (staggered) → confirm
   `_latest` advances (prophet may take 2 slots: first warms, second
   promotes).
2. Wed 13:00–21:30 UTC cron cycle: confirm prophet promotes most slots and
   the cohort-2 boards produce run docs at their scheduled times.

## Follow-ups (not this PR)

- In-handler scheduled scans die docless — add a failed-run marker (or
  convert the remaining in-handler scans to the dispatcher→background
  pattern) so the next such death is visible in `runs/` instead of
  requiring archaeology.
- Prophet stage-2 budget has no survivor cap: a future slow provider
  re-creates chronic-partial. Consider top-K-by-stage-1-score capping
  sized to measured throughput.
- `getUpcomingEarnings` live mode is still an unpaced raw fetch (the
  pre-#105 shape). Candidate for the same live-cache treatment BEFORE
  anyone paces it.

## Update — 2026-07-15 14:40 UTC (fix #2: stage 3)

Fix #1 verified in production: stage 2 scores 487–510/510 complete in
~2 min warm (13:48 run), lynch-sp500 completes in ~5 min, russell2k
promoted 13:20Z via its own cron. The residual: prophet/all stage 3 went
partial (89–99 survivors × ~5.5s; "insider/political/contract provider
data unavailable for 56 tickers") — the same disease one layer down.
Stage 3's catalyst-layer calls (Finnhub insider, paced + #110-patient-
retried; Quiver political/contracts) re-fetch per ticker per 30-min slot
with zero caching, at cluster hours.

Fix #2 (same PR series): `liveCacheWrap` in provider-live-cache +
live-mode caching for `getInsiderActivity` (6h TTL — Form 4s are daily-
cadence; the insider BOARD scans use the raw transactions path and are
unaffected), `getPoliticalActivity` and `getGovContractActivity` (24h).
M8 intact: transport-failure nulls (incl. Quiver 403 plan gates) are
never cached. Patents left uncached (its module conflates failure with
empty — wrapping it would risk sticky failures; noted as follow-up).
Also fixed: `liveCacheSet` now JSON-sanitizes values — Firestore rejects
`undefined` fields, so any result with an optional-absent field was
silently skipping its cache write.

Separately: the other workstream's #123 converted all 16 remaining
inline scheduled scans to background workers — the architectural
follow-up from this report's first version. Between #123 and the two
cache fixes, both failure modes (docless container death, chronic
partial) have structural fixes.
