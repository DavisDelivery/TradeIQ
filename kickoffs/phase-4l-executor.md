# Phase 4l Executor Kickoff — Insider board completeness

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4l** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4l-brief.md` in the
repo (full rationale + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. One of its boards is the insiders
board — it scans universes of tickers for SEC insider transactions
(open-market buys, sells, option exercises, grants) and presents
aggregated rows. Owner: Chad Davis. Stack: TypeScript Netlify functions
+ React 18 / Vite SPA + Firestore + Finnhub (insider data) + Polygon.

## The problem you're fixing (summary — full detail in the brief)

The insiders board claims to cover the S&P 500, Dow, Nasdaq 100, and
Russell 2000 (~2,245 names) but shows only ~33 tickers. Two defects:

1. **`index=all` scans only 80 tickers.** `insider-board.ts` is
   snapshot-first *only for a single index*; when `index=all` it skips
   snapshots and runs a capped live scan (`LIVE_SCAN_CAP = 80`). The
   "all" view never reads the per-universe snapshots.
2. **The Russell 2000 insider scan can't finish.** The per-universe
   scheduled scans run daily, but `scan-insider-russell2k.ts` (~2,000
   Finnhub calls) hits the Netlify 15-minute background ceiling — same
   defect class Phase 4h fixed for the target board.

## Your assignment in one sentence

Make `index=all` aggregate the four per-universe snapshots, apply 4h's
checkpoint-resume to the Russell insider scan, and make the insider
board UI default to net buyers with fully sortable columns — shipped as
one PR with full tests.

## Chad's settled decisions (FINAL — do not re-litigate)

- **Default view: net buyers**, with a Buyers / Sellers / All toggle.
- **Every column sortable** via the project-standard `useSortable` +
  `SortableTh` pattern — including amount bought, amount sold, net,
  buyer count, price.
- **sp500 insider scan: measure first.** Checkpoint-resume the Russell
  scan unconditionally; apply it to the sp500 scan ONLY if you measure
  that scan to be within ~3 minutes of the 15-minute ceiling.
- This scan has **no LLM/token cost** and stays on its daily cadence.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4l@tradeiq.local"
git config user.name "Executor 4l"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # note the baseline count
npm run build                # must complete cleanly

git checkout -b phase-4l-insider-completeness
```

If baseline fails, STOP and report with exact output. Bump APP_VERSION
one patch from whatever it is on `main` (target ~`0.18.7-alpha`).

Read `briefs/phase-4l-brief.md` before writing code.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`. Live verification is post-merge; the deploy has
Finnhub + Firebase configured server-side.

---

# PART 2 — REPO ORIENTATION

## 2.1 What already exists (do NOT rebuild)

- `netlify/functions/shared/scan-insider.ts` — `runInsiderScan` sweeps
  the full universe uncapped when no `scanCap` is passed. Correct.
- `netlify/functions/scan-insider-{sp500,ndx,dow,russell2k}.ts` —
  per-universe scheduled scans, daily `30 21 * * 1-5`. sp500/ndx/dow
  complete fine; russell2k does not.
- `netlify/functions/insider-board.ts` — the read endpoint. The
  single-index path uses snapshots; the `all` path does NOT (the bug).
- `netlify/functions/shared/snapshot-store.ts` — `latestSnapshot`,
  `isSnapshotFresh`, `filterRowsToWindow`. Insider snapshots live at
  `boardSnapshots/insider/_latest/{universe}`.
- `netlify/functions/shared/scan-resume/{cursor,watchdog,reinvoke}.ts`
  (Phase 4h) — reuse VERBATIM for W2.
- `src/InsiderBoardView.jsx` — the UI.
- The `useSortable` hook + `SortableTh` component — the project's
  standard sortable-table pattern; every TradeIQ data table uses it.
  Find an existing board view that uses them and copy the pattern.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/insider-board.ts` — W1 (`all` aggregation)
- `netlify/functions/scan-insider-russell2k.ts` + a new
  `scan-insider-russell2k-background.ts` — W2
- `netlify/functions/scan-insider-sp500.ts` (+ background) — W2, ONLY
  if measurement shows it's near the ceiling
- `netlify/functions/shared/scan-insider.ts` — if the scan worker needs
  to expose batch progress for the cursor
- `netlify/functions/shared/types.ts` — if `InsiderBoardRow` needs a
  `price` field added
- `src/InsiderBoardView.jsx` — W3 (default-to-buyers, toggle, sortable)
- test files for all of the above
- `briefs/phase-4l-pr-description.md` + `reports/phase-4l/verification.md`
- `src/App.jsx` — APP_VERSION bump
- `ORCHESTRATOR.md` — mark 4l done at the end

## 2.3 Files you may NOT touch

- `shared/scan-resume/*` — reuse as-is, do not modify
- The target-board scan functions, backtest code, analyst/scoring code,
  the Williams/Lynch styles
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (W1 → W2 → W3)

## W1 — `index=all` aggregates per-universe snapshots

Rework the `all` path in `insider-board.ts`:

1. Read the four `insider` snapshots — `latestSnapshot('insider', u)`
   for `sp500`, `ndx`, `dow`, `russell2k`.
2. Union their rows; **de-duplicate by ticker** (the indices overlap —
   the Dow is a subset of the S&P 500, the Nasdaq 100 overlaps it
   heavily; the same ticker will appear in 2–4 snapshots). On a
   collision keep one row; if snapshots differ in freshness, prefer the
   freshest contributing snapshot's row.
3. Re-aggregate to the requested window via `filterRowsToWindow`
   (snapshots are stored at the 180-day window).
4. Sort, trim to `limit`.
5. Return `source: 'snapshot-aggregate'`, `generatedAt` = the OLDEST
   contributing snapshot's timestamp, `stale: true` if any contributor
   is past its freshness budget.
6. **Graceful partial:** if a universe's snapshot is missing/stale,
   still return the union of the others, flagged — never empty, never
   the 80-cap live scan. (`force=1` may keep a capped live scan as a
   debug escape hatch; the default `all` view is snapshot-aggregate.)

## W2 — Checkpoint-resume the Russell insider scan

Apply Phase 4h's pattern to `scan-insider-russell2k.ts`:

- Reuse `shared/scan-resume/{cursor,watchdog,reinvoke}.ts` verbatim.
- Split into a thin scheduled trigger + a `-background.ts` worker that
  batches the universe, checkpoints a cursor, and self-reinvokes via
  `Context.waitUntil` until the sweep completes.
- Partial results in a subcollection
  (`insiderScanRuns/{runId}/partial/...`), NOT on the cursor doc —
  stay clear of Firestore's 1 MiB ceiling.
- Terminal batch assembles the full row set, `writeSnapshot` once,
  advances `_latest` only on terminal success (atomic swap).
- Keep the daily cadence (`30 21 * * 1-5`).
- **sp500:** first measure the sp500 insider scan's runtime (instrument
  it, or reason from universe size × per-ticker Finnhub latency). Apply
  the same checkpoint-resume to sp500 ONLY if it's within ~3 min of the
  15-min ceiling. Document the measurement in the verification report.

## W3 — Insider board UI

In `src/InsiderBoardView.jsx`:

- **Default view: net buyers** (net buy dollars > 0), sorted by net buy
  dollars descending.
- **Buyers / Sellers / All toggle** — Sellers shows net sellers by sell
  dollars; All shows everything.
- **Every column sortable** via `useSortable` + `SortableTh` (copy the
  pattern from an existing board view). Sortable columns at minimum:
  ticker, amount bought ($), amount sold ($), net ($), buyer count,
  price. If `InsiderBoardRow` lacks a `price` field, add it (sourced
  the same way other boards get `price`).
- If the insider table isn't already on the `useSortable`/`SortableTh`
  standard, move it onto that pattern — it's a project coding rule.

---

# PART 4 — TESTS

- W1: `all` aggregation unions + dedups correctly; graceful partial
  when one snapshot is absent; `generatedAt`/`stale` reflect the
  stalest contributor.
- W2: Russell scan cursor advance + resume; terminal-only snapshot
  publish (a partial scan does not advance `_latest`).
- W3: default filter is net buyers; toggle switches the set; column
  sort + reverse works.
- Don't network in unit tests — mock Finnhub + Firestore.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + verification report.
- APP_VERSION bumped one patch in `src/App.jsx`. MODEL_VERSION
  unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Match the house style of `target-board.ts` / the 4h scan functions.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4l-insider-completeness
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4l - insider board completeness",
    "head": "phase-4l-insider-completeness",
    "base": "main",
    "body": "See briefs/phase-4l-brief.md and reports/phase-4l/verification.md. index=all now aggregates the four per-universe snapshots (dedup, re-window) instead of an 80-ticker capped live scan; russell2k insider scan gets checkpoint-resume; insider board UI defaults to net buyers with sortable columns + Buyers/Sellers/All toggle."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** (A prior phase was
opened as a draft and the merge silently failed on it.) If your tooling
defaults to draft, immediately mark it ready.

Live verification is post-merge by the orchestrator: fire the Russell
insider scan, confirm it completes, probe `/api/insider-board?index=all`
for `snapshot-aggregate` + full coverage + sub-2-second latency, and
check the UI defaults + sortability.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: index=all aggregates the 4 per-universe snapshots (dedup, re-window)
- W2: russell2k insider scan -> checkpoint-resume; sp500 measured at <Xmin>
      -> [checkpoint-resumed too | left as-is]
- W3: insider board defaults to net buyers; Buyers/Sellers/All toggle;
      all columns sortable via useSortable/SortableTh

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Acceptance: DEFERRED to post-merge (orchestrator fires the scan + probes)

Known limitations:
- <anything worth flagging>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Leaving the 80-cap live scan as the `all` default.** The default
  `all` view must be snapshot-aggregate.
- **Not de-duplicating tickers** across the overlapping indices.
- **Russell cursor/partial payload hitting the 1 MiB ceiling** — partial
  rows go to a subcollection.
- **Publishing a partial Russell scan** — `_latest` advances only on
  the terminal batch.
- **Skipping the sp500 measurement** — measure it; don't guess.
- **Building a non-standard sortable table** — use `useSortable` +
  `SortableTh`, the project standard.
- **Networking in unit tests.**
- **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

4h merged (`c3f822b`) — supplies `shared/scan-resume/`. 4j may be
running in another conversation (detail-panel work — `ticker-reference`,
`PriceChart`, `TargetBoardView.jsx`); your only possible overlap is
`shared/types.ts` if both add a field — keep your change minimal and
additive. The 4h russell2k target scan may be running server-side —
unrelated. No hard conflicts expected.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4l of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4l-executor.md — that's your full assignment —
   then read briefs/phase-4l-brief.md for the rationale and architecture.

Everything you need is in those two files: the two defects, the three
workstreams (index=all snapshot aggregation, russell2k scan
checkpoint-resume, insider board UI defaulting to net buyers with
sortable columns), Chad's settled decisions, the test plan, and the
failure modes. Open the PR ready-for-review, not as a draft. Start with
PART 1 once you've read both end-to-end. ~2-3 hour session.
