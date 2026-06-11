# Track 3 — Backtesting Subsystem

~40 files read end-to-end (engine, batched engine, score-at-date, metrics,
portfolio harness, resume/checkpoint layer, PIT cache, universe history,
calendars, all in-scope functions + tests). 2 critical, 7 major, ~14 minor
findings. The infrastructure (checkpointing, batching, persistence) is
unusually well-engineered; the *economics* of the results are compromised by
two critical data-integrity defects.

## CRITICAL

**[C1] Portfolio backtest ranks historical dates with TODAY's Prophet
snapshot — wholesale look-ahead bias**
- `shared/prophet-portfolio/signal.ts:108-110`: `rankAtDate` does
  `snapshotBeforeDate(...) ?? latestSnapshot(...)`. When no snapshot exists
  at-or-before asOfDate, it silently falls back to the CURRENT live snapshot.
- `shared/snapshot-store.ts:469-480` (`pruneOldSnapshots`): runs history is
  pruned to the most recent 30 docs. Prophet snapshots only exist since the
  product went live; nothing backfills 2018–2024.
- `run-portfolio-backtest-background.ts:120-143`: windows span 2018-01-01 →
  2026-01-01 (`full`, `rolling-2018`…`rolling-2025`, `covid`, `rate-hikes`).
  For essentially every rebalance before ~30 scans ago, the harness trades
  today's top-ranked board against historical prices. That is simultaneously
  look-ahead AND survivorship bias (today's winners bought in 2018), and it
  is what feeds `portfolio-verdict`'s "≥5/8 rolling windows beat SPY" ship
  gate.
- The test suite PINS THIS AS CORRECT:
  `shared/prophet-portfolio/__tests__/signal.test.ts:179-188` ("falls back
  to latestSnapshot when no prior snapshot exists").
- Fix: in backtest mode, remove the fallback — return [] (and emit a loud
  warning / refuse the window) when no PIT snapshot covers asOfDate. Gate
  `windowSpec` to dates ≥ first stored snapshot. Longer-term: drive the
  portfolio harness from the regular engine's `scoreTickerAtDate` PIT path
  instead of the live snapshot store.

**[C2] Survivorship bias re-introduced in the regular engine: scorers drop
every ticker not in the CURRENT universe seed**
- All four scorers begin `const entry = UNIVERSE.find(u => u.ticker ===
  ticker); if (!entry) return null;` — `shared/backtest/score-at-date.ts:177,
  329, 415, 529`. `UNIVERSE` (`shared/universe.ts`) is the current 2026
  working set.
- The PIT pool (`universe-pool.ts` → `UNIVERSE_HISTORY`) is built correctly,
  but measured: 138/509 (27%) of the 2018-01-31 S&P 500 snapshot, 106/509 of
  the 2020-03-31 snapshot, and 836/2034 (41%) of the 2022-01-31 Russell 2000
  snapshot are missing from `UNIVERSE` — disproportionately the
  delisted/acquired/bankrupt names (DWDP, AAL, ATVI, BBBY, …). They return
  null silently — not counted in `tickerFailureTotal`, no warning
  (engine.ts:383-396 only warns for unsupported boards) — so the
  "survivorshipCorrected: true" stamp on Dow/S&P runs is false advertising:
  selection happens only among 2026 survivors.
- Fix: decouple scoring from `UNIVERSE`: resolve name/sector from a PIT
  reference (ticker-reference or the universe-history snapshot itself), and
  count "in pool but unscorable" tickers as a distinct warning metric. Until
  then, flip `survivorshipCorrected` to false whenever pool ∖ UNIVERSE is
  non-empty.

## MAJOR

**[M1] PIT cache permanently stores incomplete future-window bar fetches**
`engine.ts:546-550` / `engine-batched.ts:452-457`: ML rows fetch bars for
`[asOfDate-30, asOfDate+400]`. For any rebalance within ~13 months of
wall-clock today, the provider returns bars only through today, and
`pit-cache.ts` (no TTL "because PIT data is immutable") caches that
truncated array forever under key asOfDate+400. Re-runs months later hit the
stale entry: `forward60d/252dReturn` stay null permanently, IC sample stays
truncated, Phase-5 training data is permanently lossy. Same hazard for the
benchmark window when `endDate` ≈ today (`engine.ts:327-338`). Fix: never
cache a window whose `to` exceeds the fetch date.

**[M2] scan-resume stuck-run recovery query is a production no-op**

> **RETRACTED (Wave-1 verification, 2026-06-11).** Byte-level inspection of
> `finalize.ts:147` shows `.startAt(runIdPrefix + '\uf8ff')` — the U+F8FF
> sentinel IS present (it is invisible in rendered output, which is how it
> was misread as an empty string). The query is the canonical descending
> prefix scan and is correct. The finalize.test.ts mock's `startsWith`
> semantics match the correct production behavior. No fix needed.
`shared/scan-resume/finalize.ts:144-150`:
`.orderBy('__name__','desc').startAt(runIdPrefix).endAt(runIdPrefix)`. In
DESCENDING order, `startAt(prefix)` begins at IDs ≤ prefix, but every real
run ID (`prefix + timestamp`) is lexicographically GREATER than the bare
prefix — the range matches nothing. Correct form: `startAt(prefix +
'').endAt(prefix)`. Zombie `running` scan docs are never recovered.
The test passes only because the mock DB (`finalize.test.ts:59-85`)
re-implements the query as `id.startsWith(lower)` — a tautological test that
encodes the intended, not actual, Firestore semantics. (The backtest-side
`backtest-resume/recover.ts` uses a plain orderBy+filter-in-code and is
fine.)

**[M3] Delisting/halt losses are never realized**
Regular engine: `engine.ts:489` (`rets.find(...)?.ret ?? 0`) — a ticker with
no bars (delisted mid-segment) contributes 0% daily return; its weight rides
free until the next rebalance, where it exits at its last stale close
(`lastCloseAtOrBefore`). A bankruptcy reads as a flat hold. Portfolio
harness: `backtest-harness.ts:157` (`px ?? p.currentPrice`) and exit
`?? pos.currentPrice` (line 230) freeze the last traded price forever; a
delisted holding exits at its pre-delisting price with 0 loss. Combined with
C2 this systematically inflates returns. Fix: treat "no bar for >N trading
days" as a forced liquidation at last trade (or at 0 for bankruptcy-coded
delistings via Polygon's delisted-ticker status), and surface a warning.

**[M4] Portfolio harness marks equity on CALENDAR days but annualizes with
√252**
`run-portfolio-backtest-background.ts:106-118` (`makeWindow`): markDates =
every calendar day; rebalances every 7 calendar days.
`backtest-harness.ts:100-109` / `backtest-harness-batched.ts:413-422`:
Sharpe = mean/std × √252 over a ~365-obs/yr series → Sharpe understated by
≈ √(252/365) ≈ 17% for both portfolio and SPY; `longestUnderwaterDays` is
calendar days while the regular engine's `recoveryDays` is trading days —
inconsistent units in the same product. Fix: generate markDates from
`trading-calendar.tradingDaysBetween`.

**[M5] Duplicate tickers in UNIVERSE_HISTORY double portfolio weight**
e.g. `"ADRO","ADRO"` in the russell2k 2025-10-31 snapshot
(`universe-history.ts`). The dup flows: pool → scored twice → both occupy
`top` slots → `buildPortfolio`'s materialization loop
(`portfolio.ts:89-101`) emits two positions with full weight each → equity
marking (`engine.ts:487-491`) counts the weight twice, while
`diffPortfolios` (Map-keyed) books costs only once. Fix: dedupe in the
generator AND `sortedUnique` the pool in `universePoolForDate`.

**[M6] No concurrency guard on the portfolio path → duplicate runs of the
same window**
`portfolio-backtest-trigger.ts` has no single-flight (unlike
`backtest-runs-trigger.ts:215-241`), and
`scan-portfolio-backtest-cron.ts:119-124` picks any window whose latest doc
is not `done` — including one that is healthily `running` — so a slow
multi-batch window gets a second concurrent run fired at the next cron tick
(Polygon budget burn; `latest` flips to the new pending doc, confusing
`backtest-status`). Fix: treat fresh `pending`/`running` (cursor age < stale
threshold) as "in progress, skip".

**[M7] Resume can leave stale orphan rows in subcollections**
Worker order is append-subcollections → write cursor
(`run-backtest-background.ts:232-312`). A crash between them re-runs the
batch from the old cursor; doc ids are deterministic ONLY if the re-run
produces identical row counts. Scoring failures are nondeterministic (rate
limits), so a smaller re-run leaves the previous attempt's tail rows
orphaned at high indexes; `readAllSubcollection` (persistence.ts:312-323)
sweeps them into the final metrics (phantom trades/attribution/ml rows
pollute win-rate/IC). Low probability, silent corruption. Fix: stamp rows
with `batchIdx` and delete rows ≥ cursor watermark on resume.

## MINOR

1. Sortino denominator (`metrics.ts:160-168`): downside deviation = RMS over
   only the negative excess returns with n−1; the standard is
   √(Σ min(r,0)² / N_all). Overstates downside risk → understates Sortino.
2. Per-regime "Sharpe" (`metrics.ts:296`): annualizes CROSS-SECTIONAL
   per-position segment returns with √(252/20) — mixes cross-sectional
   dispersion with time-series vol; statistically meaningless.
3. Stale board list in the null-result warning (`engine.ts:383-394`):
   `target` was added but the warn condition still excludes only
   prophet/williams/lynch → every target run with one unscorable ticker
   emits a false "no PIT scoring path" warning.
4. Two divergent holiday calendars: `shared/backtest/trading-calendar.ts`
   (2018-2027, includes 2025-01-09 Carter closure) vs
   `shared/us-market-holidays.ts` (2024-2028, MISSING 2025-01-09).
   Consolidate.
5. `findInFlightRun` (`backtest-runs-trigger.ts:83-99`):
   `where('status','in',…).limit(20)` without orderBy — 20 stale pending
   docs can crowd out the genuinely fresh one → single-flight bypass.
6. Turnover double-counts both legs (`backtest-harness.ts:367-369`);
   convention is (buys+sells)/2. Reported turnover ~2× standard.
7. Regular engine holds weights CONSTANT through a segment
   (`engine.ts:484-494`) — implicitly a zero-cost daily rebalance,
   inconsistent with the trade/cost model. The portfolio harness's
   share-based model is the right pattern; port it over.
8. Fills: signal computed on asOfDate's close and filled at that same close.
   Standard but optimistic — next-day-open fills would be more honest,
   especially for the after-close snapshot pipeline.
9. Returns are price-only (Polygon adjusted=true is splits-only). Biases
   against high-yield strategies; the comment "PIT-safe: daily OHLCV does
   not revise" is wrong for adjusted bars (retroactive split adjustment).
10. `validateConfig` (`engine.ts:89-114`) doesn't reject future `endDate` →
    flat-equity tail dilutes CAGR/Sharpe + interacts with M1's cache
    poisoning.
11. Cursor-write race: post-dispatch telemetry `writeCursor`
    (`run-backtest-background.ts:346-356`) can theoretically clobber a fast
    successor's cursor (low risk).
12. `monthly` = +30 calendar days (`walk-forward.ts:27`) — cadence drifts;
    documented, acceptable.
13. Regime methodology (`shared/regime.ts`): VIX percentile over only ~90
    days (noisy); `rates.trend` hardcoded `'stable'`;
    `riskAppetite.ratioTrend`/`creditSignal` FABRICATED from the regime
    itself yet surfaced in the rationale as observed; missing-data defaults
    (VIX 18, 10y 4.1) are a 2024-era prior leaking into 2018 backtests. The
    VIX-level/curve classifier itself is reasonable.
14. STOCK Act shift (`stock-act-shift.ts`) is sound and conservative;
    correctly documented.

## METRICS FORMULA VERIFICATION (metrics.ts)

Total return, CAGR (trading-days/252 exponent), max drawdown, recoveryDays,
Sharpe (excess daily mean/std × √252), profit factor, IC (per-rebalance
Spearman with tie handling), IR (date-aligned daily diffs × √252): all
correct for the regular engine (which marks trading days only). Win rate is
gross of slippage — fine but should be labeled.
`attribution.segmentReturn` compounding is correct. Portfolio-harness
formulas correct per se but fed calendar-day series (M4).

## TEST QUALITY

- Strong: batched-vs-unbatched equivalence suites, bounded-cursor size
  assertions, walk-forward integrity (incl. a source-grep banning
  `new Date()`-derived windows), universe-history Dow membership facts,
  metrics synthetic curves (values verified correct),
  reinvoke/recover/watchdog suites.
- Defective: `signal.test.ts:179` asserts the C1 look-ahead fallback as
  desired; `finalize.test.ts` mock masks M2; no test exercises a
  delisted/non-UNIVERSE pool ticker (would catch C2), weekend-mark Sharpe
  (M4), or duplicate pool tickers (M5).

## OVERALL

Engineering quality (checkpoint/resume, bounded cursors, idempotent
subcollection writes, watchdog/reinvoke hardening, PIT plumbing, STOCK-Act
shift, filing-date double-filtering) is well above typical. But as a
measurement instrument the subsystem has two disqualifying defects: the
portfolio verdict pipeline is built on future snapshots (C1) and the regular
engine quietly selects only from 2026 survivors (C2). Fix C1+C2+M1+M3 before
trusting any number this subsystem produces; re-run all historical baselines
after the fixes — every stored result predates them.
