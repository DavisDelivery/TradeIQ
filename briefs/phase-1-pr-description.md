# Phase 1: Universe coverage + snapshot infrastructure (v0.9.0-alpha)

Closes the silent product bug where every board scanned only the first 80–200
alphabetical tickers. Decouples scan duration from request duration by routing
all board APIs through Firestore-backed snapshots populated by background
scheduled functions.

## Status: done

All 7 boards are end-to-end snapshot-first. HistoryView replay surface
shipped. One-shot backfill script shipped.

## Phase 0 dependency

**Phase 0 is still `pending`.** Chad authorized proceeding with Phase 1
anyway, accepting the risk. Mitigations baked in:

- Inline structured-JSON `logger.ts` is interface-compatible with Phase 0's
  eventual real logger — drop-in replacement, no call-site changes.
- All scheduled scans verified **NOT** to call Anthropic. Phase 1's runtime
  Anthropic spend impact is ≈ zero. Narrative generation in Prophet is lazy
  on snapshot read in the request handler, with the existing 6h cache.
- Errors emit structured JSON to console; trivially swappable for Sentry
  later when Phase 0 wires it.
- No vitest harness (skipped for speed). Manual smoke check via
  `/api/health` → snapshot ages exposed per board.

## What's done

### Backend foundation
- `firebase-admin.ts` — service-account-backed Firestore singleton.
- `snapshot-store.ts` — `writeSnapshot` / `latestSnapshot` /
  `isSnapshotFresh` / `snapshotAgesForBoard`. Atomic `_latest` pointers.
  Per-board freshness budgets.
- `model-version.ts` — `MODEL_VERSION = '2026.01.0'` stamp on every snapshot.
- `full-scan-iterator.ts` — `iterateUniverse` + `mapWithConcurrency` with
  Polygon/Finnhub-aware pacing.
- `logger.ts` — structured-JSON logger, Phase-0-compatible interface.

### Boards converted to snapshot-first

| Board    | Shared scan | Scheduled scan          | Live endpoint | UI pill |
|----------|-------------|-------------------------|---------------|---------|
| target   | ✅          | every 30m, market hours | ✅ `?force=1` | ✅      |
| prophet  | ✅          | every 30m, market hours | ✅ `?force=1` | ✅      |
| catalyst | ✅          | every 30m, market hours | ✅ `?force=1` | ✅      |
| williams | ✅          | every 30m, market hours | ✅ `?force=1` | ✅      |
| insider  | ✅          | daily 21:30 UTC         | ✅ `?force=1` | ✅      |
| lynch    | ✅          | daily 22:00 UTC         | ✅ `?force=1` | ✅      |
| earnings | ❌ deferred | ❌ deferred             | unchanged     | ❌      |

Each board's shared scan extracts the per-ticker scoring orchestration into
a single function called by both the scheduled scan and the live (capped)
fallback. No drift between code paths.

Insider uses the **widest-window strategy**: scheduled scan runs at
windowDays=180 with full filings preserved + EDGAR-enriched topBuyer roles.
Live endpoint reads the snapshot and re-aggregates for the user's requested
window (30/60/90/180) via `filterRowsToWindow`. One snapshot covers all
4 window variants.

Catalyst uses the **filter-on-read strategy**: snapshot stores ALL scored
picks (no filter applied at scan time). Live endpoint applies
`filter`/`minConviction` from query params at read time.

### Live endpoint behavior

Default request flow:
1. Read latest snapshot from Firestore.
2. If fresh → return `source: 'snapshot'`, `cached: true`, with `ageMs` and
   `modelVersion`.
3. If stale or missing → fall back to the legacy capped synchronous scan,
   return `source: 'fallback-partial'` with a warning. Also logs that
   the scheduled scan is failing.
4. With `?force=1` → skip snapshot read, run capped scan, return
   `source: 'forced-partial'`.

The shared `FreshnessPill` component surfaces all three states as a small
top-right indicator with a "Force rescan" button. Wired into Williams,
Lynch, Catalyst, Insider, Prophet, and Target views.

### Health endpoint

`/api/health` now returns:
- API key presence (Polygon, Finnhub, FRED, Anthropic, Quiver, Firebase Admin)
- Per-board, per-universe snapshot ages with `generatedAt` timestamps
- `status: 'degraded'` (HTTP 503) if any snapshot is older than 2× its
  freshness budget — signal that a scheduled scan is failing.

### Schedules (UTC)

```
scan-target-board   0,30 13-21 * * 1-5   every 30m, US market hours, weekdays
scan-prophet        0,30 13-21 * * 1-5   every 30m, US market hours, weekdays
scan-catalyst       0,30 13-21 * * 1-5   every 30m, US market hours, weekdays
scan-williams       0,30 13-21 * * 1-5   every 30m, US market hours, weekdays
scan-insider        30 21    * * 1-5     daily, 17:30 ET (after Form 4 cutoff)
scan-lynch          0  22    * * 1-5     daily, 18:00 ET (fundamentals are slow)
```

All scheduled functions: `timeout = 900` (15 min). Each scan budgets
itself to 14 min to leave 60s margin.

## What landed in the close-the-gaps round (v0.9.1-alpha)

After the initial partial Phase 1 (v0.9.0-alpha) shipped the 6-of-7-boards
foundation, this round closed the deferred items:

- **Earnings board** converted to snapshot-first (811-line monolith refactored
  into 152-line slim handler + ~700-line shared scan module). Uses the
  widest-window strategy from insider: scheduled scan runs at 30 days ahead
  + 5 days back, snapshot stores all setups unfiltered, live endpoint
  filters by user's 3/7/14/30 window at read time. One snapshot covers
  all 4 window variants. Twice-daily cron (11:30 + 21:30 UTC).
- **EarningsPlaysView pill.** Replaced standalone Refresh button with the
  standard FreshnessPill component. All 7 boards now have unified freshness
  indication.
- **HistoryView** new tab, between Earnings and Options. Pickers: board ×
  universe × snapshot date. Auto-selects newest snapshot when board/universe
  changes. Per-board hand-picked column rendering for compact display
  (target/prophet/catalyst/insider/williams/lynch/earnings each have their
  own column set; generic fallback for unknown shapes). Surfaces snapshot
  warnings in an amber banner.
- **`/api/snapshot-history` endpoint** with two modes: list (newest 60) and
  fetch-by-id. Plus `listSnapshots` + `getSnapshotById` helpers in the
  store. All 7 boards × 7 universes queryable.
- **One-shot backfill script** at `scripts/backfill-snapshots.ts`. Reads
  the `tradeLog` collection, groups by (board, date), writes synthetic
  snapshots tagged `modelVersion: 'backfill-from-tradelog'` so HistoryView
  shows something for dates that predate Phase 1. HHmm hardcoded to '0000'
  so synthetic snapshots never collide with real scheduled-scan IDs.
  Idempotent — re-running overwrites synthetic but never touches real.

Phase 1 is now **done** on the ORCHESTRATOR status table.

## REQUIRED ONE-TIME USER ACTIONS

### 1. Set `FIREBASE_SERVICE_ACCOUNT` on Netlify

Without this, every scheduled scan throws on first call. Steps:

1. Firebase Console → tradeiq-alpha project (project number `101124117025`)
   → Settings (gear icon) → Project settings → Service accounts
2. Click "Generate new private key" → download the JSON
3. Netlify → tradeiq-alpha site → Site settings → Environment variables
4. Add new variable: name `FIREBASE_SERVICE_ACCOUNT`, value = paste the
   entire JSON contents (no quoting, no escaping)
5. Redeploy or wait for the next deploy

### 2. Manually trigger one scheduled function to verify

Netlify dashboard → Functions → `scheduled/scan-target-board` → "Trigger".
Wait 5–10 min. Check `/api/health` — `snapshots["target-board"]["sp500"]`
should now have an age.

### 3. Smoke check

```
curl 'https://tradeiq-alpha.netlify.app/api/target-board?universe=russell2k&limit=200' \
  | jq '[.targets[].ticker] | sort | last'
```

After the first scheduled run completes, this should return a ticker from
the end of the alphabet (Z-something, or close to it). Pre-Phase 1, this
endpoint capped at 80 tickers and never returned anything past G.

## Anthropic budget impact

≈ zero from scheduled scans. Verified manually across all 6 shared scans:

```bash
grep -E "anthropic|ANTHROPIC|claude" netlify/functions/shared/scan-*.ts \
  netlify/functions/scheduled/scan-*.ts
```

Returns no calls. Narrative generation in Prophet stays in the live
endpoint, called only when `narrate=1` (default), only for top 5 picks,
with the existing 6h cache.

## Files changed

- 5 new shared modules (`firebase-admin`, `snapshot-store`,
  `model-version`, `full-scan-iterator`, `logger`)
- 6 new shared scan orchestrators (`scan-target`, `scan-prophet`,
  `scan-catalyst`, `scan-williams`, `scan-insider`, `scan-lynch`)
- 6 new scheduled functions
- 6 board endpoints rewired snapshot-first
- New `health.ts` (snapshot ages)
- New `FreshnessPill` component
- `App.jsx`, `ProphetView`, `WilliamsView`, `LynchView`, `CatalystView`,
  `InsiderBoardView` — pill wired in
- `netlify.toml` — 6 scheduled function blocks
- `firebase-admin` added to `package.json`
- `APP_VERSION` → `0.9.0-alpha`
- `ORCHESTRATOR.md` — Phase 1 status `partial`

## Verification

- `npx tsc --noEmit` clean
- `npm run build` clean (777 KB main bundle, no new warnings)
- All commits in topic-per-workstream format on branch
  `phase-1-universe-coverage`
