# Phase 4h — verification report

**Branch:** `claude/tradeiq-phase-4h-g3x1t`
**APP_VERSION:** `0.18.5-alpha`
**MODEL_VERSION:** unchanged
**Live acceptance:** deferred to orchestrator post-merge (executor sandbox
has no outbound network to the production deploy).

---

## Static verification (executor-local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean (vite 5.4.21, 2724 modules transformed, ~6s) |
| `npm test` baseline | 694 passing |
| `npm test` after 4h | **746 passing** (73 → 79 test files, +52 tests) |

### New / changed test files

| File | Tests | Covers |
|---|---|---|
| `shared/scan-resume/__tests__/cursor.test.ts` | 14 | cursor read/write/clear, partial-batch subcollection round-trip, ordered readback, delete cleanup |
| `shared/__tests__/ticker-reference.test.ts` | 11 | cache hit, Polygon miss → write-through, bulk enrichment dedup, local fallback on Polygon failure |
| `shared/__tests__/snapshot-store-4h.test.ts` | 7 | 26h freshness budget, retention pruning chunked at ≤100 per batch, universe-scoped |
| `__tests__/target-board-snapshot-only.test.ts` | 9 | russell2k/sp500 never inline-scan, stale-flag serving, forced-rescan redirect, small universes still fall back |
| `__tests__/scan-target-board-russell2k-background.checkpoint.test.ts` | 7 | fresh start writes cursor + partial doc, resume reads same cursor, terminal-only `writeSnapshot`, retention runs after publish, partial scan never advances `_latest`, `invocationCount` proves chaining |
| `__tests__/analyst-runner-enrichment.test.ts` | 4 | every Target carries `companyName` + `sector`; falls back to in-repo universe when Polygon-cached name absent |

---

## Workstream summary

### W3 — companyName + sector enrichment

- **New:** `netlify/functions/shared/ticker-reference.ts` — Firestore-backed
  cache at `tickerReference/{ticker}`. Single-ticker + bulk APIs; falls
  back to the in-repo universe table on Polygon failure so the column
  is never blank.
- **Modified:** `shared/types.ts` adds `companyName` + `sector` to
  `Target`, `stale?: boolean` to `TargetBoardResponse`.
- **Modified:** `shared/analyst-runner.ts` threads
  `opts.companyName` onto the Target + persists `sector` from
  `findEntry(ticker)?.sector` (same value the sector-rotation analyst
  uses for its sector-ETF lookup — taxonomy stays in lock-step).
- **Modified:** `shared/scan-target.ts` calls `enrichTickerNames(survivors)`
  before pass-2 and passes the resolved name into every per-ticker
  scoring call.

**Cost:** first-warm scan of a 2000-ticker universe issues ~2,000 Polygon
calls (concurrency 6). Subsequent scans = 0 Polygon calls until the
universe gets new tickers. Polygon `/v3/reference/tickers/{ticker}` is
not rate-limit-sensitive at this volume; ticker reference data is
effectively immutable.

### W2 — read-endpoint de-hang

- **Modified:** `shared/snapshot-store.ts` widens
  `FRESHNESS_BUDGETS_MS['target-board']` from 30 min → 26 h. Nightly
  cadence (7pm ET) means the snapshot reads "fresh" all day until the
  next scan instead of going stale and triggering the inline live-scan
  fallback.
- **Modified:** `target-board.ts` introduces
  `SNAPSHOT_ONLY_UNIVERSES = { russell2k, russell, sp500 }`. For these,
  stale snapshot → return last complete snapshot flagged `stale: true,
  source: 'snapshot-stale'`. Missing snapshot → empty result with
  `source: 'snapshot-missing'`. `runLiveAndRespond` is NEVER called for
  these universes — the 25-second hang the brief identified as Defect
  2 cannot recur. `dow` / `ndx` / `core` / `all` retain the live
  fallback path unchanged (they finish in ~2-5s, well under the 26s
  sync ceiling).
- **Modified:** `FreshnessPill.jsx` adds rendering for the new
  `snapshot-stale` (amber, "As of {age}") and `snapshot-missing`
  (neutral, "No scan yet") source codes so the UI surfaces the new
  states honestly.

### W1 — scan checkpoint-and-resume

- **New:** `shared/scan-resume/cursor.ts` — scan-specific cursor +
  partial-batch subcollection helpers. Mirrors `backtest-resume/cursor.ts`
  but with `nextTickerIndex`/`totalTickers`/`scoredCount` instead of
  the rebalance shape. Watchdog (`backtest-resume/watchdog.ts`) and
  self-reinvoke (`backtest-resume/reinvoke.ts`) are imported as-is —
  they're universe-agnostic; no duplication.
- **New:** `runTargetScanBatch()` in `shared/scan-target.ts` — single-
  batch helper consumed by the bg-workers. Fetches bars for the slice
  + benchmark/sector ETFs, runs the full analyst battery, returns
  scored Target rows + how many tickers it consumed.
- **New:** `scan-target-board-russell2k-background.ts` + same for
  sp500 — bg-workers. Each invocation: read cursor → loop
  `runTargetScanBatch` (50 tickers/batch) while watchdog not expired
  → append each batch to `scanRuns/{runId}/partial/{batch-NNNNNN}`
  → on terminal batch, read all partials, sort, `writeSnapshot`
  ONCE, advance `_latest`, prune `runs/` to 30 most recent, delete
  partial subcollection. Non-terminal → `Context.waitUntil(fetch(...))`
  self-reinvoke.
- **Modified:** `scan-target-board-russell2k.ts` + `scan-target-board-
  sp500.ts` rewritten as thin scheduled triggers — cron `0 23 * * *`
  (7 pm EDT / 6 pm EST), POSTs to the bg-worker with an empty body
  (worker generates its own runId).
- **Deleted:** `scan-target-board-russell2k-nightly.ts` (the 01:00 UTC
  stopgap; superseded).
- **Modified:** `shared/snapshot-store.ts` adds `pruneOldSnapshots`
  (universe-scoped, keep N most recent; chunked deletes ≤100/batch).

**Atomic-swap invariant tested:** the checkpoint chain test confirms
`writeSnapshot` is called EXACTLY ONCE per scan (on the terminal
invocation); the `_latest` pointer advances inside `writeSnapshot`'s
transaction; a partial-scan invocation that hits the watchdog ceiling
never touches `writeSnapshot` or `pruneOldSnapshots` — the previous
complete snapshot remains served until the new one is fully assembled.

**Failed-mid-chain behavior:** if any batch throws, the cursor is
stamped with `lastError`, the run remains in `status: 'running'`, and
the next scheduled cron will start a fresh runId. The `_latest`
pointer was never advanced, so the read endpoint keeps serving the
previous complete snapshot (stale-flagged once past the 26h budget).

### W4 — UI surfacing

- **Modified:** `src/TargetBoardView.jsx` — `TargetCard` renders
  `companyName` (truncate, title attr for hover) + `sector`
  (uppercase mono) under the ticker. `TargetDetail` modal header
  renders both inline alongside the ticker. Existing TradeIQ visual
  system preserved (brand neutral palette, mono accents).
- **Modified:** `src/components/FreshnessPill.jsx` — amber "As of
  {age}" pill for `source: 'snapshot-stale'`; neutral "No scan yet"
  pill for `source: 'snapshot-missing'`.
- **Modified:** `src/App.jsx` — `APP_VERSION` bumped to `0.18.5-alpha`.

---

## Compute footprint — modeled

| State | Russell2k scan compute | Complete scans/month |
|---|---|---|
| Pre-4h (every-30-min cron, never completes) | ~105 fn-hr/month → ~1,050 credits | 0 |
| Post-4h (nightly only, completes via chain) | ~25 fn-hr/month → ~250 credits | ~30 |
| **Savings** | **~80 fn-hr/month, ~800 credits/month** | **0 → 30 complete scans/month** |

Read-path inline-scan compute (every Russell page-view ≈ 25s function
time) collapses to O(1) doc-read time — eliminated, not bounded.

Expected scan wall-clock per the brief's model (PART III):
- 2,000 tickers × ~1.5 s avg × concurrency 6 → ~8-12 min ideally
- BATCH_SIZE = 50 tickers/batch, BUDGET_MS = 13 min/invocation
- Most invocations expected to complete in 1-2 chained passes; the
  cursor's `invocationCount > 1` field is the orchestrator's
  acceptance probe for "the resume actually worked."

---

## Acceptance (deferred — orchestrator post-merge)

1. Fire a manual russell2k scan via
   `POST /.netlify/functions/scan-target-board-russell2k-background`
   (empty body) — confirm `scanRuns/{runId}` reaches `status: done`
   with `invocationCount > 1` and a snapshot with ~2,000 results.
2. Probe `GET /api/target-board?universe=russell2k` at arbitrary
   times — expect sub-2-second latency consistently (was ~25s).
3. Inspect any pick — expect non-empty `companyName` and `sector`.
4. UI: open the russell2k board, confirm company name + sector
   render on cards and detail modal.
5. Confirm via Netlify dashboard that the old `0,30 13-21 * * 1-5`
   cron + the 01:00 UTC nightly are gone; only `0 23 * * *` registers
   for russell2k + sp500.

Document the measured `scanDurationMs` + `invocationCount` in this
file post-merge.

---

## Known limitations

- **First scan cold-warms the ticker-reference cache** — issues
  ~2,000 Polygon `/v3/reference/tickers` calls. Polygon's free tier
  allows 5 req/s; at concurrency 6 we run slightly above that for
  ~5-7 minutes during the first nightly invocation. Polygon's
  reference endpoint is not aggressively rate-limited in practice;
  if it becomes an issue, lower `POLYGON_CONCURRENCY` in
  `ticker-reference.ts` (currently 6).
- **Retention cleanup is best-effort** — `pruneOldSnapshots`
  failure is logged but does not fail the scan. Re-runs on the next
  successful scan.
- **Sector taxonomy uses the in-repo universe table** — same value
  the sector-rotation analyst already uses for sector-ETF lookup
  (per Chad's settled decision § 3 of the brief). No GICS
  normalization; tickers absent from `universe.ts` get `sector: null`
  and the UI omits the chip. This is intentional.
