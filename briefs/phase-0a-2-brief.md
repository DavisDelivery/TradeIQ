# Phase 0a-2 — PIT universe-history backfill (sp500)

**Author:** orchestrator
**Target version:** no APP_VERSION bump (backfill is a data operation, not a code release). `MODEL_VERSION` unchanged.
**Dependencies:** none on TradeIQ code; needs internet access + Wikipedia + a symbol-activity verifier (Polygon already integrated; Databento optional second source).
**Parallel-with:** anything. Doesn't touch live code paths.

---

## Why this exists

Discovered 2026-05-14 while trying to clear Phase 5a's seed-run data gate. The `universeHistory/{universe}/{date}` Firestore collection — which the backtest engine reads to determine "what tickers were in universe X on date Y" — only has live coverage starting 2026-05-07 (when the scheduled `scan-universe-history-*.ts` functions started writing). Every historical backtest with a 2018-2024 window on `sp500` or `ndx` completes in 5 seconds with 0 trades because every rebalance date emits "universe pool empty (no PIT snapshot covers date)". Probe of `russell2k` ran 36+ min and never completed (treated as dead).

Only `dow` has working historical PIT coverage — and Dow's 30-name universe is too small to clear Phase 5a's 10k-row data gate even with many configs.

Phase 0a-2 fixes this for `sp500` (the highest-value universe; ~500 names with high diversity). Sub-phases 0a-2b (`ndx`) and 0a-2c (`russell2k`) will follow if/when needed; they're not in this brief's scope.

**Direct unblocks:**
- Phase 5a's data gate clears (2 sp500 monthly/top50 runs ≈ 8,400 rows).
- Any retrospective Prophet or Target board scoring against historical regimes.
- Any future backtest of newly designed strategies against sp500 over 2018-2024.

---

## Scope

**In scope:**
- Daily snapshots (or business-day; executor chooses) of `sp500` membership from 2018-01-01 to today.
- Survivorship-corrected: members at date D = exactly who was in sp500 on D, including tickers since delisted; excluding tickers added after D.
- Cross-verified against actual ticker trading activity on each date (a ticker in the snapshot must have had trades on that date).
- Written to existing `universeHistory/sp500/{YYYY-MM-DD}` collection in Firestore.
- DOES NOT overwrite documents at dates ≥ 2026-05-07 (live coverage zone; scheduled scan owns those).

**Out of scope:**
- ndx and russell2k backfills (sub-phases 0a-2b, 0a-2c).
- Pre-2018 history (sp500 composition + sector classifications meaningfully different; not needed for our backtest range).
- Sub-daily granularity (intra-day membership changes from mergers are collapsed to end-of-day).
- Corporate-action handling beyond ticker changes (splits/dividends are separate concerns handled by the existing data-provider layer).

---

## Sources

### Primary: Wikipedia historical S&P 500 events

The Wikipedia page **"List of S&P 500 companies"** maintains a structured table titled **"Selected changes to the list of S&P 500 components"** that catalogs every add/drop event with effective dates, going back to the 1970s. As of 2026-05-14 this table has ~600 rows covering 2018-present with high reliability.

Schema per row:
- `effective_date`: YYYY-MM-DD (the date the change took effect)
- `added_ticker`: string (ticker now in the index)
- `added_security`: string (company name)
- `removed_ticker`: string (ticker no longer in the index)
- `removed_security`: string (company name)
- `reason`: string (free-text; e.g., "Acquired by X", "Merger", "Spinoff", "Index rebalance")

Caveats:
- The table sometimes has multi-event days (one row per add, one per remove on the same date).
- Tickers occasionally change without an index event (corporate ticker change while remaining in index). Catch via a secondary symbology check.
- The table's structured-ness has improved over years; older rows (pre-2015) sometimes have free-text "added/removed" instead of separate columns. Stop the backfill at 2018-01-01 to avoid this.

Access pattern: fetch the page via `web_fetch` (one HTML pull, parse the table, cache locally as a JSON file in `data/sp500-add-drop-events.json` for reproducibility).

### Secondary: current sp500 membership

Get current membership from the same Wikipedia page's primary "Components" table (~500 rows, ticker + name + sector + sub-industry + headquarters + date_added + CIK). This is the *anchor point* from which the backward-walk algorithm starts.

### Verifier: ticker-activity source

For each (date, ticker) in the reconstructed membership: does the ticker have actual trading activity on that date? Two viable sources:

**Polygon** (already integrated):
- Use `GET /v3/reference/tickers/{ticker}` to check `active` + `delisted_utc`
- Use `GET /v2/aggs/ticker/{ticker}/prev?date=YYYY-MM-DD` for activity verification
- Free tier: 5 req/min — too slow for thousands of checks. Need paid tier or aggressive batching/caching.

**Databento** (Chad has account, not currently integrated):
- Use `dbn` Python client or REST API
- Dataset: `XNAS.ITCH` / `XNYS.PILLAR` / `equities-summary` (executor picks)
- Higher throughput; cleaner symbology for delisted tickers
- Cost: usage-based, but the verifier query is just "did ticker X have any trades on date Y" — minimal data volume

**Executor decision (W3):** pick one. If Chad has Databento API key handy, prefer that (cleaner delisted-ticker coverage). If not, use Polygon with aggressive caching (PIT cache layer can hold ticker-activity results indefinitely; once verified, never re-check).

---

## Algorithm: backward-walk membership reconstruction

```
1. Load current sp500 membership M = { ticker: { security, sector, dateAdded } }
2. Load add/drop event timeline E sorted by effective_date DESCENDING
3. For each business day D from today back to 2018-01-01:
     a. Write snapshot for D: members = current state of M
     b. Find all events with effective_date == D (could be 0..N events)
        For each event:
          - If event.added_ticker is set: REMOVE that ticker from M
            (it wasn't in the index before D)
          - If event.removed_ticker is set: ADD that ticker back to M
            (it WAS in the index until D)
     c. (Optional W5 verification step — see below)
4. Validate: at D = 2018-01-02, |M| should be ~505 (sp500 has been ~500-505
   throughout this period). If it drifts to <450 or >550, an event has
   been mis-parsed; surface to Chad before continuing.
```

The key correctness property: at any date D, M reflects who was in the index *on* D, not who's in the index today. A ticker added 2022-03-15 should NOT appear in any snapshot for D < 2022-03-15.

**Edge case — multi-event day:** Apply all events for the date *together* (not in arbitrary order) — the order shouldn't matter because adds and drops are disjoint, but the algorithm should be commutative regardless.

**Edge case — ticker changes:** Same company changes symbol (e.g., FB → META in 2022). This is NOT an index event in the add/drop table (the company stayed in the index, just changed ticker). Handle via a separate `ticker_symbol_changes.json` lookup table the executor builds from a small manually-curated list of the ~10-20 sp500 ticker changes in this date range. Surface the list in the final report for Chad to spot-check.

**Edge case — class shares:** GOOG vs GOOGL, BRK.A vs BRK.B, etc. The Wikipedia table is inconsistent about which class is "the" sp500 member. Defer to whichever class is currently listed; for historical, use whichever was listed at the time.

---

## W0 — Preconditions

1. `git fetch origin && git log --oneline -3 origin/main` — confirm clean main.
2. `npm ci && npm test` — establish test baseline.
3. Verify Wikipedia page is accessible and the "Selected changes" table parses cleanly via a small probe script (fetch the page, count the rows, sanity-check the most recent 10 events match known facts).
4. Confirm `universeHistory/sp500/2026-05-07` (the first live snapshot) exists and has a reasonable schema:
   ```
   members: string[~500]
   membersCount: number
   source: string
   generatedAt: Timestamp
   ```
   Backfill writes use the same schema with `source: 'phase-0a-2-backfill'`.

---

## W1 — Source ingestion

**Files:**
- `scripts/lib/wikipedia-sp500-events.ts` — fetch + parse Wikipedia
- `scripts/lib/wikipedia-sp500-current.ts` — fetch + parse current membership
- `data/sp500-add-drop-events.json` — committed cache of events (reproducibility)
- `data/sp500-current-members.json` — committed snapshot of current membership at backfill time
- `scripts/lib/__tests__/wikipedia-sp500-events.test.ts` — parser tests with fixtures

Implementation:
- One-time `web_fetch` of the Wikipedia page (or save the HTML locally and parse).
- Parse the `<table>` elements; cheerio or jsdom or a small custom parser.
- Normalize to the schema above.
- Filter to `effective_date >= 2018-01-01`.
- Save to JSON and commit.

Tests:
- Fixture-based parser tests: feed in known HTML snippets, assert known parsed output.
- Sanity check: the parsed events file should contain ~150-200 events for 2018-2024 (Wikipedia averages ~25 add/drop events per year).

---

## W2 — Symbol-activity verifier

**Files:**
- `scripts/lib/symbol-activity-verifier.ts` — single interface with two implementations
- `scripts/lib/symbol-activity-polygon.ts` — Polygon adapter
- `scripts/lib/symbol-activity-databento.ts` — Databento adapter (optional; gate behind `--use-databento` flag)
- `scripts/lib/__tests__/symbol-activity-verifier.test.ts` — mocked-adapter tests

Interface:
```ts
export interface SymbolActivityVerifier {
  /** Returns true if the ticker had any trading activity on the given date. */
  hadActivity(ticker: string, date: string): Promise<boolean>;
  /** Returns the date the ticker was delisted, or null if still active. */
  delistedAt(ticker: string): Promise<string | null>;
}
```

The verifier is called once per (ticker, date) pair we need to check. With 500 tickers × 7 years × ~252 trading days / year × random spot-check (W5 verifies 1% of pairs), that's ~9,000 calls. Cache results in `data/cache/symbol-activity-{provider}-{ticker}.json` after first verification.

For Polygon free tier (5 req/min): the W5 sampling is ~30 hours of wall-clock if uncached. Recommend executor either (a) use Databento (likely <30 minutes total), (b) use Polygon paid tier if Chad has it, or (c) reduce W5 sampling to 0.1% of pairs (~900 calls; 3 hours on Polygon free).

---

## W3 — Backward-walk membership reconstruction

**Files:**
- `scripts/backfill-pit-universe-sp500.ts` — main backfill script
- `scripts/lib/membership-walker.ts` — the algorithm in isolation
- `scripts/lib/__tests__/membership-walker.test.ts` — algorithm tests

Algorithm tests (fixture-based, no I/O):
- Given current members {A, B, C} and event "added X on 2022-01-15", at 2022-01-14 members should be {A, B, C} - {X} = {A, B, C} (X wasn't added until 15th).
- Given current members {A, B, C} and event "removed Y on 2022-03-20", at 2022-03-19 members should be {A, B, C} + {Y} = {A, B, C, Y} (Y was still in until 20th).
- Multi-event day: 2 adds + 1 drop on same date applied correctly.
- Idempotency: applying the same event timeline twice yields the same result.

---

## W4 — Firestore writes

**Files:**
- `scripts/backfill-pit-universe-sp500.ts` continued

Implementation:
- For each business day D in 2018-01-01 to today:
  - Compute snapshot via the walker
  - Validate (W5 below)
  - Write to `universeHistory/sp500/{YYYY-MM-DD}` with schema matching the live writes
  - SAFEGUARD: skip writes for `D >= 2026-05-07` to avoid clobbering live snapshots
  - Log every write to a local `data/backfill-log.jsonl` for audit

Use batched writes (Firestore supports 500 ops per batch). ~2,000 business days / 500 = 4 batches. Should complete in <5 minutes wall-clock on the writes side.

Idempotency: running the script twice should produce identical results. The script SHOULD detect existing backfill docs (with `source: 'phase-0a-2-backfill'`) and either skip or overwrite based on a `--force` flag.

---

## W5 — Survivorship + activity verification

**Files:**
- `scripts/lib/survivorship-verifier.ts`
- `scripts/lib/__tests__/survivorship-verifier.test.ts`

For each daily snapshot:
- `membersCount` should be 500 ± 10 (sp500 has been very stable in this range; meaningful drift indicates a parse error).
- Sample 1% of (date, ticker) pairs and call `symbol-activity-verifier.hadActivity(ticker, date)`. All should return true. Any false = the ticker was in the reconstructed membership but had no trading activity = membership data is wrong.
- For each ticker that appears in any snapshot but is currently delisted: confirm `delistedAt(ticker) > min(date_in_snapshot)` (the ticker should not have been delisted before its first appearance).

Surface all verification failures in the final report; allow the backfill to complete with warnings (don't abort), but Chad should review the failures before declaring the backfill production-ready.

---

## W6 — Acceptance test

**Files:**
- `scripts/test-backfill-acceptance.ts`

After backfill completes, fire the Phase 5a baseline sp500 config that previously failed:

```bash
curl -sS -X POST https://tradeiq-alpha.netlify.app/api/backtest-runs/start \
  -H "Content-Type: application/json" \
  -d '{
    "universe": "sp500",
    "startDate": "2018-01-01",
    "endDate": "2024-12-31",
    "rebalanceFrequency": "monthly",
    "board": "prophet",
    "portfolio": {
      "topN": 50,
      "weighting": "equal",
      "maxPositionPct": 0.05,
      "maxSectorPct": 0.40,
      "cashSleeve": 0.00,
      "minComposite": 50
    },
    "costs": { "slippageBps": { "sp500": 10 }, "commission": 0 },
    "initialCapital": 100000
  }'
```

Acceptance criterion: the run completes with **`trades > 0` and `mlTrainingCount >= 3000`** (not 0). If it produces 0 trades, the backfill didn't work; debug before declaring done.

---

## W7 — Report

**Files:**
- `reports/phase-0a-2/backfill-report.md`

Contents:
- Total business days written: N
- Date range: YYYY-MM-DD to YYYY-MM-DD
- Total unique tickers across all snapshots: N (expected ~700-800; the union of all sp500 members 2018→present, including ~200 that have since been removed)
- Membership count statistics: min, max, mean, stdev (expected: 500 ± 5)
- Events applied: N (~150-200 expected)
- Verification: N pairs sampled, M failed (target: M=0; M > 5 = action needed)
- Acceptance test result: ✓ / ✗ (the W6 curl above)
- Known limitations: list ticker symbol changes that may not be caught, class-share ambiguities, etc.

---

## W8 — ORCHESTRATOR update + PR description

**Files:**
- `ORCHESTRATOR.md` — mark 0a-2 row done with summary
- `briefs/phase-0a-2-pr-description.md` — PR description

Phase 5a's row in ORCHESTRATOR can be updated post-0a-2: change "blocked on data gate" to "unblocked; pending re-fire of seed runs".

---

## Verification (before opening PR)

1. `npx tsc --noEmit` — clean.
2. `npm test` — passing; new tests added grow count by 10-15.
3. `node scripts/backfill-pit-universe-sp500.ts --dry-run` — completes without errors, prints summary stats.
4. `node scripts/backfill-pit-universe-sp500.ts` — completes; writes to Firestore.
5. W6 acceptance curl — `trades > 0` and `mlTrainingCount >= 3000`.
6. Spot-check 3 historical dates against external sources:
   - 2020-03-23 (COVID bottom): should NOT include any post-2020 IPOs like ABNB or RIVN; SHOULD include ones since removed
   - 2018-06-15: should include GE (removed Jun 2018) ✓ or ✗ depending on which side of Jun 25
   - 2022-12-30: should include Twitter/TWTR if still listed, or be marked removed

---

## Out of scope (explicitly)

- **ndx + russell2k backfills.** Same algorithm, different sources (Wikipedia "Nasdaq-100" page for ndx; Russell publishes their reconstitution events differently). Phase 0a-2b and 0a-2c after this lands.
- **Historical sector mapping.** Snapshot writes only `members: string[]`. Sector-as-of-date is a different (harder) reconstruction. Defer.
- **Index weighting reconstruction.** Snapshot is membership only, not weights. We don't currently use index weights anywhere in the backtest engine.
- **Bloomberg / FactSet / S&P direct license.** These are the "right" sources for index membership but cost $20k+/year. Wikipedia is accurate enough for our backtest accuracy needs.

---

## Files target

```
scripts/lib/wikipedia-sp500-events.ts                       NEW   ~150
scripts/lib/wikipedia-sp500-current.ts                      NEW   ~80
scripts/lib/symbol-activity-verifier.ts                     NEW   ~60
scripts/lib/symbol-activity-polygon.ts                      NEW   ~120
scripts/lib/symbol-activity-databento.ts                    NEW   ~140 (optional gate)
scripts/lib/membership-walker.ts                            NEW   ~120
scripts/lib/survivorship-verifier.ts                        NEW   ~100
scripts/lib/__tests__/wikipedia-sp500-events.test.ts        NEW   ~200
scripts/lib/__tests__/symbol-activity-verifier.test.ts      NEW   ~150
scripts/lib/__tests__/membership-walker.test.ts             NEW   ~200
scripts/lib/__tests__/survivorship-verifier.test.ts         NEW   ~100
scripts/backfill-pit-universe-sp500.ts                      NEW   ~200
scripts/test-backfill-acceptance.ts                         NEW   ~80
data/sp500-add-drop-events.json                             NEW   ~30k (data; ~200 events × ~150 chars)
data/sp500-current-members.json                             NEW   ~50k (data; ~500 members × ~100 chars)
data/backfill-log.jsonl                                     NEW   gitignored (run output)
reports/phase-0a-2/backfill-report.md                       NEW   ~300
briefs/phase-0a-2-pr-description.md                         NEW   ~200
ORCHESTRATOR.md                                             EDIT  ~5
.gitignore                                                  EDIT  add data/backfill-log.jsonl, data/cache/
```

~15 files, ~2,000 net lines of code + ~80kb of committed data. Single PR.

---

## Note to the executing agent

The temptation will be to skip verification (W5) because Polygon's free-tier rate limit makes it slow. **Don't.** A backfill that's silently wrong is worse than no backfill: every downstream backtest (including Phase 5a's binding deliverable) will read garbage data and produce confidently wrong conclusions.

If you must reduce sample size to make the verifier finish in reasonable wall-clock, document it explicitly in the report — "1% sampling cut to 0.1% due to Polygon rate limit; 900 pairs checked of ~900k possible". That's honest. Cutting verification entirely without disclosure is not.

If Chad has Databento credentials handy, prefer that adapter. Cleaner data for delisted tickers and no rate-limit anxiety. Ask in your first follow-up message after the PAT.

Be honest in the W7 report about the failure modes you encountered. Membership reconstruction from public data has known edge cases; the report should enumerate the ones you hit so the next person (or the audit cron in production) knows what to watch for.
