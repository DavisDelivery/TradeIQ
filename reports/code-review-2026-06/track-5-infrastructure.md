# Track 5 — Infrastructure, Data Providers, Cross-Cutting

1 critical, 5 major, ~20 minor findings. Two majors are confirmed-by-code
logic bugs (scan-status query returns nothing; Anthropic budget priced 3×
wrong), one is a PIT look-ahead bias, plus an unauthenticated scan-trigger
endpoint that can rewrite production snapshots.

## CRITICAL

**1. `seed-scan-background.ts` is unauthenticated and can trigger 15-minute
full-universe scans + overwrite production snapshots** —
`netlify/functions/seed-scan-background.ts:77-95`. No token gate (contrast
`scan-prophet-largecap-trigger.ts:101`, which checks
`SCHEDULED_SCAN_TRIGGER_TOKEN`). Anyone who hits
`/.netlify/functions/seed-scan-background?board=catalyst&universe=russell2k`
gets a 202 and a 15-min background container doing 4 providers × ~2,037
tickers, with the result written through `writeSnapshot` to the production
`_latest` path. Repeated calls = provider-quota exhaustion
(Finnhub/Quiver/Polygon/Massive) + snapshot thrash. Also: `board` is
validated but `universe` is cast unchecked (`universe as TargetUniverseKey`,
line 99). Fix: require the same trigger token, validate universe.

## MAJOR

**2. `scan-status.ts` Firestore range query is degenerate — always returns
zero runs** — `netlify/functions/scan-status.ts:99`:
`const upperBound = idPrefix + '';` concatenates an *empty string*
(intended: `idPrefix + ''`). With
`orderBy('__name__','desc').startAt(upperBound).endAt(idPrefix)` the range
is exactly `[idPrefix, idPrefix]`; real doc IDs
(`insider-russell2k-20260518-213000`) sort above it and are excluded. The
diagnostic built to detect stalled scan chains can never see one. The test
(`__tests__/scan-status.test.ts:22-40`) hides this: its mock implements
`endAt` as `startsWith(prefix)` filtering — the *intended* semantics, not
Firestore's.

**3. Anthropic budget accounting uses 3× the real price** —
`shared/anthropic-budget.ts:27-29`: `OPUS_INPUT_USD_PER_MTOK = 15`,
`OPUS_OUTPUT_USD_PER_MTOK = 75`, commented "Opus 4.7 pricing". Actual Opus
4.7/4.8 pricing is $5/M input, $25/M output. Every preflight estimate and
`recordSpend` is inflated 3×, so the $25/day cap actually halts AI features
at ~$8.33 of real spend, and all spend telemetry is wrong.
`__tests__/anthropic-budget.test.ts:29-43` asserts the wrong constants,
locking the bug in. Related: `recordSpend` is a read-modify-write on Netlify
Blobs (`anthropic-budget.ts:132-138`) — concurrent invocations lose updates
and undercount; pricing is flat regardless of `body.model`.

**4. PIT look-ahead bias in `getEarningsHistory`** —
`shared/data-provider.ts:879-882`: with `asOfDate`, rows are filtered by
`r.date <= asOfDate` where `date` is the *fiscal period end* (`r.period`),
not the announcement/filing date. A Q1 report with period 2024-03-31
announced 2024-04-25 is visible to a backtest at asOf 2024-04-01 — three
weeks before the market knew it. The doc comment describes the right rule;
the code filters on the wrong field. Earnings-surprise-driven analysts get
systematically future-leaked data. (Quiver congressional trades have a
similar documented 45-day gap — political-provider.ts:72-85 — but that one
is at least acknowledged.)

**5. Unauthenticated, unrate-limited LLM endpoints (cost abuse)** —
`research.ts` and `chart-analysis.ts` call Claude per request with no per-IP
rate limit (contrast `prophet-narrate.ts:47-73`, 30/hr/IP), and
`research.ts:40` `force=1` bypasses the 30-min cache,
`chart-analysis.ts:121` cache key varies with arbitrary `lookback` so cache
is trivially bypassed. The daily budget caps blast radius, but any anonymous
client can burn the entire day's AI budget in minutes (made worse by #3: the
effective cap trips at 1/3 budget), DoS'ing AI features for the legitimate
user.

**6. `analysts-status.ts` registry has drifted from `analyst-runner.ts`** —
`analysts-status.ts:26-87` reports `macro-regime: 0.07` and
`patent-analyst: 0.06`, but `shared/analyst-runner.ts:73-84` has both at `0`
("REMOVED — no_upstream"). The status endpoint reports `totalWeight: 1.00`
vs the real 0.87 and shows removed analysts as live. The "Keep in sync"
comment is the only sync mechanism, and it failed.

## MINOR

7. `shared/rate-limiter.ts:211-219` — only numeric Retry-After parsed
   (HTTP-date silently ignored); Retry-After capped at maxBackoffMs (8s), so
   `Retry-After: 60` retries at 8s and likely 429s again.
8. `shared/rate-limiter.ts:26` — `Number(process.env.FINNHUB_RPM ?? 55)`:
   malformed env → NaN → silently disables pacing entirely.
9. `shared/rate-limiter.ts:88-96` — `acquireOne` sleeps once then
   force-consumes without re-checking; bounded drift.
10. `shared/anthropic-client.ts:80-100` — no timeout/AbortController on the
    Anthropic fetch; no retry on 429/529; `resp.json()` throwing bypasses
    both circuit recorders; any non-2xx (incl. 400/401) counts toward the
    circuit breaker → 5 malformed requests black out all AI surfaces 5 min.
11. `logo.ts:67` — cached branding URL from Firestore gets `?apiKey=`
    appended and fetched with no host allowlist; a poisoned tickerReference
    doc would exfiltrate the Polygon key. Also breaks if URL already has a
    query string.
12. `shared/insider-provider.ts:110-122` — the "2s enrichment budget" is
    dead code (Promise.all launches all lookups at t≈0); real bound is
    edgar-roles' 1.5s per-lookup timeout, which on cold start INCLUDES the
    ~800KB SEC ticker-map download → first batch predictably times out and
    caches `role: null` for 24h.
13. `shared/edgar-roles.ts:44-62` — transient failure fetching
    company_tickers.json caches an EMPTY map for the life of the warm
    instance (never retried) — silently disables all role enrichment.
14. `shared/massive-fundamentals.ts:101-103,147-149` — single 429 reported
    as `rateLimitExhausted: true` with zero retries; `statementKey` labels
    provider 'polygon' for Massive data (provenance pollution).
15. `shared/data-provider.ts:461-463` — `ttmEps` maps missing quarters to 0
    and sums (silent understatement) while `priorTtmEps` correctly tracks an
    ok flag. Inconsistent missing-data discipline on the same metric.
16. Cron collisions (schedules in code via `schedule()`): lynch ×4 universes
    AND scan-institutional-flow-largecap all fire at `0 22 * * 1-5`;
    target/williams/catalyst/prophet ×4 (~16 functions) share
    `0,30 13-21 * * 1-5`. Insider crons were deliberately staggered
    (21:30/35/40/45) precisely because shared slots caused 429 storms
    (rate-limiter.ts:20-24 documents this); the token bucket is
    per-invocation and cannot coordinate across simultaneous functions.
17. Timezone edges: fwd-returns cron `0 21 * * *` = exactly 16:00 ET in
    winter (same-day bars may not be final); intraday boards start 90 min
    before the open in winter; scan-target-board-russell2k `0 23 * * *` runs
    7 days/week.
18. `price-history.ts:69` — cache key is the UTC calendar date; a fetch
    during the US session caches the in-progress bar for the rest of the UTC
    day.
19. `ticker-info.ts:56-66` — error/404 responses share
    `Cache-Control: public, max-age=300` (negative edge caching).
20. `shared/logger.ts:63-82` — secret redaction only matches top-level keys;
    nested objects pass through; forwardErrorToSentry ships full merged ctx.
21. `chart-analysis.ts:116` — `lookback` unvalidated: NaN →
    `new Date(NaN).toISOString()` throws → 500; huge values pump unbounded
    Polygon ranges + unbounded in-memory cache. Comment says "Claude Sonnet"
    but model is Opus 4.7.
22. `diag-fundamentals-v1.ts` / `audit-stub-analysts.ts` — publicly routed,
    unauthenticated; diag makes 6 upstream calls per hit (key correctly
    redacted), audit does up to 800 snapshot reads + a Firestore write per
    anonymous GET; `days=NaN` survives the clamp.
23. `shared/with-timeout.ts` — never aborts the orphaned promise (documented
    by design); timed-out provider calls keep consuming rate-limit buckets.

## ANTHROPIC USAGE REVIEW

- Model IDs: `claude-opus-4-7` (research.ts:19, chart-analysis.ts:13) and
  `claude-opus-4-8` (prophet-narrate.ts:45, narrative-generator.ts:25) —
  both valid; 4.7 surfaces could be bumped to 4.8, nothing wrong.
- Budget accounting: wrong by 3× (#3); model-blind flat pricing; racy RMW.
- Prompt caching: not used anywhere — actually correct here (system prompts
  are far below the minimum cacheable prefix). No action needed.
- Circuit breaker/budget wiring is sound in shape, modulo #10.

## TESTS

- Meaningful: rate-limiter.test.ts (fake clock, real concurrency/backoff),
  with-timeout.test.ts, data-provider-insider-429.test.ts,
  massive-fundamentals / data-provider-pit / ticker-reference suites.
- Misleading: anthropic-budget.test.ts codifies wrong pricing;
  scan-status.test.ts mocks Firestore with intended (startsWith) rather than
  actual (range) semantics and passes on a production-broken query — the
  single most instructive test failure mode in this review.
- By-design loose: quiver schema tests ("drift sensors not gates") —
  near-tautological but documented as such.

## OVERALL

The infrastructure layer is unusually well-documented and the error-handling
philosophy (status envelopes, no silent empties, PIT cache discipline,
honest `_reasons`/`_degraded` maps) is genuinely good. Defects cluster in:
(a) unverified glue — the scan-status query and budget pricing were both
"confirmed" by tests that encode intent rather than reality; (b) auth
asymmetry — one trigger endpoint got a token gate, the more powerful seeder
didn't, and the LLM endpoints rely solely on a 3×-miscalibrated budget cap;
(c) PIT discipline gaps at the edges. Fix #1-#4 immediately (all small
diffs), add a shared token-gate + per-IP limiter across
research/chart-analysis/seed, and correct the two lock-in tests alongside
their bugs.

Open decisions: (a) token-gating seed-scan-background (breaking for existing
manual-seed tooling), (b) whether budget repricing keeps the *effective*
spend ceiling (raise ANTHROPIC_DAILY_BUDGET_USD) or the nominal one,
(c) whether diag-fundamentals-v1 stays public.
