# Phase 4l — Insider board completeness

**APP_VERSION:** `0.18.5-alpha → 0.18.6-alpha`
**MODEL_VERSION:** unchanged (4l moves and surfaces data; no scoring math change)
**Companion docs:** `briefs/phase-4l-brief.md`, `kickoffs/phase-4l-executor.md`, `reports/phase-4l/verification.md`

---

## What this PR does

Closes the two defects keeping the insiders board from reflecting the
universe it claims to cover (~2,245 names, the live probe at brief
time showed ~33 tickers):

1. **`index=all` skipped the snapshot store entirely** and ran a
   capped live scan of 80 tickers. Reworked into a snapshot-aggregate
   path that unions the four per-universe insider snapshots
   (sp500 ∪ ndx ∪ dow ∪ russell2k), de-duplicates by ticker
   (overlapping indices), re-windows, sorts, and trims.
2. **The Russell 2000 insider scan couldn't finish** — ~2,000 Finnhub
   insider-transaction calls + EDGAR role enrichment per top buyer
   blew the 15-min Netlify background ceiling. Applied Phase 4h's
   checkpoint-resume pattern: thin scheduled trigger + background
   worker that batches the universe, checkpoints a Firestore cursor,
   and self-reinvokes via `Context.waitUntil` until the sweep
   completes.

Plus the UI work Chad settled on the same day:

3. **The insider tab opens defaulted to net buyers** with a Buyers /
   Sellers / All toggle, fully sortable columns including a new Price
   column (Polygon previous close).

## Architecture

### W1 — snapshot-aggregate for `index=all`

```
GET /api/insider-board?index=all
  └─ Promise.all(latestSnapshot('insider', {sp500,ndx,dow,russell2k}))
  └─ partition into contributing / missing / stale
  └─ if no contributing → fall back to capped live scan (cold start only)
  └─ else:
       sort contributors by generatedAt desc (freshest first)
       union rows; dedup by ticker (first-seen wins → freshest)
       filterRowsToWindow if windowDays < 180
       sort, trim to limit
       respond:
         source: 'snapshot-aggregate'
         generatedAt: oldest contributor (honest freshness)
         stale: any contributor past freshness budget
         partial: any contributor missing or stale
         contributingUniverses / missingUniverses / staleUniverses
```

The `?force=1` debug escape hatch still runs the capped live scan.

### W2 — Russell insider checkpoint-resume

```
scan-insider-russell2k.ts                  (trigger; cron 30 21 * * 1-5)
  └─ POST /.netlify/functions/scan-insider-russell2k-background
       └─ readScanCursor → resume or fresh start
       └─ loop runInsiderScanBatch (50/batch, concurrency 8) until
       │   watchdog (13 min) trips
       │   └─ each batch: getFinnhubInsiderTransactions per ticker;
       │      enrichPrice (Polygon prev close) + enrichRoles (EDGAR) on
       │      the survivors
       │   └─ appendPartialBatch → scanRuns/{runId}/partial/{batch-NNNNNN}
       │   └─ writeScanCursor (advance nextTickerIndex)
       └─ if more: dispatchReinvoke via Context.waitUntil
       └─ if done: readAllPartialBatches → sort by buyDollars desc
                    → writeSnapshot (ONCE) → clearScanCursor
                    → deletePartialBatches → pruneOldSnapshots (keep 30)
```

Reuses `shared/scan-resume/cursor.ts` and
`shared/backtest-resume/{watchdog,reinvoke}.ts` verbatim — same
mechanics 4h validated in production for the target-board worker.

### sp500 measured, not migrated

Per Chad's settled decision, the sp500 insider scan was measured
before applying any checkpoint-resume:

- sp500 universe: 208 tickers
- Estimated Finnhub wall-clock at concurrency 8: ~40s
- EDGAR role enrichment worst case: ~90s
- Polygon price enrichment: <30 calls × ~0.2s
- **Total estimated runtime: ~2–3 min, vs. 15-min ceiling**

Left as a single-pass scheduled function. russell2k (2,037 tickers)
gets checkpoint-resume unconditionally. Measurement detail in
`reports/phase-4l/verification.md`.

### W3 — insider UI

- Default view: **net buyers** (`netDollars > 0`), sorted by
  `netDollars` desc.
- View toggle persisted to the URL as `?insiderView=buyers|sellers|all`.
- Sellers view re-anchors sort to `sellDollars` desc; All uses
  `netDollars` desc.
- New **Price** column (Polygon previous close) — sortable. Renders
  `—` when null (cold row or Polygon hiccup).
- Empty-state copy adapts to the active view.
- All sortability via the project-standard `useSortable` +
  `SortableTh` pattern (the insider table was already on it).

## Costs

No new LLM tokens (insider scan is Finnhub + arithmetic; no AI
inference). Finnhub call volume unchanged — same 2,245 calls daily,
they just *finish* now. Netlify compute on russell2k goes from one
killed 15-min run to ~3 chained ~13-min invocations — comparable to
the 4h target-board scan and arguably a small saving (no more wasted
killed runs).

`index=all` reads four parallel snapshot docs instead of running an
80-ticker live scan — *faster and cheaper* per request.

## Verification

- `npx tsc --noEmit` clean
- `npm run build` clean
- `npm test`: 777 passing across 83 files (was 746 / 79 on `main`;
  +31 tests, +4 files)
- Live verification deferred to orchestrator: fire the Russell
  scan + probe `/api/insider-board?index=all` for `snapshot-aggregate`,
  full coverage, sub-2s latency, and UI defaults.

See `reports/phase-4l/verification.md` for the full breakdown.
