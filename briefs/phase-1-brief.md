# Phase 1 Agent Brief — TradeIQ Universe Coverage + Snapshot Infrastructure

You are the Phase 1 agent for TradeIQ. Your job is to fix the silent product bug where every board scans only the first 80–200 alphabetical tickers (so when the user picks Russell 2000, only A–G ever gets scored) and to lay the snapshot infrastructure that downstream phases depend on.

You have all credentials embedded below. Do not ask the user for tokens — they are already in this brief.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** https://tradeiq-alpha.netlify.app
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Netlify team ID.** `69c43f638748ee6e940f5f62`
**Stack.** React 18 + Vite, TypeScript Netlify Functions, Tailwind, Firebase Firestore, Anthropic Opus 4.7 on AI surfaces.
**Owner / single user.** Chad Davis (chad@davisdelivery.com).

**Required state before you start.** Phase 0 must be `done` in `ORCHESTRATOR.md`. If it isn't, stop and surface that — Phase 1 depends on Phase 0's structured logging, Sentry integration, and Anthropic budget cap so scheduled scans aren't a silent black box that burns money.

---

## The problem you are solving

Every board endpoint has a hard cap and slices the universe alphabetically. Verified by grep:

```
target-board.ts:    const PASS1_MAX = 80;
target-board.ts:    const PASS2_MAX = 20;
target-board.ts:    const pass1Tickers = smallUniverse ? allTickers : allTickers.slice(0, PASS1_MAX);
catalyst-board.ts:  const scanList = tickers.slice(0, Math.min(tickers.length, 100));
insider-board.ts:   const scanList = tickers.slice(0, Math.min(tickers.length, 80));
williams-board.ts:  const scanList = tickers.slice(0, Math.min(tickers.length, 200));
lynch-board.ts:     const scanList = tickers.slice(0, Math.min(tickers.length, 150));
```

Russell 2000 has 1,930 tickers in `universe.ts`. With these caps, anything starting with H, I, J … Z is silently invisible. Small caps are exactly where insider, political, patent, and short-interest signals carry the most edge — those are the names this app is supposed to surface and currently can't.

**Why "raise the cap" is wrong.** Netlify functions cap at 26s sync. A full 1,930-ticker × 7-layer Prophet scan is 15–20 minutes of API work. You cannot fit comprehensive scoring in a request handler. The fix is decoupling scan time from request time.

---

## Architecture

```
┌──────────────────────────┐                          ┌──────────────────────────┐
│ Netlify scheduled fns    │                          │ /api/{board}             │
│ (background, ≤15 min)    │   writes snapshot        │ (live, ≤26s)             │
│  scan-target-board       │ ───────────────────────► │  reads latest snapshot   │
│  scan-prophet            │                          │  if fresh, else          │
│  scan-catalyst           │                          │  partial live scan       │
│  scan-insider            │                          │  (current behavior)      │
│  scan-williams           │                          │                          │
│  scan-lynch              │                          │                          │
│  scan-earnings           │                          │                          │
└──────────┬───────────────┘                          └──────────┬───────────────┘
           │                                                     │
           │  writes via firebase-admin                          │  reads via firebase-admin
           ▼                                                     ▼
       ┌───────────────────────────────────────────────────────────────┐
       │ Firestore: boardSnapshots/{board}/{universe}/{snapshotId}     │
       │   {                                                           │
       │     modelVersion, generatedAt, scanDurationMs,                │
       │     universeChecked, results: [...full ranked list],          │
       │     freshnessBudgetMs                                         │
       │   }                                                           │
       └───────────────────────────────────────────────────────────────┘
```

Frontend reads from `/api/{board}` and gets comprehensive results instantly. UI surfaces a freshness pill ("Live · 8 min ago") and a "Force rescan" button that runs the current synchronous capped scan as an escape hatch.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

Existing API keys on Netlify (reference by env-var name in code):
- `ANTHROPIC_API_KEY`, `POLYGON_API_KEY`, `FINNHUB_API_KEY`, `FRED_API_KEY`, `QUIVER_API_KEY`
- `SENTRY_DSN`, `ANTHROPIC_DAILY_BUDGET_USD` (set in Phase 0)

You will need this one new env var:
- `FIREBASE_SERVICE_ACCOUNT` — JSON for `tradeiq-alpha` Firebase project. **The user already created this in Phase 0 for backups.** Reuse the same JSON. Set it on Netlify via the MCP connector after confirming with the user that it's the same project (`tradeiq-alpha`, project number `101124117025`).

---

## Required tools for this turn

`bash_tool`, `str_replace`, `create_file`, `view`, plus the Netlify deploy/read connectors. Without shell + file edit tools you cannot ship Phase 1.

---

## Read these first (in order)

1. `ORCHESTRATOR.md` — particularly Phase 1 spec; this brief is the implementation directive.
2. `briefs/phase-0-brief.md` — for context on what Phase 0 set up.
3. `netlify/functions/target-board.ts` — the two-pass pattern you'll factor out.
4. `netlify/functions/prophet-picks.ts` — the heavier 7-layer scan.
5. `netlify/functions/shared/analyst-runner.ts` — the per-ticker scorer.
6. `netlify/functions/shared/universe.ts` — the data structure (look at it; don't `cat` the whole 2,302 lines, just `head` and `grep`).
7. `src/firebase.js` — frontend Firebase pattern, for contrast with the Admin SDK pattern you'll add.
8. `netlify.toml` — function timeouts and how scheduled functions get configured.

---

## Phase 1 scope (twelve workstreams)

### Workstream 1 — Firebase Admin in Netlify functions

**Why.** Frontend `firebase.js` uses the public SDK with anon-style API keys. Backend scheduled functions need server-grade writes that bypass security rules. Use `firebase-admin`.

**Install.**
```bash
npm install firebase-admin
```

**File.** `netlify/functions/shared/firebase-admin.ts`

**Pattern.**
```ts
import { initializeApp, cert, getApps, type App } from 'firebase-admin/app';
import { getFirestore, type Firestore } from 'firebase-admin/firestore';

let _app: App | null = null;
let _db: Firestore | null = null;

export function getAdminDb(): Firestore {
  if (_db) return _db;
  if (!getApps().length) {
    const sa = process.env.FIREBASE_SERVICE_ACCOUNT;
    if (!sa) throw new Error('FIREBASE_SERVICE_ACCOUNT not set');
    _app = initializeApp({ credential: cert(JSON.parse(sa)) });
  }
  _db = getFirestore();
  return _db;
}
```

**Validation.** Write a smoke test: `node -e "const {getAdminDb}=require('./...'); getAdminDb().collection('_smoke').doc('test').set({ts: Date.now()})"`. Confirm a doc lands in Firestore.

### Workstream 2 — Snapshot store abstraction

**File.** `netlify/functions/shared/snapshot-store.ts`

**API.**
```ts
export interface BoardSnapshot {
  modelVersion: string;
  generatedAt: string;            // ISO
  scanDurationMs: number;
  universeChecked: number;
  results: any[];                 // board-specific shape; preserve raw
  freshnessBudgetMs: number;      // per-board, see below
}

export async function writeSnapshot(
  board: string,
  universe: string,
  snapshot: BoardSnapshot,
): Promise<void>;

export async function latestSnapshot(
  board: string,
  universe: string,
): Promise<BoardSnapshot | null>;

export function isSnapshotFresh(snapshot: BoardSnapshot): boolean {
  const age = Date.now() - new Date(snapshot.generatedAt).getTime();
  return age < snapshot.freshnessBudgetMs;
}

export function snapshotAgeMs(snapshot: BoardSnapshot): number {
  return Date.now() - new Date(snapshot.generatedAt).getTime();
}
```

**Firestore layout.**
- Path: `boardSnapshots/{board}/{universe}/{YYYY-MM-DD-HHmm}`
- Latest pointer: `boardSnapshots/{board}/_latest/{universe}` → `{snapshotId, generatedAt}`
- Use a transaction so reads of `_latest` are atomic.

**Freshness budgets (defaults; expose for override):**
- target-board, prophet, catalyst, williams: 30 minutes (intraday signals)
- earnings: 12 hours
- insider, lynch: 24 hours (slow-moving data)

### Workstream 3 — Model version stamp

**File.** `netlify/functions/shared/model-version.ts`

```ts
export const MODEL_VERSION = '2026.01.0';
// Bump on any change to scoring math, weights, layer thresholds, or analyst battery.
// Format: YYYY.NN.minor where NN is sequential within the year.
```

Every snapshot stamps this. Used later by Phase 4 backtest and Phase 5 calibration.

### Workstream 4 — Universe iteration utility

**File.** `netlify/functions/shared/full-scan-iterator.ts`

A concurrency-controlled async generator that walks the full universe in chunks, yielding ticker batches, with built-in pacing for Polygon (5/sec free tier, 100/sec paid) and Finnhub (60/min free, 300/min paid). Existing scans use ad-hoc `concurrency = 4` loops; consolidate into one helper.

```ts
export async function* iterateUniverse(
  tickers: string[],
  opts: { batchSize?: number; concurrency?: number; pacingMs?: number } = {}
): AsyncGenerator<string[]> {
  const batchSize = opts.batchSize ?? 8;
  for (let i = 0; i < tickers.length; i += batchSize) {
    yield tickers.slice(i, i + batchSize);
    if (opts.pacingMs) await new Promise(r => setTimeout(r, opts.pacingMs));
  }
}
```

### Workstream 5 — Scheduled scan: target-board (template for the others)

**File.** `netlify/functions/scheduled/scan-target-board.ts`

This is the template for all seven scheduled scans. The structure is the same; only the per-ticker scoring function differs.

**Logic.**
1. For each universe (`sp500`, `ndx`, `dow`, `russell2k`):
   - Pull all tickers from `universe.ts` for that index.
   - Pre-fetch all daily bars in parallel batches via `iterateUniverse` (concurrency 8, pacing 100ms).
   - Run pass-1 cheap pre-score on all tickers (no API calls per ticker after bars are cached).
   - Sort by pre-score, take top N (e.g., 200 for Russell 2K, 100 for S&P).
   - Run full analyst battery on survivors. This is where the per-ticker time is.
   - Compose final ranked list — keep ALL survivors in the snapshot, not just top 50. Frontend can paginate/filter/sort.
   - Write snapshot via `writeSnapshot('target-board', universe, snapshot)`.
2. Log each universe's scan duration, ticker count, results count via the structured logger from Phase 0.
3. On any per-ticker error: log + continue (don't fail the whole scan).
4. On full-scan failure: capture to Sentry, fail loud, leave previous snapshot in place (don't delete).

**Schedule (in `netlify.toml`).**
```toml
[[scheduled.functions]]
  name = "scan-target-board"
  schedule = "0,30 13-21 * * 1-5"  # every 30 min during US market hours, weekdays
  timeout = 900                     # 15 min background
```

(All times in UTC. 13:00 UTC ≈ 09:00 ET market open. 21:00 UTC ≈ 17:00 ET after close.)

**Validation.**
- Manually trigger the scheduled function via Netlify UI / API.
- Verify snapshot lands in Firestore for each universe.
- Verify it covers tickers from end of alphabet (e.g., assert at least one Z-ticker).

### Workstreams 6–11 — Scheduled scans for the other six boards

Each follows the Workstream 5 template:
- `scan-prophet.ts` — calls `runProphetForTicker` from existing `prophet-picks.ts`. Same 30-min cadence.
- `scan-catalyst.ts` — same cadence, full universe.
- `scan-insider.ts` — daily at 17:30 ET (insider data updates after close); just pull QuiverQuant/Finnhub for full universe.
- `scan-williams.ts` — same 30-min cadence.
- `scan-lynch.ts` — daily at 18:00 ET (fundamentals don't move intraday).
- `scan-earnings.ts` — twice daily, 06:00 and 17:00 ET.

For each: factor out the per-ticker scoring function from the existing live endpoint into a shared module so both the scheduled scan and the live endpoint can call it. Don't duplicate scoring logic in two places — that's the cache-poisoning bug pattern reborn.

**Refactor pattern:**
```
netlify/functions/target-board.ts   →  ts (calls scoreTargetForTicker)
netlify/functions/scheduled/scan-target-board.ts  →  ts (calls scoreTargetForTicker)
netlify/functions/shared/score-target.ts  →  scoreTargetForTicker (NEW, factored)
```

Apply the same refactor to all seven boards.

### Workstream 12 — Live API rewire

For each of the seven board endpoints, change the request handler logic to:

1. Read `latestSnapshot(board, universe)` from Firestore.
2. If snapshot exists and `isSnapshotFresh()` → return its results immediately. Add `cached: true, source: 'snapshot', generatedAt, ageMs` to response.
3. If snapshot is stale or missing → log a warning (this means scheduled scan is failing) and fall back to the current synchronous capped scan. Add `cached: false, source: 'fallback-partial', warning: 'snapshot stale or missing'` to response.
4. If `?force=1` query param is set → skip snapshot, run synchronous capped scan, return with `source: 'forced-partial'`.

**Critical preservation rule (standing rule of the codebase).** Snapshots store the FULL raw result list. Live endpoints can paginate / filter / slice for the response, but the snapshot itself never gets trimmed. Phase 4 backtest and Phase 5 calibration depend on the raw list being intact.

### Workstream 13 — Frontend freshness pill + force-rescan button

**Files.** Every view component (TargetBoardView, ProphetView, etc.).

**UI.**
- Top-right of each board: small pill showing data age. Examples:
  - Green: "Live · 8 min ago"
  - Yellow: "Stale · 47 min ago" (when over freshness budget but snapshot exists)
  - Red: "Fallback · partial scan" (when snapshot missing entirely)
- Next to it: "Force rescan" button — triggers `?force=1` request. Shows partial-scan warning toast on completion.

Use the existing color palette and SortableTh / fmt patterns already in the codebase. Don't introduce new design primitives — the standing rule is consistency with MarginIQ-derived patterns.

### Workstream 14 — Health endpoint surfaces snapshot age

**File.** `netlify/functions/health.ts`

Modify response to include:
```json
{
  "snapshots": {
    "target-board": { "sp500": "5m", "ndx": "5m", "russell2k": "12m", "dow": "5m" },
    "prophet": { ... },
    ...
  }
}
```

If any snapshot age exceeds 2× freshness budget, set health status to `degraded`.

### Workstream 15 — HistoryView (snapshot replay)

**File.** `src/views/HistoryView.jsx`

Tab in nav. Date picker + board picker + universe picker. Shows that day's snapshot exactly as it was. Read-only — useful for "what was the model recommending on day X when I made trade Y".

This view is a low-fi version of what Phase 4 backtest will eventually consume programmatically.

### Workstream 16 — Backfill script (one-shot)

**File.** `scripts/backfill-snapshots.ts`

Reconstruct partial historical snapshots from existing `tradeLog` entries. For each unique (date, ticker) pair in the journal, write a single-ticker snapshot to Firestore so HistoryView shows something rather than nothing for past dates.

This is one-shot — run once after deploy, then delete from production scheduled tasks.

### Workstream 17 — netlify.toml scheduled functions

**File.** `netlify.toml`

Add a `[[scheduled.functions]]` block per scheduled scan. Reference Netlify docs for cron syntax. All scans should use `timeout = 900` (15 min background timeout).

### Workstream 18 — APP_VERSION bump + ORCHESTRATOR status

Bump to `0.9.0-alpha` (minor bump for the universe-coverage capability). Update ORCHESTRATOR.md status table:

```
| 1 | Universe coverage + snapshot infrastructure | done | 0.9.0-alpha | YYYY-MM-DD | Full-universe scheduled scans land. All boards now read from snapshots, fall back to partial. |
```

---

## Standing rules (apply to every commit)

- ALWAYS bump `APP_VERSION` in `src/App.jsx`. Phase 1 ships `0.9.0-alpha`.
- Every data table column sortable via `useSortable` + `SortableTh`. HistoryView's date list also.
- Anything to be copied into another tool/conversation goes in a markdown doc or code block. Never plain prose.
- **Critical data ingest preserves four layers** — particularly important here. The snapshot stores raw results from analyst battery in full. Don't reduce to "top 50" in the snapshot itself; reduce only at API response time.
- Brand blue: `#1e5b92` (Davis Delivery family — TradeIQ stays neutral dark).
- Don't refer to Davis Delivery Dispatch as "Glory Bound Dispatch".

---

## Cost / budget guardrails

A full 1,930-ticker × 7-layer scan every 30 minutes during market hours is significant API spend. Sanity-check before deploying scheduled functions to prod:

- Polygon: ~1,930 bar pulls + ~600 fundamentals pulls per scan. At paid-tier rate limits, fine. On free tier, each scan can take 15–20 minutes due to 5 req/sec — that's tight against the 15-min Netlify background timeout.
- Finnhub: ~1,930 earnings calendar + ~600 recommendation pulls per scan. Free tier 60 req/min; you may need to throttle.
- QuiverQuant: insider/political/patent/contracts. Their tier limits depend on your plan.
- Anthropic: scheduled scans should NOT call Claude. AI features (research, prophet narrative, chart-analysis) stay request-driven. Scheduled scans use rule-based scoring only. **Verify this** — if any analyst calls Claude, refactor it out.

If a scan would exceed remaining daily Anthropic budget (Phase 0 cap), abort the scan and Sentry-alert. Don't trickle out half-scans.

---

## Deploy pattern

After your PR is merged, Netlify auto-deploys. Verify:
1. Wait 60s, check bundle has v0.9.0-alpha.
2. Hit `/api/health` — confirm it shows snapshot ages (scheduled scans haven't run yet, so all will be `null` initially).
3. Manually trigger one scheduled function via Netlify UI.
4. Wait 5–10 min, hit `/api/health` again — confirm at least one snapshot age shows.
5. Hit `/api/target-board?universe=russell2k` — confirm response has `source: 'snapshot'` and a result containing some Z-tickers.
6. Visual check: Russell 2K screen on phone shows comprehensive list with freshness pill.

---

## Working tree setup

```bash
cd /home/claude
if [ ! -d tradeiq ]; then
  git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
fi
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git pull --rebase
git checkout -b phase-1-universe-coverage
```

---

## Commit and PR protocol

Commits per workstream. Examples:
- `phase-1(admin): firebase-admin in netlify functions`
- `phase-1(store): snapshot-store abstraction over firestore`
- `phase-1(refactor): factor scoreTargetForTicker out of target-board.ts handler`
- `phase-1(scheduled): scan-target-board for all 4 universes`
- `phase-1(scheduled): scan-prophet, scan-catalyst, scan-williams`
- `phase-1(scheduled): scan-insider, scan-lynch, scan-earnings`
- `phase-1(api): rewire 7 board endpoints to read snapshot-first`
- `phase-1(ui): freshness pill + force-rescan on every board`
- `phase-1(ui): HistoryView for snapshot replay`
- `phase-1(health): expose per-board snapshot ages`
- `phase-1(scripts): one-shot backfill from tradeLog`
- `phase-1(docs): version bump 0.9.0-alpha + status update`

PR title: `Phase 1: Universe coverage + snapshot infrastructure (v0.9.0-alpha)`

PR description must include:
- Confirmation of Phase 0 dependencies satisfied
- Number of scheduled functions deployed and their crons
- Confirmation a Z-ticker (or similar end-of-alphabet smoke check) appears in a Russell 2K snapshot
- Anthropic spend impact estimate (should be ~zero if scheduled scans don't call Claude)
- One-time user actions: confirming `FIREBASE_SERVICE_ACCOUNT` env var is reused from Phase 0 backups, manually triggering first scheduled run

---

## Success criteria (testable definition of done)

All must be true before marking Phase 1 done:

- [ ] `firebase-admin` initializes successfully in a Netlify function smoke test.
- [ ] Snapshot store reads/writes verified via Firestore console.
- [ ] All seven scheduled scans exist in `netlify/functions/scheduled/`.
- [ ] All seven scheduled functions are configured in `netlify.toml`.
- [ ] `MODEL_VERSION` is stamped on every snapshot.
- [ ] After first scheduled run, snapshot for at least one universe of every board exists in Firestore.
- [ ] `/api/target-board?universe=russell2k` returns `source: 'snapshot'` and contains tickers from across the alphabet (verify by scanning result list for at least one ticker starting with each letter group A, M, S, Z).
- [ ] `/api/target-board?universe=russell2k&force=1` runs the legacy capped scan and returns `source: 'forced-partial'`.
- [ ] Freshness pill renders correctly on all 7 board views.
- [ ] HistoryView renders yesterday's snapshot for at least one board.
- [ ] Health endpoint shows per-board snapshot ages.
- [ ] No scheduled scan calls Claude (Anthropic budget impact ≈ zero).
- [ ] Phase 0 regression tests still pass.
- [ ] APP_VERSION = `0.9.0-alpha` and verified in live bundle.
- [ ] ORCHESTRATOR.md Status table shows Phase 1 as `done`.

---

## What to do if blocked

- **`FIREBASE_SERVICE_ACCOUNT` not set on Netlify.** Document in PR. Code will throw on first scheduled run, which is correct behavior (fail loud).
- **Polygon rate-limit hits during full-scan.** Tune `iterateUniverse` pacing. If you can't fit a full scan in 15 min, split universes across multiple scheduled functions (one for sp500+ndx+dow, one for russell2k).
- **Firestore quota concern.** Document the scan frequency and let user know if free Spark plan is being approached. Switching to Blaze (pay-as-you-go) for snapshot storage costs pennies/month.
- **Existing live endpoints break during refactor.** Refactor the per-ticker scorer behind a feature flag (env var `USE_SNAPSHOT_LAYER=1`) so you can ship the snapshot infrastructure first, then flip endpoints over one by one in subsequent commits within the same PR.

---

## Out of scope for Phase 1

- Refactoring App.jsx (Phase 2).
- Adding TanStack Query to frontend data fetching (Phase 2).
- Adding Zod schemas at boundaries (Phase 2).
- Point-in-time data semantics (Phase 3 — snapshots are forward-only for now; the historical-PIT layer comes later).
- Backtest engine (Phase 4 — even though Phase 1 produces the snapshots Phase 4 will consume, the backtest engine itself is Phase 4).
- Auth (Phase 12).
- Per-user data segregation (Phase 12).

---

## First actions

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git pull --rebase

# Confirm Phase 0 is done
grep "^| 0 |" ORCHESTRATOR.md
# Should show: | 0 | Engineering foundation + safety nets | done | ...
# If pending, STOP and surface to user.

git checkout -b phase-1-universe-coverage

# Read context
head -200 ORCHESTRATOR.md  # see Phase 1 spec
ls netlify/functions/
grep -n "PASS1_MAX\|slice(0," netlify/functions/*-board.ts netlify/functions/prophet-picks.ts
wc -l netlify/functions/shared/universe.ts

# Workstream 1 — install firebase-admin
npm install firebase-admin
```

Then proceed through workstreams. Workstreams 1–4 (foundation) before Workstreams 5–11 (scans). Workstream 12 (live API rewire) last among backend work because it depends on snapshots existing.

---

End of brief. Begin work.
