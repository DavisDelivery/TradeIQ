# Phase 0a-2 Executor Kickoff — PIT universe-history backfill (sp500)

> **For Chad:** paste this entire file as the opening message of a new
> Claude conversation. The GitHub PAT is embedded inline in PART 1.
> If your Databento account is ready and you'd like to use it as the
> symbol-activity verifier (recommended over Polygon for this work),
> paste the Databento API key as your second message in that
> conversation. Otherwise the agent falls back to Polygon's free tier.

---

You are an executor agent. Your single assignment is **Phase 0a-2 —
PIT universe-history backfill for sp500** in the TradeIQ project. The
conversation you're reading right now is your complete boot prompt.
Do not ask Chad to explain TradeIQ or re-summarize anything below —
read end-to-end, then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. Its backtest engine reads
point-in-time (PIT) universe membership from a Firestore collection
`universeHistory/{universe}/{YYYY-MM-DD}` to know which tickers were
in `sp500` / `ndx` / `russell2k` / `dow` on any historical date. Owner:
Chad Davis. Stack: TypeScript Netlify functions + React 18 / Vite SPA
+ Firestore + Polygon / Finnhub / Quiver / FRED. The
`universeHistory` collection is populated daily by scheduled
`scan-universe-history-*.ts` functions, but those only started writing
2026-05-07 — so historical dates before that have no PIT snapshot.

## Your assignment in two sentences

Backfill `universeHistory/sp500/{YYYY-MM-DD}` documents for every
business day from 2018-01-01 to today, with survivorship-corrected
membership reconstructed from Wikipedia's "List of S&P 500 companies"
add/drop event timeline. The acceptance test is **fire a sp500
backtest for 2018-2024 and confirm it produces `tradeCount > 0` and
`mlTrainingCount >= 3000`** — the same baseline config that previously
returned 0 trades because of the coverage gap this phase fixes.

---

# PART 1 — COLD START

## 1.1 Boot commands (literal, in order)

```bash
# Working directory
mkdir -p /home/claude && cd /home/claude

# Clone (PAT is embedded in the URL below — write-scoped, repo)
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ

# Confirm you landed on a current commit
git log --oneline -6
# Expected to include (top of list, in some order):
#   phase-0a-2: brief for sp500 PIT universe-history backfill
#   fix: surface upstream error code from prophet-narrate (#26)
#   phase-5a: data-gate blocked; pivot to 4f
#   phase-5a: re-spec seed runs against Dow
#   phase-4a trigger: opt-in single-flight bypass (#25)

# Identity for your commits
git config user.email "executor-0a-2@tradeiq.local"
git config user.name "Executor 0a-2"

# Install + verify baseline
npm ci
npx tsc --noEmit             # must be clean
npm test                     # note baseline count (522 as of brief commit)
npm run build                # must complete cleanly

# Create your branch
git checkout -b phase-0a-2-sp500-pit-backfill
```

If any of the above fails, STOP and report to Chad with the exact
output. Don't proceed on a poisoned baseline.

## 1.2 Secrets handling

**Inline:**
- **GitHub PAT** (write-scoped, `repo`): already in the clone URL above.
  Used for: `git push`, `POST /pulls` (PR open).

**Provided by Chad in his next message after this kickoff (optional):**
- **Databento API key** for the symbol-activity verifier (W2). If
  Chad provides one, use the Databento adapter
  (`scripts/lib/symbol-activity-databento.ts` — you'll build it in W2)
  for fast verification (~30 min total). If Chad does NOT provide one,
  fall back to the Polygon adapter against the free tier — slow (~3-30
  hours for 1% sample verification) but it works.

You will NOT need:
- Firebase service-account JSON (the backfill writes to Firestore
  using the existing Netlify-side admin-SDK config — but the BACKFILL
  ITSELF runs locally and needs SA credentials to write. Hmm, this is
  the only case where you DO need it. See W6 implementation.)

**Correction on Firebase SA:** since the backfill writes to live
Firestore from a local script (not from a Netlify function with env
already provisioned), you DO need a Firebase service-account JSON.
Pause after W5 (membership reconstruction in memory) and ask Chad to
provide it. He'll paste the JSON as a message in that conversation;
save to `.secrets/firebase-sa.json` (gitignored — confirm
`.gitignore` already excludes `.secrets/` before saving). Then export
`GOOGLE_APPLICATION_CREDENTIALS="$(pwd)/.secrets/firebase-sa.json"`
before running the W6 writes.

Never commit any of these secrets to the repo. Never print them to
logs beyond standard initialization messages. Never include in test
fixtures.

If you commit a secret by accident: stop, surface to Chad
immediately, rotate the relevant key. Do NOT try to scrub git history
yourself — that's a careful operation Chad will direct.

---

# PART 2 — REPO ORIENTATION

## 2.1 Directory map

```
TradeIQ/
├── briefs/
│   ├── phase-0a-2-brief.md          ← embedded below in PART 3 (also on disk)
│   ├── phase-4f-brief.md            ← parallel agent's work — don't touch
│   ├── phase-5a-schema-notes.md     ← reference: explains why 0a-2 exists
│   └── phase-0a-2-pr-description.md ← YOU CREATE at end (W8)
├── kickoffs/
│   └── phase-0a-2-executor.md       ← this file
├── reports/
│   └── phase-0a-2/                  ← YOU CREATE
│       └── backfill-report.md       ← W7 deliverable
├── scripts/
│   ├── lib/                         ← YOU CREATE most of this
│   │   ├── wikipedia-sp500-events.ts        ← W1
│   │   ├── wikipedia-sp500-current.ts       ← W1
│   │   ├── symbol-activity-verifier.ts      ← W2 interface
│   │   ├── symbol-activity-polygon.ts       ← W2 adapter
│   │   ├── symbol-activity-databento.ts     ← W2 adapter (optional)
│   │   ├── membership-walker.ts             ← W3 algorithm
│   │   ├── survivorship-verifier.ts         ← W5
│   │   └── __tests__/                       ← YOU CREATE
│   ├── backfill-pit-universe-sp500.ts       ← W4 main script
│   ├── test-backfill-acceptance.ts          ← W6
│   ├── audit-prophet-layers.ts              ← Phase 4e-1's; don't touch
│   ├── run-portfolio-backtest.ts            ← Phase 4e-1's; don't touch
│   └── ml/                                  ← Phase 5a's; don't touch
├── data/                            ← YOU CREATE
│   ├── sp500-add-drop-events.json   ← committed; ~30 KB
│   ├── sp500-current-members.json   ← committed; ~50 KB
│   ├── backfill-log.jsonl           ← GITIGNORED (run output)
│   └── cache/                       ← GITIGNORED (verifier results)
├── netlify/                         ← DO NOT TOUCH (production code)
├── src/                             ← DO NOT TOUCH (React app)
├── package.json                     ← edit only to add deps (cheerio for parsing)
├── tsconfig.json                    ← do not modify
├── .gitignore                       ← edit: add data/backfill-log.jsonl + data/cache/ + .secrets/
└── ORCHESTRATOR.md                  ← edit at end (W8): mark 0a-2 done
```

## 2.2 Files you ARE allowed to touch

**Creating:**
- `scripts/lib/wikipedia-sp500-events.ts`
- `scripts/lib/wikipedia-sp500-current.ts`
- `scripts/lib/symbol-activity-verifier.ts` (interface)
- `scripts/lib/symbol-activity-polygon.ts`
- `scripts/lib/symbol-activity-databento.ts` (only if Databento key provided)
- `scripts/lib/membership-walker.ts`
- `scripts/lib/survivorship-verifier.ts`
- `scripts/lib/__tests__/*.test.ts`
- `scripts/backfill-pit-universe-sp500.ts`
- `scripts/test-backfill-acceptance.ts`
- `data/sp500-add-drop-events.json` (committed)
- `data/sp500-current-members.json` (committed)
- `reports/phase-0a-2/backfill-report.md`
- `briefs/phase-0a-2-pr-description.md`

**Editing:**
- `package.json` (add `cheerio` or `node-html-parser` for Wikipedia parsing; add `@databento/dbn` if using Databento)
- `package-lock.json` (npm regenerates on install)
- `.gitignore` (add lines for `data/backfill-log.jsonl`, `data/cache/`, `.secrets/`)
- `ORCHESTRATOR.md` (mark 0a-2 row done at end)

## 2.3 Files you may NOT touch (PR will be rejected)

- Anything under `netlify/functions/` — that's production code; the
  backfill writes via firebase-admin from a local script, NOT via a
  new Netlify function
- Anything under `src/` — the React app doesn't change
- Anything under `scripts/ml/` — Phase 5a's Python territory
- `scripts/audit-prophet-layers.ts`, `scripts/run-portfolio-backtest.ts`,
  `scripts/backtest-pre-vs-post-4f.ts` (other phases' scripts)
- Any existing Phase 4f files under `netlify/functions/shared/target-analysts/`
  or `netlify/functions/shared/institutional-flow/` (Phase 4f may be
  running in parallel — see PART 10)
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`
- `src/App.jsx` — no APP_VERSION bump in 0a-2 (data-only, not a code release)
- `netlify/functions/shared/model-version.ts` — no MODEL_VERSION bump

---

# PART 3 — THE BRIEF (verbatim)

The rest of this part is the contents of `briefs/phase-0a-2-brief.md`
verbatim. Treat it as the spec. If anything below conflicts with PART
1/2 or PART 4-10, the brief wins. If anything is ambiguous in the
brief, ask Chad with ONE specific question and two concrete options.

═══════════════════════════════════════════════════════════════════════
BEGIN BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

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

═══════════════════════════════════════════════════════════════════════
END BRIEF CONTENT
═══════════════════════════════════════════════════════════════════════

---

# PART 4 — CODE SHAPE TEMPLATES

Starter shapes anchored to existing conventions in the repo. NOT
complete implementations — fill bodies, add fields the brief requires.

## 4.1 `scripts/lib/wikipedia-sp500-events.ts` skeleton (W1)

```ts
// scripts/lib/wikipedia-sp500-events.ts
// Fetches and parses the "Selected changes" table from
// https://en.wikipedia.org/wiki/List_of_S%26P_500_companies.
// Returns a normalized timeline of add/drop events sorted by date.

import { load } from 'cheerio';

export interface SP500ChangeEvent {
  effectiveDate: string;       // 'YYYY-MM-DD'
  addedTicker: string | null;
  addedSecurity: string | null;
  removedTicker: string | null;
  removedSecurity: string | null;
  reason: string;              // free-text; e.g., 'Acquired by X'
  sourceRow: number;           // table row index for traceability
}

const WIKIPEDIA_URL = 'https://en.wikipedia.org/wiki/List_of_S%26P_500_companies';

export async function fetchSP500ChangeEvents(): Promise<SP500ChangeEvent[]> {
  // 1. Fetch the page HTML
  // 2. Parse with cheerio
  // 3. Find the "Selected changes" table (look for h2 with id including "Selected_changes" then next table)
  // 4. Iterate rows; parse columns into the schema
  // 5. Normalize dates from 'Month D, YYYY' to 'YYYY-MM-DD'
  // 6. Filter to effectiveDate >= '2018-01-01'
  // 7. Sort by effectiveDate ASCENDING
  // 8. Return
  throw new Error('not yet implemented');
}

export function parseEventTableHtml(html: string): SP500ChangeEvent[] {
  // Pure function for testing — takes the raw <table> HTML, returns events.
  // No I/O. This is what your unit tests will call.
  throw new Error('not yet implemented');
}
```

## 4.2 `scripts/lib/membership-walker.ts` skeleton (W3)

```ts
// scripts/lib/membership-walker.ts
// Pure algorithm — given current members + event timeline, produces
// the snapshot at any historical date. No I/O.

import type { SP500ChangeEvent } from './wikipedia-sp500-events';

export interface MembershipSnapshot {
  date: string;          // 'YYYY-MM-DD'
  members: string[];     // sorted ASC for determinism
  membersCount: number;
}

/**
 * Reconstruct membership at a target date by walking backward through
 * the event timeline from "now" (current members) to the target date.
 *
 * For each event encountered while walking backward:
 *   - If event.addedTicker is set: REMOVE it from membership (it
 *     wasn't in the index before this date).
 *   - If event.removedTicker is set: ADD it back to membership (it
 *     WAS in the index until this date).
 *
 * Edge case — multi-event same-day: process all events on the same
 * date together; result is commutative because adds and drops are
 * disjoint.
 */
export function reconstructAtDate(
  currentMembers: ReadonlyArray<string>,
  events: ReadonlyArray<SP500ChangeEvent>,
  targetDate: string,
): MembershipSnapshot {
  // 1. Start with set of currentMembers
  // 2. Filter events to those with effectiveDate > targetDate (sorted DESC)
  // 3. For each event:
  //      - if addedTicker set: members.delete(addedTicker)
  //      - if removedTicker set: members.add(removedTicker)
  // 4. Return snapshot at targetDate
  throw new Error('not yet implemented');
}

/**
 * Produce a snapshot for every business day in [startDate, endDate],
 * inclusive. Walks backward once and emits snapshots in reverse order.
 * For efficiency: O(events + days) instead of O(events * days).
 */
export function reconstructDailyRange(
  currentMembers: ReadonlyArray<string>,
  events: ReadonlyArray<SP500ChangeEvent>,
  startDate: string,
  endDate: string,
): MembershipSnapshot[] {
  // Walk backward from today to startDate.
  // For each business day, emit the membership state.
  // When you cross an event boundary, apply the reverse event.
  throw new Error('not yet implemented');
}
```

## 4.3 `scripts/lib/symbol-activity-verifier.ts` interface (W2)

```ts
// scripts/lib/symbol-activity-verifier.ts
// Single interface; two implementations (polygon + databento).
// Backfill chooses one based on whether Chad provided a Databento key.

export interface SymbolActivityVerifier {
  /** Did this ticker have trading activity on this date? */
  hadActivity(ticker: string, date: string): Promise<boolean>;
  /** When was this ticker delisted? null if still active. */
  delistedAt(ticker: string): Promise<string | null>;
  /** Implementation name for the backfill report. */
  readonly providerName: string;
}

// Pick an implementation based on env at boot time.
export function pickVerifier(): SymbolActivityVerifier {
  if (process.env.DATABENTO_API_KEY) {
    // Lazy import so missing Databento package doesn't error
    const { DatabentoVerifier } = require('./symbol-activity-databento');
    return new DatabentoVerifier(process.env.DATABENTO_API_KEY);
  }
  const { PolygonVerifier } = require('./symbol-activity-polygon');
  return new PolygonVerifier(process.env.POLYGON_API_KEY);
}
```

## 4.4 `scripts/lib/__tests__/membership-walker.test.ts` skeleton

```ts
// Pure algorithm tests. No mocks, no I/O.
import { describe, it, expect } from 'vitest';
import { reconstructAtDate } from '../membership-walker';
import type { SP500ChangeEvent } from '../wikipedia-sp500-events';

const EMPTY_EVENT = (overrides: Partial<SP500ChangeEvent>): SP500ChangeEvent => ({
  effectiveDate: '2022-01-15',
  addedTicker: null,
  addedSecurity: null,
  removedTicker: null,
  removedSecurity: null,
  reason: 'test',
  sourceRow: 0,
  ...overrides,
});

describe('reconstructAtDate — single add event', () => {
  it('excludes added ticker for dates before its effective date', () => {
    const current = ['A', 'B', 'C', 'X'];
    const events = [
      EMPTY_EVENT({ addedTicker: 'X', effectiveDate: '2022-01-15' }),
    ];
    const snap = reconstructAtDate(current, events, '2022-01-14');
    expect(snap.members).toEqual(['A', 'B', 'C']);
  });

  it('includes added ticker on/after its effective date', () => {
    const current = ['A', 'B', 'C', 'X'];
    const events = [
      EMPTY_EVENT({ addedTicker: 'X', effectiveDate: '2022-01-15' }),
    ];
    const snap = reconstructAtDate(current, events, '2022-01-15');
    expect(snap.members).toEqual(['A', 'B', 'C', 'X']);
  });
});

describe('reconstructAtDate — single drop event', () => {
  it('includes dropped ticker for dates before its effective date', () => {
    const current = ['A', 'B', 'C'];
    const events = [
      EMPTY_EVENT({ removedTicker: 'Y', effectiveDate: '2022-03-20' }),
    ];
    const snap = reconstructAtDate(current, events, '2022-03-19');
    expect(snap.members).toEqual(['A', 'B', 'C', 'Y']);
  });
});

describe('reconstructAtDate — multi-event same day', () => {
  it('applies all same-day events together', () => {
    const current = ['A', 'B', 'X', 'Z'];
    const events = [
      EMPTY_EVENT({ addedTicker: 'X', effectiveDate: '2022-05-01' }),
      EMPTY_EVENT({ removedTicker: 'Q', effectiveDate: '2022-05-01' }),
      EMPTY_EVENT({ addedTicker: 'Z', effectiveDate: '2022-05-01' }),
    ];
    const snap = reconstructAtDate(current, events, '2022-04-30');
    // Before 5/1: X and Z weren't yet added; Q was still in.
    expect(snap.members.sort()).toEqual(['A', 'B', 'Q'].sort());
  });
});

// Add cases for: idempotency, no-op when targetDate >= latest event,
// walking back far enough that ALL current members were added later
// (snap.members = ['Q1', 'Q2', ...] = only the ones since removed)
```

## 4.5 `scripts/backfill-pit-universe-sp500.ts` skeleton (W4)

```ts
#!/usr/bin/env tsx
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore, FieldValue } from 'firebase-admin/firestore';
import { fetchSP500ChangeEvents } from './lib/wikipedia-sp500-events';
import { fetchCurrentMembers } from './lib/wikipedia-sp500-current';
import { reconstructDailyRange } from './lib/membership-walker';
import { pickVerifier } from './lib/symbol-activity-verifier';
import { writeFileSync, mkdirSync } from 'fs';
import { resolve } from 'path';

const ARGV = new Set(process.argv.slice(2));
const DRY_RUN = ARGV.has('--dry-run');
const FORCE = ARGV.has('--force');

async function main(): Promise<void> {
  // 0. Init firebase (requires GOOGLE_APPLICATION_CREDENTIALS in env)
  if (!DRY_RUN) {
    initializeApp({
      credential: cert(JSON.parse(
        require('fs').readFileSync(process.env.GOOGLE_APPLICATION_CREDENTIALS!, 'utf-8'),
      )),
    });
  }
  const db = DRY_RUN ? null : getFirestore();

  // 1. Load events + current members (cached on disk after first run)
  console.log('[1/6] Loading events...');
  const events = await fetchSP500ChangeEvents();
  const current = await fetchCurrentMembers();
  console.log(`  ${events.length} events; ${current.length} current members`);

  // 2. Reconstruct daily range
  console.log('[2/6] Reconstructing daily snapshots 2018-01-01 → today...');
  const startDate = '2018-01-01';
  const endDate = new Date().toISOString().slice(0, 10);
  const snapshots = reconstructDailyRange(current, events, startDate, endDate);
  console.log(`  ${snapshots.length} snapshots reconstructed`);

  // 3. Validate membership counts
  console.log('[3/6] Validating membership counts...');
  const counts = snapshots.map((s) => s.membersCount);
  const min = Math.min(...counts);
  const max = Math.max(...counts);
  console.log(`  count range: ${min} → ${max} (expected: 500 ± 10)`);
  if (min < 480 || max > 525) {
    console.error('  WARN: membership count drift suggests event parse error');
  }

  // 4. Survivorship verification (1% sample by default)
  console.log('[4/6] Survivorship verification (1% sample)...');
  const verifier = pickVerifier();
  console.log(`  using provider: ${verifier.providerName}`);
  const failures = await verifySurvivorship(snapshots, verifier, 0.01);
  if (failures.length > 0) {
    console.warn(`  ${failures.length} failures — see report`);
  }

  // 5. Write to Firestore (skip if dry-run)
  if (DRY_RUN) {
    console.log('[5/6] DRY RUN — skipping writes');
  } else {
    console.log('[5/6] Writing to Firestore (batched, 500/batch)...');
    await writeSnapshots(db!, snapshots);
  }

  // 6. Generate report
  console.log('[6/6] Generating report...');
  writeReport(snapshots, failures, verifier.providerName);
  console.log('Done.');
}

// ... implementations of verifySurvivorship, writeSnapshots, writeReport
main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

---

# PART 5 — CONVENTIONS + GOTCHAS

## 5.1 Commit cadence + messages

One commit per workstream. Suggested sequence:

1. `phase-0a-2: W1 Wikipedia event parser + cached events JSON`
2. `phase-0a-2: W2 symbol-activity verifier interface + Polygon adapter`
3. `phase-0a-2: W2 Databento adapter (optional)`
4. `phase-0a-2: W3 backward-walk membership reconstruction + tests`
5. `phase-0a-2: W4 backfill script main loop`
6. `phase-0a-2: W5 survivorship verifier + sampling`
7. `phase-0a-2: W6 acceptance test`
8. `phase-0a-2: W7 backfill report after dry-run`
9. `phase-0a-2: backfill executed; report committed`
10. `phase-0a-2: W8 ORCHESTRATOR + PR description`

## 5.2 Branch + push hygiene

Branch name: `phase-0a-2-sp500-pit-backfill`. Single branch.
Push ONCE when ready for PR.

## 5.3 No version bump

This is a data-only operation. Do NOT bump APP_VERSION or
MODEL_VERSION. Snapshots are tagged with `source:
'phase-0a-2-backfill'` for provenance — that's the only versioning
this PR adds.

## 5.4 Test conventions

- Runner: `vitest`. Tests live under `scripts/lib/__tests__/`.
- `.test.ts` extension.
- `npm test` runs everything.
- Mocks for verifier: build a `MockSymbolActivityVerifier` class
  implementing the interface that returns canned answers. Use this in
  the walker tests so they're hermetic.
- Don't network in tests. Don't hit Wikipedia / Polygon / Databento.
- New tests should grow count from baseline (~522) by 15-25.

## 5.5 TypeScript

- `strict: true` is on. No `any` without an inline comment.
- `npx tsc --noEmit` must pass before each commit.
- Exported functions: explicit types. Internal helpers: inferred OK.
- The backfill script (`scripts/backfill-pit-universe-sp500.ts`) is
  invoked via `npx tsx` — no compilation needed at run time. It still
  participates in `tsc --noEmit` for type checking.

## 5.6 Wikipedia fetching gotchas

- Wikipedia's page structure changes occasionally. Pin your parser to
  the table title "Selected changes to the list of S&P 500 components"
  (header text). Don't depend on table-index positions in the page.
- If the page returns 429 or 503, back off and retry once. Don't hit it
  more than 2-3 times during development; cache the HTML to a local
  file once and parse from disk during iteration.
- The `User-Agent` header matters: Wikipedia requests bots identify
  themselves. Use something like
  `User-Agent: tradeiq-backfill-script/1.0 (chad@davisdelivery.com)`.

## 5.7 Firestore write gotchas

- Use batched writes (`db.batch()`), max 500 operations per batch.
- Tag every backfilled doc with `source: 'phase-0a-2-backfill'`. This
  lets the next scheduled `scan-universe-history-sp500.ts` invocation
  detect existing backfill docs and skip them rather than overwriting.
- SAFEGUARD before write: if a doc already exists at the target path
  AND its `source` is NOT `phase-0a-2-backfill` (i.e., it's a live
  snapshot from the scheduled scan), SKIP that write. Do not clobber
  live data.
- The collection name is `universeHistory`, the parent doc is the
  universe name (e.g. `sp500`), and the daily snapshots are a
  subcollection under that. Path:
  `universeHistory/sp500/snapshots/{YYYY-MM-DD}`. **Verify this exact
  path** by reading `netlify/functions/shared/snapshot-store.ts` or
  whichever file the live scheduled scan uses. Match the pattern
  exactly — getting the path wrong means the backtest engine won't
  find your backfilled data.

## 5.8 Idempotency

Running the backfill twice should produce identical results. The
script SHOULD detect existing backfill docs and either skip
(`--force` not set, default) or overwrite (`--force` set).

---

# PART 6 — OPENING THE PR

## 6.1 Push the branch

```bash
git push -u origin phase-0a-2-sp500-pit-backfill
```

## 6.2 Open the PR via GitHub API

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 0a-2 — sp500 PIT universe-history backfill",
    "head": "phase-0a-2-sp500-pit-backfill",
    "base": "main",
    "body": "See briefs/phase-0a-2-pr-description.md for the full description.\n\n**Acceptance test:** sp500/monthly/top50 backtest for 2018-2024 returns `tradeCount > 0` and `mlTrainingCount >= 3000` (vs `0` before backfill).\n\nVerifier: <Polygon | Databento>. Snapshots written: <N>. Membership count range: <min-max>. Verification failures: <count>."
  }'
```

The PR description body points at `briefs/phase-0a-2-pr-description.md` for full detail.

---

# PART 7 — ACCEPTANCE TEST (W6)

After the backfill writes complete, fire the original failing Phase 5a
baseline config:

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

Capture the `runId` from the response. Wait 15-45 min for completion
(longer than dow runs because sp500 has ~15x more tickers per
rebalance). Then check:

```bash
curl -sS "https://tradeiq-alpha.netlify.app/api/backtest-runs?runId=<RUNID>" \
  | python3 -m json.tool
```

**Acceptance:** `metrics.tradeCount > 0` AND `mlTrainingCount >= 3000`.

If those criteria are met, the backfill worked. If `tradeCount = 0`
or `mlTrainingCount = 0`, the backfill writes either didn't land or
landed at the wrong Firestore path. Debug before declaring done.

---

# PART 8 — HAND-OFF MESSAGE FORMAT

When the PR is mergeable, post a SINGLE message in this conversation
with EXACTLY this shape:

```
PR #<N> open: https://github.com/DavisDelivery/TradeIQ/pull/<N>

Acceptance test: PASS | FAIL
  - Test runId: bt_...
  - Trades:     <N>
  - mlTraining: <N>

Backfill stats:
  - Snapshots written: <N> across <date-range>
  - Membership count range: <min> - <max> (expected 500 ± 10)
  - Events applied: <N> from Wikipedia timeline
  - Verifier: <Polygon | Databento>
  - Verification: <N> pairs sampled, <M> failed
  - Backfill log: data/backfill-log.jsonl (gitignored; available in
    your sandbox for inspection if needed)

Tests added: <N> (target was 15-25)
Verification:
- tsc --noEmit: clean
- npm test: <N> passing
- npm run build: clean

Known limitations:
- <ticker symbol changes not in event timeline that you caught and
  handled manually>
- <any class-share ambiguities>
- <other edge cases worth flagging>
```

That's the message. No recap of the brief, no proposing next phases.

---

# PART 9 — FAILURE MODES TO AVOID

- **Skipping survivorship verification because it's slow.** A backfill
  that's silently wrong is worse than no backfill. If you must reduce
  the sample size to make the verifier finish in reasonable wall-clock,
  document it explicitly in the report — "1% sampling cut to 0.1% due
  to Polygon free-tier rate limit; 900 pairs checked of ~900k possible".
  That's honest. Cutting verification entirely without disclosure is
  not.

- **Writing snapshots at the wrong Firestore path.** The live scan
  writes to a specific path under `universeHistory`. **Read the live
  scan's source code (`netlify/functions/scan-universe-history-sp500.ts`
  or similar)** before writing anything. Match the exact collection /
  subcollection / doc-id pattern. A backfill at the wrong path means
  every backtest still finds no universe pool and produces 0 trades.

- **Clobbering live snapshots.** Docs at dates ≥ 2026-05-07 are owned
  by the scheduled scan. The safeguard in W4 is non-negotiable: do
  not overwrite docs that don't have `source: 'phase-0a-2-backfill'`.

- **Forgetting ticker symbol changes.** Companies sometimes change
  tickers without an index event (FB → META, etc.). The Wikipedia
  event table won't catch these. Hand-curate a small
  `ticker_symbol_changes.json` lookup at the start of W3 from the
  known cases in this date range (~10-20 total); apply the renames
  when reconstructing membership.

- **Class-share confusion.** GOOG vs GOOGL, BRK.A vs BRK.B, etc. The
  Wikipedia table sometimes lists both, sometimes one. Defer to
  whichever class is currently listed as the sp500 member; for
  historical, use whichever was listed at the time. Document the
  ambiguities in the report.

- **Tests that network.** All tests must be hermetic. Mock the
  verifier. Use HTML fixture strings for the Wikipedia parser tests.
  Do not hit Wikipedia / Polygon / Databento from a test.

- **Committing secrets.** `.secrets/firebase-sa.json` MUST be
  gitignored before you save the SA JSON there. Confirm `.gitignore`
  excludes `.secrets/` BEFORE writing the file. Same for any
  Databento credential storage.

- **Touching the live scheduled scan.** If you find a bug in
  `scan-universe-history-sp500.ts` while reading it for path
  reference, surface to Chad. Do not fix in your PR.

---

# PART 10 — PARALLEL CONTEXT

Phase 4f may be running in a separate executor session in parallel
with you. Their work is TypeScript: `netlify/functions/shared/
target-analysts/*.ts`, `netlify/functions/shared/prophet-layers.ts`,
`netlify/functions/shared/institutional-flow/*` (new),
`netlify/functions/shared/scan-target.ts`,
`src/components/AnalystContributions.jsx`. You do NOT touch their
files; they do NOT touch yours. There is ZERO overlap — your work is
under `scripts/lib/`, `scripts/`, `data/`, and `reports/phase-0a-2/`.

If you do `git pull` mid-way through your work to grab the latest main
(Chad may merge 4f while you're still working), you may see new files
appear that you weren't expecting — that's 4f's PR landing. Ignore
them; they don't affect your work.

Phase 4e-1-finish is also "in flight" — a server-side backtest is
running for the portfolio engine verdict. Status of that run is
unrelated to your work; don't poll for it.

---

End of kickoff. Read `briefs/phase-0a-2-brief.md` (also embedded in
PART 3 above), then start with W0.
