# Phase 4h Executor Kickoff — Russell scan reliability + nightly schedule + company-info display

> **For Chad:** paste the bootstrap block at the very end of this file
> as the opening message of a new Claude chat. The GitHub PAT is
> embedded inline; no follow-up message needed.

---

You are an executor agent. Your single assignment is **Phase 4h** of
the TradeIQ project. The conversation you are reading is your complete
boot prompt. Read it end-to-end, then read `briefs/phase-4h-brief.md`
in the repo (your full rationale, cost analysis, and architecture
detail live there), then start with PART 1 below.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. It scans universes of tickers
(dow ~30, ndx ~100, sp500 ~500, russell2k ~2000), scores each name
through an analyst pipeline, and presents ranked "target board" picks.
Owner: Chad Davis. Stack: TypeScript Netlify functions + React 18 /
Vite SPA + Firestore + Polygon.

## The problem you're fixing (summary — full detail in the brief)

The Russell 2000 target board has never worked. Three defects:

1. **The scan never completes.** `scan-target-board-russell2k.ts`
   scores ~2000 names single-pass (~33-67 min) but Netlify background
   functions are killed at 15 minutes. Every run is terminated before
   finishing; a complete fresh Russell snapshot has effectively never
   existed.
2. **The read endpoint hangs ~25s.** `target-board.ts` is snapshot-first
   (fast — O(1) pointer read). But when no fresh snapshot exists —
   always, for Russell — it falls through to `runLiveAndRespond()`,
   which runs a live partial scan **synchronously inside the HTTP
   request**. That inline scan is the hang.
3. **No company name or sector on a pick.** A pick is a bare ticker.
   The sector value is already computed by the `sector-rotation`
   analyst but never attached to the pick object; company name is not
   fetched anywhere.

## Your assignment in two sentences

Make the Russell (and sp500) target-board scan complete reliably by
chaining it across the 15-minute ceiling with Phase 4e-1-infra's
checkpoint-resume pattern; remove the inline-live-scan fallback so the
read endpoint is O(1); and attach + display company name and sector on
every pick. Ship as one PR with full tests.

## Chad's settled decisions (these are FINAL — do not re-litigate)

- **Cadence: nightly only.** One scheduled scan per day per large
  universe. No every-30-minute cron.
- **Scan time: 7pm ET → cron `0 23 * * *`** (23:00 UTC). This replaces
  both the old daytime cron and the stopgap nightly.
- **Sector taxonomy: existing labels.** Use the `sector-rotation`
  analyst's sector values as-is. No GICS normalization.
- **Snapshot retention: keep last 30 per universe.**

---

# PART 1 — COLD START

## 1.1 Boot commands

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
# Expected top commit near the top: a CI fix + the phase-4h brief
git config user.email "executor-4h@tradeiq.local"
git config user.name "Executor 4h"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # baseline 694 passing
npm run build                # must complete cleanly

git checkout -b phase-4h-russell-scan-reliability
```

If baseline fails, STOP and report with exact output.

## 1.2 Read the brief

`briefs/phase-4h-brief.md` is your full spec — read it before writing
code. It contains the forensic detail on each defect, the cost model,
the cursor schema, the atomic-swap requirement, and the risk register.
This kickoff is the executable layer; the brief is the why.

## 1.3 Secrets handling

**Inline:** GitHub PAT (write-scoped, repo) in the clone URL. Used for
`git push` + `POST /pulls`. No other credentials needed — live
verification runs post-merge against the deploy, which has Polygon +
Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 Files you ARE allowed to touch

- `netlify/functions/scan-target-board-russell2k.ts` — refactor to
  checkpoint-resume
- `netlify/functions/scan-target-board-sp500.ts` — same (prophylactic)
- `netlify/functions/scan-target-board-russell2k-nightly.ts` — **DELETE**
  (the stopgap; superseded by the proper scheduled scan)
- `netlify/functions/target-board.ts` — remove the inline-live-scan
  fallback for large universes; serve stale-flagged instead
- `netlify/functions/shared/snapshot-store.ts` — freshness budget;
  retention/cleanup of old snapshots; the `sector`/`companyName` fields
  on the snapshot pick schema
- `netlify/functions/shared/scan-target.ts` — the scan worker, if it
  needs to expose per-batch progress for the cursor
- A new shared scan-resume layer, OR a generalization of
  `shared/backtest-resume/` — your call (see PART 3)
- `netlify/functions/shared/ticker-reference.ts` — NEW, the cached
  Polygon company-name lookup (or co-locate in an existing util)
- `src/components/AnalystContributions.jsx` + the pick-row renderer —
  display company name + sector
- `netlify.toml` if scheduling is declared there (check; some schedules
  are in-file via `schedule()`)
- test files for all of the above
- `briefs/phase-4h-pr-description.md` + `reports/phase-4h/verification.md`
  — you create
- `src/App.jsx` — APP_VERSION bump
- `ORCHESTRATOR.md` — mark 4h done at the end

## 2.2 Files you may NOT touch

- `netlify/functions/shared/backtest/*`, `shared/prophet-portfolio/*`,
  `shared/backtest-resume/*` (unless you deliberately generalize the
  resume modules — if so, do it as a clean rename/extract that keeps
  all backtest tests green, and ONLY that)
- Any analyst / scoring logic — 4h moves and surfaces data; it does not
  change how a score is computed. MODEL_VERSION stays put.
- `run-backtest-background.ts`, `run-portfolio-backtest-background.ts`
- The per-analyst Russell scans (`scan-catalyst-russell2k.ts`,
  `scan-insider-russell2k.ts`, etc.) — out of scope
- `.github/workflows/*` — leave CI alone
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`

## 2.3 The pattern to reuse

`netlify/functions/shared/backtest-resume/{cursor,watchdog,reinvoke}.ts`
(shipped by Phase 4e-1-infra, PR #32, proven in production across 53
chained invocations). Study these three files first. The scan needs the
identical shape: a cursor recording resume position, a watchdog that
trips before the 15-minute kill, and a `Context.waitUntil`-based
self-reinvoke.

---

# PART 3 — THE WORK (four workstreams, recommended order W3 → W2 → W1 → W4)

## W3 — Company name + sector enrichment (do first; lowest risk)

- Add `companyName: string` and `sector: string | null` to the snapshot
  pick schema in `snapshot-store.ts` (and any shared pick type).
- `sector`: populate from the value the `sector-rotation` analyst
  already computes during scoring. It exists in the pipeline — thread
  it onto the pick object. Do NOT add a new sector data source.
- `companyName`: fetch from Polygon `/v3/reference/tickers/{ticker}`.
  Build a small persistent cache (`ticker-reference.ts`) — a Firestore
  collection `tickerReference/{ticker}` storing `{ name, fetchedAt }`.
  On scan, look up cache first; only call Polygon on a miss. Reference
  data effectively never changes, so this is a one-time ~2,500-call
  cost across all universes, then near-zero.
- Both fields are written into the snapshot at scan time, so reads
  serve them for free.

## W2 — Read-endpoint de-hang

In `target-board.ts` / `snapshot-store.ts`:

1. For `russell2k` and `sp500`, when no fresh snapshot exists, the
   endpoint must **return the last complete snapshot flagged stale**
   (`stale: true`, include `generatedAt`), NEVER call
   `runLiveAndRespond`. `dow`/`ndx` may keep the live fallback (small
   enough to be harmless).
2. Widen `freshnessBudgetMs` for the target board to comfortably exceed
   the gap between scans. Nightly cadence → set it to ~26 hours so the
   snapshot reads "fresh" all day until the next scan. (Confirm the
   exact field/structure in `FRESHNESS_BUDGETS_MS`.)

## W1 — Scan checkpoint-and-resume (the substantive change)

Refactor `scan-target-board-russell2k.ts` and `scan-target-board-sp500.ts`
to chain across the 15-minute ceiling.

- **Cursor:** persist `{ universe, board, status, nextTickerIndex,
  totalTickers, invocationCount, startedAt }` to a run doc (e.g.
  `scanRuns/{runId}`).
- **Partial results:** accumulated scored rows go to a subcollection
  (`scanRuns/{runId}/partial/{batchId}`), NOT onto the cursor doc —
  russell2k × full analyst payloads will approach Firestore's 1 MiB
  doc ceiling (the same trap 4e-1-infra hit with mlTraining; solve it
  the same way).
- **Batch size:** tune so a batch finishes inside a ~13-minute watchdog
  budget (≥2 min margin under the 15-min kill).
- **Self-reinvoke:** `Context.waitUntil(fetch(SAME_FUNCTION_URL,
  { resume: true }))` — reuse `reinvoke.ts`.
- **Atomic swap:** the terminal batch assembles the full result set,
  calls `writeSnapshot` once, and only THEN advances the `_latest`
  pointer. A scan in progress must never degrade the live board; the
  previous complete snapshot stays served until the new one is done.
  A failed mid-scan leaves the last good snapshot untouched.
- **Schedule:** one scheduled entry, cron `0 23 * * *` (7pm ET). Remove
  the old `0,30 13-21 * * 1-5` daytime cron and delete the stopgap file
  `scan-target-board-russell2k-nightly.ts`.
- **Retention:** after a successful scan, prune
  `boardSnapshots/target-board/runs/` for that universe to the most
  recent 30.

Whether you generalize `shared/backtest-resume/` into a shared
`shared/resume/` namespace or build a thin scan-specific layer modeled
on it is your call — pick the cleaner one and keep all existing
backtest tests green.

## W4 — UI surfacing

`AnalystContributions.jsx` + the pick-row renderer: show `companyName`
and `sector` next to the ticker and composite. Keep TradeIQ's existing
visual system (brand blue `#1e5b92`). Small, contained React change.
If a snapshot is served stale-flagged, surface a subtle "as of
{generatedAt}" indication so the user knows.

---

# PART 4 — TESTS

- Scan cursor: advance, resume from mid-universe, terminal detection.
- Terminal-only publish: a partially-complete scan does NOT advance the
  `_latest` pointer; the previous snapshot stays served.
- Read fallback: `russell2k`/`sp500` with a stale snapshot returns
  stale-flagged complete data, never triggers a live scan.
- Freshness budget: a snapshot N hours old still reads fresh within the
  widened budget.
- Enrichment: every pick carries non-empty `companyName` + `sector`;
  ticker-reference cache hit avoids the Polygon call.
- Retention: after a scan, `runs/` for the universe holds ≤ 30 docs.
- Don't network in unit tests — mock Polygon + Firestore.
- Baseline 694; expect a meaningful positive delta. Report the real
  number; do not pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + one for tests + one for the verification
  report.
- APP_VERSION: bump `0.18.4-alpha` → `0.18.5-alpha` in `src/App.jsx`.
- MODEL_VERSION: unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Match the house style of existing scan functions and `target-board.ts`.

---

# PART 6 — PR + ACCEPTANCE

## 6.1 Push + open PR

```bash
git push -u origin phase-4h-russell-scan-reliability
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4h - Russell scan reliability + nightly schedule + company info",
    "head": "phase-4h-russell-scan-reliability",
    "base": "main",
    "body": "See briefs/phase-4h-brief.md and reports/phase-4h/verification.md. Checkpoint-resume for the russell2k + sp500 target-board scans; read-endpoint inline-live-scan fallback removed; companyName + sector on every pick; nightly 7pm ET cron replaces the daytime cron + stopgap."
  }'
```

## 6.2 Acceptance (verified post-merge by the orchestrator)

Live verification is deferred — the executor sandbox has no outbound
network to the deploy. The orchestrator will, after merge:
1. Fire a manual `russell2k` scan; confirm it completes
   (`status: done`, ~2000 names, `invocationCount > 1`).
2. Probe `/api/target-board?universe=russell2k` for sub-2-second
   latency at an arbitrary time of day.
3. Confirm every pick has `companyName` + `sector`.
4. Confirm the old crons are gone and the 7pm scheduled scan is
   registered.

Document the expected scan duration and the before/after compute
figures in `reports/phase-4h/verification.md`.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post a single message in this conversation:

```
PR #N open: https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: scan-target-board russell2k + sp500 refactored to checkpoint-resume
- W2: target-board.ts inline-live-scan fallback removed for large
      universes; freshness budget widened to ~26h
- W3: companyName + sector on every pick; ticker-reference cache added
- W4: company name + sector displayed in the UI
- Old daytime cron removed; stopgap nightly file deleted; 7pm ET
  scheduled scan added

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was 694)
- npm run build: clean

Acceptance: DEFERRED to post-merge (orchestrator fires the live scan)

Known limitations:
- <anything worth flagging>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Publishing a partial scan.** The `_latest` pointer advances ONLY on
  the terminal batch's successful `writeSnapshot`. Test this.
- **Cursor/partial payload hitting the 1 MiB ceiling.** Partial results
  go to a subcollection from the start.
- **Leaving the freshness budget too short.** A nightly scan with a
  short budget means the endpoint reads "stale" by afternoon and — even
  with the fallback change — mislabels the board. Set ~26h.
- **Forgetting sp500.** Both russell2k and sp500 get the checkpoint-resume
  treatment.
- **Adding a new sector source.** Use the `sector-rotation` analyst's
  existing value. Do not introduce GICS or a new Polygon call for it.
- **Uncached Polygon enrichment.** Cache ticker reference data
  persistently; it never changes.
- **Touching scoring logic or MODEL_VERSION.** 4h is data movement +
  scheduling, not a scoring change.
- **Networking in unit tests.**

---

# PART 9 — PARALLEL CONTEXT

Phase 5a-prep merged (`0b99745`); 4i merged (`636c1d9`); 4e-1-infra
merged (`32773fb`). A CI fix for the Firestore backup workflow merged
just before this kickoff. The 5a discovery agent may be running in a
separate conversation — it touches Python pipeline files, disjoint from
your TypeScript scan work; no conflict. Backtests may be running
server-side — unrelated; don't poll them.

---

End of kickoff. Read this end-to-end, then read `briefs/phase-4h-brief.md`,
then start with PART 1.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4h of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4h-executor.md — that's your full assignment —
   then read briefs/phase-4h-brief.md for the rationale and architecture.

Everything you need is in those two files: the three defects, the
checkpoint-resume pattern to reuse, the four workstreams, Chad's settled
decisions (nightly only, 7pm ET, existing sector labels, keep last 30),
the test plan, and the failure modes. Start with PART 1 once you've read
both end-to-end. ~3-4 hour session.
