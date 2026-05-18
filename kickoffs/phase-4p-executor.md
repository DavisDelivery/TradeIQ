# Phase 4p Executor Kickoff — Russell 2000 scan terminal-step fix

> **For Chad:** paste the bootstrap block at the end of this file as the
> opening message of a new Claude chat. The GitHub PAT is embedded
> inline; no follow-up needed.

---

You are an executor agent. Your single assignment is **Phase 4p** of
the TradeIQ project. The conversation you are reading is your boot
prompt. Read it end-to-end, then read `briefs/phase-4p-brief.md` in the
repo (full diagnosis + architecture), then start with PART 1.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. Large universes (russell2k ≈ 2,000
tickers) are scanned by a checkpoint-resume pattern: a thin scheduled
trigger fires a background worker that batches the universe,
checkpoints a cursor in Firestore, and self-reinvokes until done, then
writes a snapshot. Owner: Chad Davis. Stack: TypeScript Netlify
functions + React/Vite + Firestore.

## The problem you're fixing (precisely diagnosed — full detail in the brief)

Both russell2k scans — **target-board** and **insider** — are broken,
and Phase 4o's `/api/scan-status` diagnostic pinned the exact cause:

- The scans **successfully walk the entire universe.** The reinvoke
  chain works — the cursor advances through all 2,037 tickers, ~2,022
  get scored, 41 partial batches accumulate. This part is NOT broken.
- The failure is the **terminal step.** Once the cursor reaches the end
  (`nextTickerIndex >= totalTickers`), the worker must assemble the
  partial batches → build the snapshot → `writeSnapshot` →
  `clearScanCursor('done')`. That step never completes. The run freezes
  at `status: running, nextTickerIndex: 2037` permanently. No snapshot
  is published. (One run has been frozen like this since 2026-05-17.)
- Mechanism: the terminal assemble-and-write is crammed into the
  leftover minutes of the last batch-processing invocation and runs out
  of that invocation's 15-minute platform budget before it finishes.
- **One root cause, both boards** — they share the checkpoint-resume
  worker machinery.

## Your assignment in one sentence

Give the terminal step its own dedicated reinvocation with a fresh
15-minute budget, make that step idempotent and size-safe, clean up
stuck runs, and fix the `/api/scan-status` param bug — shipped as one
PR with full tests, fixing BOTH russell2k workers.

## No open decisions

The bug is diagnosed to the exact failing step; the fix shape is
determined. There is nothing to ask Chad. Build it.

---

# PART 1 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -4
git config user.email "executor-4p@tradeiq.local"
git config user.name "Executor 4p"

npm ci
npx tsc --noEmit             # must be clean
npm test                     # note the baseline count
npm run build                # must complete cleanly

git checkout -b phase-4p-scan-terminal-fix
```

If baseline fails, STOP and report with exact output. Bump APP_VERSION
one patch from whatever is on `main` (target ~`0.18.9-alpha`).

Read `briefs/phase-4p-brief.md` before writing code — it has the full
`/api/scan-status` diagnostic evidence and the architecture.

**Secrets:** GitHub PAT (write-scoped) in the clone URL — for `git
push` + `POST /pulls`. Live verification is post-merge.

---

# PART 2 — REPO ORIENTATION

## 2.1 Key existing code

- `netlify/functions/scan-target-board-russell2k-background.ts` — the
  target-board checkpoint-resume worker.
- `netlify/functions/scan-insider-russell2k-background.ts` — the
  insider checkpoint-resume worker. **Both have the bug.**
- `netlify/functions/shared/scan-resume/cursor.ts` — cursor type +
  read/write (`readScanCursor`, `writeScanCursor`, `clearScanCursor`).
  The new `finalizing` phase goes on this cursor.
- `netlify/functions/shared/backtest-resume/{watchdog,reinvoke}.ts` —
  the watchdog + self-reinvoke. **These work — do not rewrite them**;
  W1 calls `reinvoke` one additional time.
- `readAllPartialBatches` / `appendPartialBatch` — partial-batch
  storage (likely in `scan-resume/` or a shared module). The terminal
  step reads via `readAllPartialBatches`.
- `netlify/functions/shared/snapshot-store.ts` — `writeSnapshot`,
  `assessSnapshotPublish` (Phase 4o W3 — correct, leave it).
- `netlify/functions/scan-status.ts` — the diagnostic endpoint; it
  currently IGNORES its `scan` query param and always returns
  target-board russell2k. W3 fixes that.

## 2.2 Files you ARE allowed to touch

- `netlify/functions/scan-target-board-russell2k-background.ts` — W1
- `netlify/functions/scan-insider-russell2k-background.ts` — W1
- `netlify/functions/shared/scan-resume/*` — W1/W2 (cursor `phase`,
  the finalizing handoff — prefer putting shared logic here so one
  change covers both workers)
- the partial-batch module — W2 (idempotent terminal read)
- `netlify/functions/shared/snapshot-store.ts` — W2, ONLY if the
  terminal write needs size-safety (trim/chunk); do not touch
  `assessSnapshotPublish`'s thresholds
- `netlify/functions/scan-status.ts` — W3 (honor the `scan` param)
- the thin scheduled triggers `scan-{target-board,insider}-russell2k.ts`
  — W3, ONLY if stuck-run detection belongs there
- test files for all of the above
- `briefs/phase-4p-pr-description.md` + `reports/phase-4p/verification.md`
- `src/App.jsx` — APP_VERSION bump
- `ORCHESTRATOR.md` — mark 4p done at the end

## 2.3 Files you may NOT touch

- `shared/backtest-resume/{watchdog,reinvoke}.ts` — they work; call
  them, don't modify them
- `assessSnapshotPublish` logic / thresholds (Phase 4o W3 — correct)
- The Finnhub throttle / rate limiter (Phase 4o W1)
- Analyst scoring, the `index=all` aggregation, the single-pass
  sp500/ndx/dow scans, any UI
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`, `netlify.toml`

---

# PART 3 — THE WORK (order W1 → W2 → W3)

## W1 — Dedicated invocation for the terminal step

- Add a cursor phase distinguishing "still walking" from "walk done,
  terminal pending" — e.g. a `phase: 'scanning' | 'finalizing'` field
  (or `status: 'finalizing'`). Put it on the cursor type in
  `scan-resume/cursor.ts`.
- When the batch loop observes `nextTickerIndex >= totalTickers`, it
  does **NOT** run the terminal block inline. It sets the cursor to
  `finalizing` and **reinvokes once more**, then returns.
- The worker entry, on reading a `finalizing` cursor, **skips the batch
  loop entirely** and runs only the terminal step —
  `readAllPartialBatches`, assemble, `assessSnapshotPublish`,
  `writeSnapshot`, `clearScanCursor('done')` — with a fresh full
  15-minute budget.
- Resulting control flow:

```
worker entry:
  if cursor.phase == 'finalizing':
      run terminal step; done.
  else:
      batch loop while nextTickerIndex < totalTickers && !watchdog.expired
      if nextTickerIndex >= totalTickers:
          set cursor.phase = 'finalizing'; reinvoke; return
      else:                              # watchdog expired mid-walk
          reinvoke; return               # unchanged existing behavior
```

- **Apply to BOTH russell2k workers.** If they share a common worker
  helper, make the change there once. If the logic is duplicated, fix
  both files — and prefer factoring the shared piece. A fix that lands
  on only one board leaves the other broken.

## W2 — Make the terminal step robust

- **Idempotency.** A `finalizing` invocation may itself be killed and
  reinvoked. Re-running the terminal step must be safe: re-reading the
  partial batches and re-writing the snapshot for the same `runId` is
  idempotent; `clearScanCursor('done')` runs only at the very end, so a
  re-run simply redoes assemble+write then completes.
- **Snapshot size.** Confirm what the snapshot actually persists — the
  target board displays a top-N (50) but the run scores ~2,022. If the
  snapshot stores all scored rows it risks Firestore's 1 MiB document
  ceiling; the terminal write must trim to the stored-N or chunk.
  Verify and make the write size-safe for both boards.

## W3 — Stuck-run recovery + `/api/scan-status` param fix

- **Stuck-run handling.** Two russell2k runs are frozen `status:
  running` forever. A run that is `running` but whose `updatedAt` is
  stale beyond a sane threshold must be treated as dead — the scheduled
  trigger / watchdog should resume it (re-fire the terminal step —
  W2's idempotency makes this safe) or mark it `failed`. At minimum, a
  stale-`running` run must NOT block the next scheduled scan from
  starting a fresh run.
- **Fix `/api/scan-status`.** It ignores its `scan` query param and
  always returns target-board russell2k. Make it honor `scan` (or
  `board` + `universe`) so the insider scan and every other scan can
  be inspected — this is needed to verify the fix on the insider side.

---

# PART 4 — TESTS

- W1: the `finalizing` phase handoff — reaching the universe end sets
  `finalizing` + reinvokes rather than running the terminal step
  inline; a `finalizing` invocation skips the batch loop and runs the
  terminal step.
- W2: idempotent terminal re-run (same `runId`, re-assemble+re-write is
  safe); size-safe write.
- W3: a stale-`running` run is detected/recoverable; `/api/scan-status`
  honors the `scan` param.
- Don't network in unit tests — mock Firestore.
- Report the real test delta; don't pad.

---

# PART 5 — CONVENTIONS

- One commit per workstream + tests + verification report.
- APP_VERSION bumped one patch in `src/App.jsx`. MODEL_VERSION
  unchanged.
- `strict: true` TypeScript; no `any` without an inline reason.
- Match the house style of the existing scan workers.

---

# PART 6 — PR + ACCEPTANCE

```bash
git push -u origin phase-4p-scan-terminal-fix
```

```bash
curl -sS -X POST \
  -H "Authorization: token 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d '{
    "title": "Phase 4p - russell2k scan terminal-step fix",
    "head": "phase-4p-scan-terminal-fix",
    "base": "main",
    "body": "See briefs/phase-4p-brief.md and reports/phase-4p/verification.md. W1 dedicated terminal-step invocation (finalizing cursor phase, fresh 15-min budget) for BOTH russell2k workers; W2 idempotent + size-safe terminal step; W3 stuck-run recovery + fix the /api/scan-status scan param."
  }'
```

**Open the PR as ready-for-review, NOT a draft.** If your tooling
defaults to draft, immediately mark it ready.

Live verification is post-merge by the orchestrator: fire both
russell2k scans, confirm `status: done` and published snapshots via
`/api/scan-status` and the board endpoints.

---

# PART 7 — HAND-OFF FORMAT

When the PR is mergeable, post one message:

```
PR #N open (ready for review, not draft):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Change summary:
- W1: finalizing cursor phase + dedicated terminal-step reinvocation;
      applied to <both workers / shared helper>
- W2: idempotent terminal re-run; snapshot size handling: <what>
- W3: stuck-run recovery: <how>; /api/scan-status scan param fixed

Verification:
- tsc --noEmit: clean
- npm test: <N> passing (was <baseline>)
- npm run build: clean

Acceptance: DEFERRED to post-merge (orchestrator fires both scans)

Known limitations:
- <anything worth flagging>
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Fixing only one russell2k worker.** Both have the bug — fix both,
  ideally via shared code.
- **Rewriting the reinvoke/watchdog machinery.** It works. W1 just adds
  one more reinvoke and a cursor phase.
- **A non-idempotent terminal step** — a killed-and-retried finalizing
  invocation must re-run cleanly.
- **Ignoring the snapshot-size dimension** — verify the write is safe
  against the 1 MiB ceiling.
- **Leaving stale-`running` runs able to block the next scheduled run.**
- **Networking in unit tests.**
- **Opening the PR as a draft.**

---

# PART 9 — PARALLEL CONTEXT

4h, 4j, 4l, 4o all merged. 4o's W1 Finnhub throttle and W3
degraded-publish guard are correct — don't touch them; 4p is what lets
the throttle's effect finally be observed. The Williams/Lynch phases
(4m/4n) and desktop (4k) are unrelated and not started. No other agent
should be in the scan-worker / scan-resume files while you work — if
you hit an unexpected conflict on `main`, stop and report.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4p of the TradeIQ project at
DavisDelivery/TradeIQ.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4p-executor.md — that's your full assignment —
   then read briefs/phase-4p-brief.md for the diagnosis and architecture.

Everything you need is in those two files: the precisely-diagnosed bug
(both russell2k scans walk the full universe fine but the terminal
assemble+writeSnapshot step never completes — the run freezes at
status:running forever), the three workstreams (dedicated terminal-step
reinvocation via a finalizing cursor phase, applied to BOTH russell2k
workers; idempotent + size-safe terminal step; stuck-run recovery +
fixing the /api/scan-status scan param), the test plan, and the failure
modes. No open decisions — build it. Open the PR ready-for-review, not
as a draft. Start with PART 1 once you've read both end-to-end. ~2-3
hour session.
