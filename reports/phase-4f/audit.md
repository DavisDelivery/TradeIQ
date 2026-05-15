# Phase 4f — Stub-Analyst Audit

**Verdict:** PENDING LIVE-DATA RUN

**Live source of truth:** `GET /api/audit-stub-analysts?days=30&board=both&universe=both`
(returns JSON with `markdown` field — or `?fmt=md` for text/markdown).
Both the synchronous endpoint and the Sunday-19:00 UTC cron
(`scan-stub-audit-cron.ts`) are shipped in this PR and use Netlify's
production `FIREBASE_SERVICE_ACCOUNT` to read Target + Prophet
snapshots across all 4 quadrants.

**Why PENDING and not populated here:** the executor session that
shipped this PR had no FIREBASE_SERVICE_ACCOUNT (sandbox is locked
down from outbound HTTP and has no SA JSON). The audit endpoint
runs honestly only in production — once this PR merges + Netlify
deploys, the first Sunday cron fires the audit and writes
`stubAudits/runs/{stamp}` with the per-analyst classifications.
Following the precedent set by 4e-1's `backtest-validation.md`:
PENDING is more honest than synthesizing a table from fixture data
that would then drive W3/W5 repairs on imaginary findings.

**Generated:** scaffolding written 2026-05-15. Live audit fires
after merge.

---

## Self-populating path (preferred — added in this PR)

After PR merges and Netlify deploys, the system populates itself:

1. Weekly cron `scan-stub-audit-cron.ts` (Sunday 19:00 UTC) fires
   `GET /api/audit-stub-analysts?days=30&board=both&universe=both`.
2. Endpoint reads recent snapshots for all 4 quadrants and writes
   the per-analyst stats + verdicts to Firestore at
   `stubAudits/runs/{stamp}`.
3. To inspect at any time:
   ```
   curl 'https://tradeiq-alpha.netlify.app/api/audit-stub-analysts?days=30&fmt=md'
   ```
4. To freeze the live audit into this file:
   ```
   curl 'https://tradeiq-alpha.netlify.app/api/audit-stub-analysts?fmt=md' \
     > reports/phase-4f/audit.md
   git add reports/phase-4f/audit.md
   git commit -m "phase-4f: freeze stub audit from /api/audit-stub-analysts"
   ```

Alternatively, with creds locally:

```bash
export FIREBASE_SERVICE_ACCOUNT="$(cat ~/path/to/sa.json)"
npx tsx scripts/audit-stub-analysts.ts --days 90 \
  > reports/phase-4f/audit.md
```

---

## 1. Quadrant tables (POPULATED BY LIVE RUN)

These four sub-sections will be filled in by the live audit. Each
follows the same row format from § 4.1 of the kickoff.

### Target Board × largecap

| Analyst              |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| (pending)            |        — |        — |            — |       — |            — |           — | pending |

### Target Board × russell2k

| Analyst              |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| (pending)            |        — |        — |            — |       — |            — |           — | pending |

### Prophet × largecap

If `reports/phase-4e-1/backtest-validation.md` exists on main, its
§ 0 layer audit table is reference data for this row. Otherwise
populated by the new endpoint.

| Analyst              |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| (pending)            |        — |        — |            — |       — |            — |           — | pending |

### Prophet × russell2k

| Analyst              |     Mean |    StDev | % exactly 50 |  % null | % pass=false | Uniq scores | Verdict |
|----------------------|---------:|---------:|-------------:|--------:|-------------:|------------:|---------|
| (pending)            |        — |        — |            — |       — |            — |           — | pending |

---

## 2. Per-stub root-cause diagnosis (POPULATED BY W2)

For each row classified `stub` (or `degraded` worth investigating)
above, follow the taxonomy in `kickoffs/phase-4f-executor.md` § 4.2
and write a per-stub diagnosis section using the template at § 4.3.

Code inspection done in this PR session (before the live audit
populates the tables above) identified clear `null_default` patterns
at the following call sites — these are the W3 repairs that landed
in `netlify/functions/shared/analyst-runner.ts`:

- **`insider-analyst`** — `runAnalystsForTicker` returned
  `{ score: 50, direction: 'neutral', confidence: 0 }` when
  `insiderActivity` was null. Repaired: now emits
  `signals: { _noData: true, _reason: 'no_data' }` so the composite
  math skips it and the UI badge layer renders `NO DATA`.
- **`patent-analyst`** — same pattern, same repair.
- **`political-analyst`** — when BOTH political and contract
  activity are null, same repair applies. When one of the two
  exists, `runPolitical` continues to compute its real signal.

`macro-regime` and `earnings-analyst` were NOT repaired in this PR.
`macro-regime` is computed from the regime layer (which itself may
be a stub — separate fix) and is structurally pinned near 50 when
regime is `neutral`. `earnings-analyst` runs unconditionally but may
emit 50 when `upcoming + history` are both null; this is a
classification ambiguity (could be threshold_misconfig or
null_default) that the live audit will distinguish.

---

## 3. Final weight table (POPULATED BY W5)

For permanently removed analysts (per W2 `no_upstream` classifications
the live audit produces), the brief specifies redistributing weight
proportionally within the analyst category. Until the audit fires,
no analysts are permanently removed in this PR — only `no-data this
scoring call` exclusions, which are handled transient-per-call by
`composeWeights()` in
`netlify/functions/shared/compose-weights.ts`.

| Analyst              | Old weight | New weight | Status |
|----------------------|-----------:|-----------:|--------|
| (no permanent removals yet) | — | — | — |

---

## 4. Why this PR ships W3+W5 partial without waiting for full audit findings

Two reasons:

1. **The screenshot is data.** Chad's 2026-05-13 Target Board ON
   screenshot showed 5 of 10 analysts emitting exactly 50. That
   alone justifies repairing the LITERAL null-default patterns
   visible in `analyst-runner.ts` source (a code-level certainty,
   not a statistical inference from sampled snapshots).
2. **The math is forward-compatible.** `composeWeights` skips any
   analyst flagged `_noData: true` regardless of which one. When
   the live audit identifies further analysts to permanently
   remove (`no_upstream`), we set their weight to 0 in
   `ANALYST_WEIGHTS` — `composeWeights` already handles that case.
   No re-architecture needed.

The full audit + W3 repairs for `threshold_misconfig` / `latency`
cases are gated on the live data and land in a follow-up.
