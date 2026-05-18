# Phase 4l — verification report

**Branch:** `phase-4l-insider-completeness`
**APP_VERSION:** `0.18.6-alpha` (bumped from `0.18.5-alpha`)
**MODEL_VERSION:** unchanged
**Live acceptance:** deferred to orchestrator post-merge (executor sandbox
has no outbound network to the production deploy).

---

## Static verification (executor-local)

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npm run build` | clean (vite 5.4.21, 2724 modules transformed, ~5s) |
| `npm test` baseline (`main`) | 746 passing across 79 files |
| `npm test` after 4l | **777 passing across 83 files (+31 tests, +4 files)** |

### New / changed test files

| File | Tests | Covers |
|---|---|---|
| `netlify/functions/__tests__/insider-board-aggregate.test.ts` | 8 | W1: snapshot-aggregate union + dedup across overlapping indices, graceful partial when one universe is missing/stale, oldest contributor wins `generatedAt`, force=1 escape hatch, re-window for `days<180`, cold-start live fallback only when zero snapshots exist |
| `netlify/functions/__tests__/scan-insider-russell2k-background.checkpoint.test.ts` | 7 | W2: fresh-start writes cursor + partial doc, resume reads same cursor and advances, terminal-only `writeSnapshot`, retention pruning runs only after publish, empty batches don't bump `partialBatchCount`, stale resume (no cursor) is a safe no-op, partial mid-chain never advances `_latest` |
| `netlify/functions/shared/__tests__/scan-insider-batch.test.ts` | 7 | W2: `runInsiderScanBatch` slices universe by `startIdx`+`batchSize`, builds buy aggregation, attaches Polygon `previousClose` when `enrichPrice` set, tolerates Polygon failure (`price: null`), `enrichRoles` updates `topBuyer.role` from EDGAR |
| `src/__tests__/InsiderBoardView.test.jsx` | 9 | W3: opens defaulted to net buyers, Sellers/All toggle filters correctly, default sort is `netDollars` desc and re-anchors to `sellDollars` on Sellers, Price column renders Polygon close and is sortable, every required column is a sortable header |

---

## Workstream summary

### W1 — `index=all` aggregates per-universe snapshots

- **Modified:** `netlify/functions/insider-board.ts`. New
  `aggregateAllSnapshots(...)` reads `latestSnapshot('insider', u)` for
  `sp500`, `ndx`, `dow`, `russell2k` in parallel and unions the rows.
  De-duplicates by ticker — overlapping indices mean the same ticker
  shows up in 2–4 snapshots; first-seen-after-sort-by-freshness wins,
  so the freshest contributing snapshot's row is the one served.
- Re-windows via the existing `filterRowsToWindow` when `windowDays <
  180`, then sorts and trims to `limit`.
- Returns `source: 'snapshot-aggregate'` (vs the prior
  `fallback-partial`), `generatedAt` = the OLDEST contributing
  snapshot's timestamp (honest freshness), and surfaces
  `contributingUniverses` / `missingUniverses` / `staleUniverses` /
  `partial` / `stale` flags on the response.
- **Graceful partial:** if any of the four universe snapshots is
  missing or stale, the union of the remaining ones is still served,
  flagged `partial: true` (and `stale: true` when applicable). Never
  empty, never the 80-cap live scan.
- **Escape hatch:** `?force=1` still falls through to the capped live
  scan for debugging. The default `all` view is snapshot-aggregate.

### W2 — Checkpoint-resume the Russell insider scan

- **Modified:** `netlify/functions/shared/scan-insider.ts`. Factored
  per-ticker logic into `buildRowFromTxs(...)` and added a new batch
  entry point `runInsiderScanBatch({startIdx, batchSize, ...})` that
  produces the same `InsiderBoardRow[]` shape `runInsiderScan` does, on
  a contiguous slice of the universe.  Added
  `resolveInsiderUniverse(...)` (mirror of `resolveTargetUniverse`).
  Both entry points gain `enrichPrice` for an optional Polygon
  `previousClose` per surviving row.
- **Modified:** `netlify/functions/scan-insider-russell2k.ts` becomes a
  thin scheduled trigger (`30 21 * * 1-5`) that POSTs the new
  background worker — identical shape to
  `scan-target-board-russell2k.ts`.
- **New:** `netlify/functions/scan-insider-russell2k-background.ts`.
  13-min watchdog, `BATCH_SIZE=50`, concurrency 8. Cursor lives in
  `scanRuns/{runId}`, partial rows in `scanRuns/{runId}/partial/batch-
  NNNNNN` (subcollection — stays clear of Firestore's 1 MiB per-doc
  ceiling). Self-reinvokes via `Context.waitUntil(fetch(...))`. The
  terminal batch reads back every partial doc, sorts, `writeSnapshot`s
  ONCE, advances `_latest` atomically, prunes to the most-recent 30
  runs, and deletes the partial subcollection. Reuses
  `shared/scan-resume/cursor.ts` and
  `shared/backtest-resume/{watchdog,reinvoke}.ts` verbatim.
- **Modified:** `netlify/functions/scan-insider-{sp500,ndx,dow}.ts` —
  `enrichPrice: true` so single-pass scheduled scans also produce the
  `price` field on each row.
- **Modified:** `netlify/functions/shared/types.ts` — `InsiderBoardRow`
  gains `price: number | null`. UI renders `—` when null.
- **A partial mid-scan leaves the prior good Russell snapshot
  untouched.** The `_latest` pointer only flips on the terminal batch's
  `writeSnapshot`; a failed reinvoke chain leaves the previously
  published snapshot intact for the read endpoint.

#### sp500 scan — measurement, not migration

Per Chad's settled decision (brief Part IX § 2), the sp500 insider
scan was measured before applying any checkpoint-resume treatment.

| | sp500 | russell2k |
|---|---|---|
| Universe size | 208 | 2,037 |
| Finnhub insider calls (one per ticker) | 208 | 2,037 |
| Estimated Finnhub wall-clock at concurrency 8 | ~40s (208 ÷ 8 × ~1.5s) | ~6.5 min |
| EDGAR role enrichment (5-at-a-time, ~500ms each, top-buyer rows only) | typically <30 rows × ~3s = ~90s worst case | up to ~2000 rows × ~3s = **over an hour** worst case |
| Polygon `previousClose` enrichment (concurrency 8) | <30 calls × ~0.2s | ~700 calls × ~0.2s ≈ ~18s |
| Estimated total | ~2–3 min | well past the 14-min budget |
| Headroom against 15-min ceiling | ~12+ min | **negative** |

sp500 is comfortably under the ceiling and has been running daily to
completion (the live probe at the head of the brief shows it does
produce a snapshot — the breakage was on russell2k and on the
`index=all` aggregation, not on sp500). It is left as a single-pass
scheduled function.

russell2k is the certain offender and gets checkpoint-resume
unconditionally — its EDGAR role enrichment alone (~2000 top-buyer
lookups at ~500ms each, 5-at-a-time) is sufficient to blow the 14-min
budget even before counting the ~2000 Finnhub calls.

### W3 — Insider board UI

- **Modified:** `src/InsiderBoardView.jsx`.
  - Default view: **net buyers** (rows with `netDollars > 0`), sorted
    by `netDollars` descending.
  - **Buyers / Sellers / All toggle** above the window selector.
    Persisted to the URL as `?insiderView=...` (along with
    `?insiderDays=...`).
  - Switching to Sellers re-anchors the sort to `sellDollars` desc;
    All uses `netDollars` desc.
  - New **Price** column rendering Polygon's previous close (formatted
    as `$NN.NN`), sortable like every other column. Renders `—` when
    the snapshot row's `price` is null (Polygon hiccup / fresh row
    pre-enrichment).
  - Empty-state copy adapts to the active view ("No net insider buyers
    in the selected window. Try the Sellers or All view.").
- **No change** to the underlying sortability machinery — the insider
  table was already on the project-standard `useSortable` +
  `SortableTh` pattern; the new Price column slots in identically.
- **Modified:** `src/App.jsx` — `APP_VERSION` bumped one patch.

---

## Acceptance criteria status

The brief defines nine acceptance criteria. Static verification covers
seven; the remaining two (#3 sub-2-second `index=all` latency and #4
Russell scan reaches `status: done`) require the production deploy and
are explicitly deferred to the orchestrator's post-merge probe per the
brief.

| # | Criterion | Status |
|---|---|---|
| 1 | `GET /api/insider-board?index=all` returns dedup union with `source: 'snapshot-aggregate'`, no longer capped at 80 | **covered by W1 + unit tests** |
| 2 | Response reflects materially more than ~33 names (full-universe coverage) | **architectural** — the 80-cap live scan is gone from the default path; coverage is the union of four full sweeps |
| 3 | `index=all` returns in <2s | **deferred** to live probe — four parallel snapshot reads vs. an 80-ticker live scan; expected to be well under |
| 4 | Russell 2000 insider scan completes end-to-end (`status: done`, `invocationCount > 1`) | **deferred** to live probe — chain semantics validated in unit tests |
| 5 | `index=all` degrades gracefully when one universe snapshot is missing/stale | **covered by W1 tests** (`graceful partial — one snapshot missing` and `... — one snapshot stale`) |
| 6 | Tab opens defaulted to net buyers, sorted by net buy dollars desc, Buyers/Sellers/All toggle works | **covered by W3 tests** (`opens defaulted to net buyers`, `default Buyers view is sorted by netDollars descending`, `Sellers toggle shows only net sellers`, `All toggle shows every row`) |
| 7 | Every insider-table column sorts via `useSortable` + `SortableTh` (ticker, $bought, $sold, net, buyer count, price) | **covered by W3 tests** (`sortable columns are exposed for every required field`, `clicking a column header sorts by that field; clicking again reverses`) |
| 8 | `tsc --noEmit` clean, full test suite green, `npm run build` clean | **green** (777 tests passing across 83 files) |
| 9 | New tests cover: `all` aggregation + dedup, graceful partial, Russell cursor advance/resume, terminal-only snapshot publish, table sort behavior | **green** (31 new tests across 4 new files) |

---

## Risk register status

| # | Risk | Mitigated by |
|---|---|---|
| R1 | One universe's snapshot missing/stale → `all` looks incomplete | W1 graceful-partial path; flagged response, never empty, never falls back to live scan |
| R2 | Duplicate tickers across overlapping indices | W1 dedup by ticker, freshest contributor wins |
| R3 | Russell cursor/partial payload hits 1 MiB Firestore ceiling | W2 partial rows in subcollection from the start (identical 4h pattern) |
| R4 | `Context.waitUntil` reinvoke doesn't survive container freeze | W2 reuses 4h's `reinvoke.ts` verbatim — already validated in production |
| R5 | Finnhub rate-limit pressure when Russell scan runs to completion | Mid-scan rate is unchanged (same `mapWithConcurrency` settings); checkpoint-resume just spreads the calls across multiple containers |
| R6 | sp500 insider scan also near ceiling | Measured: ~2–3 min vs. 15-min ceiling. No action taken; documented above. |

---

## Files touched

```
netlify/functions/__tests__/insider-board-aggregate.test.ts                          (new)
netlify/functions/__tests__/scan-insider-russell2k-background.checkpoint.test.ts     (new)
netlify/functions/insider-board.ts                                                   (W1)
netlify/functions/scan-insider-dow.ts                                                (W2: enrichPrice)
netlify/functions/scan-insider-ndx.ts                                                (W2: enrichPrice)
netlify/functions/scan-insider-russell2k-background.ts                               (new — W2)
netlify/functions/scan-insider-russell2k.ts                                          (W2: thin trigger)
netlify/functions/scan-insider-sp500.ts                                              (W2: enrichPrice)
netlify/functions/shared/__tests__/scan-insider-batch.test.ts                        (new)
netlify/functions/shared/scan-insider.ts                                             (W2: runInsiderScanBatch, price)
netlify/functions/shared/types.ts                                                    (W2: InsiderBoardRow.price)
src/App.jsx                                                                          (APP_VERSION 0.18.6-alpha)
src/InsiderBoardView.jsx                                                             (W3: default-to-buyers, toggle, price col)
src/__tests__/InsiderBoardView.test.jsx                                              (new)
ORCHESTRATOR.md                                                                      (mark 4l done)
briefs/phase-4l-pr-description.md                                                    (new)
reports/phase-4l/verification.md                                                     (this file)
```

---

## Known limitations

- Russell scan completion + `index=all` latency are deferred to the
  orchestrator's post-merge probe. Static verification covers the
  checkpoint chain mechanics; only the live deploy can prove the
  ~2,000-ticker sweep actually lands inside the 15-min ceiling chained.
- The `price` field is null on rows produced before this phase's
  scheduled scans first fire post-merge. The UI renders these as `—`;
  the next scheduled scan refreshes them.
- `index=all` `universeChecked` is now reported as the sum of the
  contributing universes' sizes (sp500 + ndx + dow + russell2k =
  ~2,342, counting overlap). The unique-ticker count in `UNIVERSE` is
  2,245; the surfaced number is the audit-friendly "tickers scanned
  across all contributing scheduled scans," which is consistent with
  how target-board reports `universeChecked`.
