# Track 2 — Prophet Pipeline + Snapshot System

4 critical, 9 major, ~12 minor findings. The recent freshness fixes
(#67–#72) are internally consistent as point patches but are papering over
two structural problems: (a) Prophet's scheduled scans almost certainly
cannot complete on the platform they're deployed to, and (b) the
partial/degraded-publish discipline that exists for largecap and the
insider/target boards was never applied to the russell/all Prophet paths or
to prophet-picks reads.

## 1. CRITICAL

**[C1] Prophet crons run 10–14-minute scan bodies inside synchronous
scheduled functions**
- `netlify/functions/scan-prophet-largecap.ts:29` (runProphetSnapshot inline, 14-min budget)
- `netlify/functions/scan-prophet-russell.ts:26` (14-min sieve + 1-min narrate inline)
- `netlify/functions/scan-prophet-all.ts:26` (14-min scan + 2-min narrate inline)

Netlify scheduled functions execute with synchronous-function limits; only
`*-background` functions get the 15-min container. The repo knows this:
scan-insider-russell2k.ts:1-23 exists precisely as a thin cron →
background-worker dispatcher, and scan-prophet-largecap-trigger.ts:15-19
says verbatim "A synchronous Netlify function is capped at ~26s, so this
trigger does NOT run the scan itself." Yet all three Prophet crons run the
scan in-handler. netlify.toml configures no timeout for them. Most likely
production behavior: the crons are killed mid-scan, writeSnapshot never
runs, snapshots are only refreshed when someone fires the manual background
trigger — which is exactly the symptom #67 ("largecap serves the warm
snapshot") and #72 ("never live-scan; serve stale") were patching around.
ACTION: verify in function logs (look for `prophet_snapshot_written` from
the cron invocations); restructure all three as thin cron → `-background`
worker (the pattern already proven in insider/target), with
checkpoint-resume for russell/all.

**[C2] Regime-adjusted layer weights are not renormalized → composite scale
shifts by regime**
`netlify/functions/shared/prophet-layers.ts:935-944`
BASE_WEIGHTS sum to 1.00. Risk-on override (momentum=0.15, fundamental=0.12)
sums to 0.93; risk-off (fundamental=0.20, catalyst=0.18) sums to 0.83. So in
risk-off the maximum possible composite is 83: conviction HIGH (≥80,
composeProphet:952) is nearly unreachable, the LOW cutoff (≥50) behaves like
≥60, and minComposite=50 in the portfolio signal (signal.ts) silently
tightens. Composites are not comparable across snapshots taken in different
regimes — which poisons the decisionLog/forward-return training data and any
backtest that crosses a regime boundary. FIX: divide by the weight sum after
override (or specify overrides as full normalized weight vectors).

**[C3] Live mark-to-market is wrong across splits and ignores dividends**
`netlify/functions/scan-prophet-portfolio-mtm.ts:57-66` (recomputeMarks), types.ts:9-18
Positions persist fixed `shares` from entry; daily marks use Polygon
previous close (split-adjusted, data-provider.ts:93 `adjusted=true`). On a
2:1 split the mark halves while shares stay fixed → equity instantly shows
~-50%, dailyReturn craters, and the equity curve is permanently corrupted
(state is mutated and re-persisted). Dividends are never credited, so
portfolio return is price-only while the verdict gate compares it to SPY
(also price-only — consistent, but both understate, and the
portfolio/benchmark gap is biased by yield differences). FIX: ingest Polygon
splits/dividends and adjust shares/credit cash on ex-dates, or stop
persisting shares and chain daily returns from adjusted closes.

**[C4] russell/all scheduled scans promote partial/truncated scans as
canonical**
`netlify/functions/scan-prophet-all.ts:56-64`, `scan-prophet-russell.ts:56-86`
Neither writes `status`, so writeSnapshot (snapshot-store.ts:380) treats
every run as complete and swaps `_latest` — even when runProphetScan reports
budgetExceeded (the 'all' universe ~2,200 names at concurrency 7 in 14 min
essentially always truncates) or when every sieve stage was partial. This
violates the PR-H hard rule ("NEVER overwrite a good complete snapshot…")
that scan-prophet-largecap honors via runProphetSnapshot
(prophet-snapshot-runner.ts:78-79). The publish guard
(assessSnapshotPublish, snapshot-store.ts:203) is never invoked anywhere in
the Prophet path, so a data-provider outage that yields 0/near-0 picks also
swaps _latest unchallenged. FIX: set status from budgetExceeded/sieve
partial flags, and run the publish guard.

## 2. MAJOR

**[M1] prophet-picks.ts contradicts the #72 "serve stale, never live-scan"
architecture** — `prophet-picks.ts:102-121`
target-board.ts (the #72 reference implementation) serves stale snapshots
flagged `stale: true` for big universes and never inline-scans.
prophet-picks instead: (a) stale largecap → fallback-partial LIVE scan of
the 508-name universe in an 18s budget (every weekend: Friday-22:00 snapshot
exceeds the 26h budget Saturday night, so all Sunday/Monday-daytime traffic
live-scans partial); (b) stale russell/all → returns `snapshotNotBuilt:
true` with the false reason "does not yet have a scheduled after-close scan"
(both have crons; see C1) while discarding the stale snapshot it just read.
FIX: mirror target-board — serve stale-flagged snapshots for all three
universes.

**[M2] Fixed 26h freshness cannot model the scan calendar (weekend/holiday
gaps)** — `snapshot-store.ts:108-121`
Friday-close → Monday-close gap is ~74h; holiday Mondays push to ~98h. With
a daily 22:00 UTC scan and a 26h constant, snapshots are "stale" for most of
every weekend by construction; the only reason boards work weekends is the
serve-stale fallback (where it exists — not in prophet-picks, see M1). FIX:
freshness should be schedule-aware — "fresh ⇔ generatedAt ≥ last expected
successful scan slot (skipping weekends/holidays via us-market-holidays.ts)"
— plus alerting on `lastSuccessfulScanAt` age, instead of ever-wider
constants.

**[M3] snapshotBeforeDate / PIT reads include non-promoted partial
snapshots** — `snapshot-store.ts:630-651`; consumer: `prophet-portfolio/signal.ts:109`
Partial snapshots are deliberately written to runs/ "for diagnostics" and
NOT promoted (snapshot-store.ts:374-380) — but snapshotBeforeDate queries
runs/ directly with no status filter. The backtest ranking signal and PIT
fallbacks can therefore rank from exactly the partial junk the promotion
guard excluded. FIX: filter status != 'partial' (and consider skipping
degraded) in snapshotBeforeDate.

**[M4] _latest promotion race: later-finishing older scan overwrites newer
snapshot** — `snapshot-store.ts:389-406`
The transaction blind-sets the pointer. Overlap is real: russell crons fire
every 30 min while a sieve run takes ~15 min; manual largecap trigger can
overlap the 22:00 cron. A scan that STARTED earlier but finished later moves
_latest backwards. Also snapshotIdFor has minute granularity — two
same-minute runs collide on the runs/ doc id. FIX: inside the transaction,
read _latest and only promote if new generatedAt is newer.

**[M5] Forward-return populator can starve permanently**
`scan-prophet-portfolio-fwd-returns.ts:84-129`; `state.ts:157-169`
listDecisionLogRowsOlderThan returns the OLDEST ≤200 rows. Rows that can
never resolve (delisted ticker → no bars → no patch written; or a window
whose exit bar falls past the fixed toDate) are retried forever and stay at
the head. Once 200 unresolvable rows accumulate, no younger row ever gets
labels — silently killing the Phase 5c training substrate. FIX: write
explicit null/`exhausted` markers after N attempts or a maturity horizon, or
paginate with a cursor.

**[M6] Backtest harness: a rebalance date absent from markDates disables ALL
later rebalances** — `prophet-portfolio/backtest-harness.ts:199`
`date === rebalanceDates[rebalanceIdx]` never matches if a rebalance date
isn't a mark date (holiday/misaligned calendars), and the index never
advances past it — every subsequent rebalance is skipped and the run quietly
degrades to buy-and-hold. FIX: `while (rebalanceIdx < n &&
rebalanceDates[rebalanceIdx] <= date) …`.

**[M7] Backtest look-ahead: signal and fill on the same close**
`backtest-harness.ts:201-231` + `signal.ts:105-110`
rankAtDate(D) uses the snapshot generated ~22:00 UTC on D (built FROM D's
close), and the harness then buys/sells at D's close — a fill that was not
obtainable when the signal became available. Backtest results are
optimistically biased; the SHIP verdict (portfolio-verdict.ts) rests on
them. FIX: execute at D+1 (open, or close with the signal from D-1).

**[M8] #69's universeChecked is cosmetic, not coverage**
`prophet-sieve/index.ts:147` (universeChecked = opts.entries.length unconditionally)
If Stage 1 hits its 2-min budget and scores only ~1,200 of 1,928, the
snapshot still reports universeChecked=1928 ("Russell boards read ~1928" per
the commit). True coverage is sieve.stage1.scored; surfacing entries.length
as "scanned" misleads the UI and the publish/QA reading. FIX: report
stage1.scored as checked, entries.length as universe size.

**[M9] MTM cron timing/holiday handling**
`scan-prophet-portfolio-mtm.ts:90` (cron `0 21 * * 1-5`, no isMarketClosed guard)
21:00 UTC is 4:00pm EST in winter — exactly at the close, before EOD
aggregates settle, so the curve point dated `today` may carry the prior
session's closes (date/value misalignment in the equity curve and benchmark
columns). It also runs on NYSE holidays (unlike scan-prophet-largecap.ts:33
which guards), writing flat duplicate points; and `dailyReturn` across
weekends/holidays is a multi-day return labeled daily. FIX: run 22:00 UTC,
add the isMarketClosed guard, and derive point date from the bar's own date.

## 3. MINOR

- `prophet-sieve/index.ts:76-86` — barsCache prefetch is an unbounded
  Promise.all over up to 600 tickers (concurrency spike between two
  carefully budgeted stages).
- `prophet-sieve/stage2.ts:173-203` — rsVsSpy and peExpansion use positional
  offsets (bars[len-60] vs spyBars[len-60], bars[len-252]) assuming aligned
  series; halts/IPOs/missing days skew the comparison window. Align by date.
- `prophet-picks.ts:131` — fallbackCache key omits `limit`; a cached
  limit-30 body is served to a limit-5 request.
- `full-scan-iterator.ts:42-61` — `concurrency` option is dead (only
  batchSize used) and execution is batch-stepped (head-of-line blocking on
  the slowest item per batch); scan-prophet.ts:200 does an O(n²)
  `scanList.find` per ticker.
- `prophet-narrate.ts:92-153` — unauthenticated POST with fully
  client-controlled composite/layers is persisted to the shared Firestore
  thesisCache keyed (ticker, snapshotDate): trivially poisonable cache
  served to all users; also the per-IP rate-limit Map grows unbounded per
  container.
- `prophet-layers.ts:156` — adx() returns unsmoothed DX (acknowledged) yet
  gates the structure layer pass at ≥15; prophet-layers.ts:271 —
  `sma200Slope` is computed over the last 100 closes (mislabeled).
- `prophet-layers.ts:968-976` — stop = max(sma20*0.97, latest − 2·ATR) can
  sit ABOVE entry when price is under the 20d SMA; targets/stop emitted with
  no sanity ordering check.
- `scan-prophet.ts:282-285` + `prophet-layers.ts:855-923` — all
  Quiver-backed catalyst inputs are `.catch(() => null)`; a provider outage
  silently turns the heaviest layer (weight 0.30) into ~score-30/fail for
  the whole universe with no degraded flag on the snapshot (compounds C4).
- No prophet path ever calls pruneOldSnapshots (only insider/target do):
  russell+all write up to ~36 snapshots/weekday at up to 800KB each — runs/
  grows unbounded.
- `audit-prophet-layers.ts:130-131` — `days=30` actually means "most recent
  120 docs", not 30 days; the sample is qualified picks only (survivors),
  biasing layer stats the stub-detector consumes; the GET endpoint is
  unauthenticated yet writes archive rows.
- `portfolio-verdict.ts:88-102` — latestPerWindow keeps only the NEWEST doc
  per window: a newer failed run masks an older done-at-active-version
  result, regressing the verdict to PENDING.
- `prophet-portfolio.ts:141-153` — "sinceInception" metrics computed over
  the last 252 curve points only (listEquityCurve limit), mislabeled once
  history exceeds 1y.

## 4. ALGORITHM ASSESSMENT — how I'd design it

- **Sieve**: the 3-stage funnel is a sound cost pyramid and Stage 1's
  cross-sectional percentile ranking is the right idea. Weaknesses:
  Stage-2's gate (stage2.ts:computeStage2Gate) is a hand-copied duplicate of
  prophet-layers.computeEarningsQualityGate — two implementations that WILL
  drift; extract one shared gate. Stage budgets are fixed constants with no
  carry-over. Layer scores are additive hand-tuned step functions;
  cross-sectional ranks (as in Stage 1) would be more stable than absolute
  thresholds, and the 5/7-pass + composite≥X conviction bands interact
  opaquely with C2's unnormalized weights.
- **Returns**: forward returns (decision-log.ts:110-165) use a consistent
  single-fetch adjusted series with first-bar-on/after-target alignment —
  correct for splits within a row, but windows are CALENDAR days labeled
  like trading-day windows, and Polygon adjusted=true is splits-only, so all
  "returns" exclude dividends (portfolio AND benchmarks). The live MTM (C3)
  is the weakest link: persisting share counts against an adjusted price
  feed is structurally unsound — prefer chaining daily position returns from
  the adjusted series, with explicit corporate-action events.
- **Rebalance rule** (rebalance.ts) is clean and well-tested; note
  "worst-fallen first" is approximated by holdDays descending
  (acknowledged), and sector caps consider survivors correctly including
  deferred exits.

## 5. SNAPSHOT/FRESHNESS ARCHITECTURE VERDICT

"Snapshot-first + never-live-scan-large-universes + serve-stale" is the
right architecture for a 26s request ceiling. But the current state is
incoherent: (1) the producers are likely broken at the platform level (C1)
and the freshness constants were widened to hide the resulting gaps; (2) the
consumer-side #72 rule was applied to target/williams/catalyst but NOT to
prophet-picks (M1); (3) partial-publish discipline exists only on the
largecap path (C4); (4) a constant 26h budget can't represent the trading
calendar (M2). Edge cases that currently misbehave: weekends (stale by
Sunday), holiday Mondays, a single failed/killed cron (no retry, no alert —
silence until staleness), and partial scans (promoted on russell/all, leak
into PIT reads everywhere). The coherent end-state: every scan = thin cron →
background worker with checkpoint/resume + publish guard + status stamping;
freshness = schedule-aware predicate; reads = fresh → stale-flagged →
explicit-missing, never inline scans; plus a health alert on snapshot age
per board+universe.

## 6. TESTS

Mostly meaningful, hermetic, behavior-pinning: rebalance.test.ts covers real
rule edges (sector caps, swap budget, min-hold bypass); backtest-harness
tests verify mechanics with synthetic prices; prophet-snapshot-runner pins
the no-Claude rule with a static source check + spies; publish-guard and
trim-doc-limit tests exercise real thresholds. Gaps that map 1:1 to the bugs
above:
- NO test for prophet-picks' freshness/fallback branches (target-board got
  target-board-snapshot-only.test.ts for #72; prophet did not). The single
  most under-tested risky surface.
- snapshot-store-4h.test.ts:88-111 builds snapshots WITHOUT the `board`
  field, so it exercises only the legacy freshnessBudgetMs fallback — the
  actual #71 change has zero coverage.
- No test pins composite weight normalization across regimes (would have
  caught C2).
- fwd-returns/decision-log tests use 7-days-a-week linear bars —
  weekend/holiday gap alignment and the never-maturing-row path (M5)
  untested.
- mtm test covers only the pure happy-path helper; no
  split/holiday/duplicate-date case.
- No test for harness rebalance/mark date misalignment (M6).

## Deviations from brief premise

- The brief framed #67-#72 as "freshness fixes to scrutinize": evidence says
  they are compensating controls for producers that likely never run to
  completion (C1). Verify against production logs before refactoring.
- prophet-picks' comment "Russell / All do NOT yet have a scheduled scan" is
  factually contradicted by scan-prophet-russell.ts / scan-prophet-all.ts
  in-tree.

OVERALL: The deterministic scoring core (prophet-layers, sieve stages,
rebalance rule) is decent, readable, and reasonably tested. The system
around it — scheduling, publish discipline, freshness semantics, and live
portfolio accounting — has accumulated contradictory per-board patches;
#67-#72 widened windows and suppressed live scans instead of fixing
producers and making staleness schedule-aware. Do not trust the portfolio
backtest verdict or the live equity curve until C2, C3, M6, and M7 are
fixed.
