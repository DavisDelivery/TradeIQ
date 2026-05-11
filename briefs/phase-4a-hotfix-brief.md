# Phase 4a Hotfix Brief — Cache Write Bug + Missing Happy-Path Test

A previous agent ran the Phase 4a smoke test against the Dow 2018-2024 monthly config. The engine completed cleanly, persisted 1,741 daily-equity points, but produced **zero trades, zero attribution, zero ML rows** — NAV held at $100,000 every trading day for 7 years.

That agent diagnosed the root cause precisely. This brief implements their proposed two-layer fix, adds the missing integrity test that would have caught the bug at PR time, and re-runs the smoke test to confirm honest numbers.

This is a hotfix, not a phase. ~3 small commits. Targets `v0.13.1-alpha`.

---

## Background — the diagnosed bug (don't re-investigate)

1. `pitCacheSet` calls `firestore.collection('pitCache').doc(id).set({ key, value, createdAt })`
2. Firestore Admin SDK rejects `undefined` field values by default — throws `Value for argument "data" is not a valid Firestore document. Cannot use "undefined" as a Firestore value`
3. `getEarningsIntel(ticker, { asOfDate })` returns an object whose optional fields (`daysUntilEarnings`, `epsAcceleration`, `postEarningsDrift`, `streak`, `beatsLast4`, `avgSurpriseMagnitude`) are `undefined` when upstream data is thin
4. The Firestore throw bubbles up through `pitCacheWrap` → `scoreProphetAtDate` → reaches the engine's per-ticker `try { ... } catch { /* swallow */ }`
5. Every ticker drops → empty portfolio every rebalance → no trades, no attribution, no ML rows

Cache evidence corroborated this: `pitCache` where `dataClass='earnings_intel'` had 0 entries despite ~2,500 attempted writes. Other classes (`bars: 3307, fundamentals: 1252, insider: 1817`) were populated normally because their fetchers fill optional fields with `null` instead of `undefined`.

The previous agent's report is the source of truth on this; this brief implements the fix.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Branch.** `phase-4a-hotfix-cache-undef` (new from main)
**Currently live.** `0.13.0-alpha`
**Target version.** `0.13.1-alpha`

---

## Credentials

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
```

For the re-run smoke test (W4), pull env vars from Netlify same way the previous smoke-test brief did.

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`.

---

## Working tree setup

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-4a-hotfix-cache-undef
npm ci --silent
```

---

## Workstreams

### W1 — Firestore admin: ignoreUndefinedProperties

**File.** `netlify/functions/shared/firebase-admin.ts`

Find the `getFirestore()` call (or equivalent — should be near the top, after `initializeApp`). Apply `.settings({ ignoreUndefinedProperties: true })` immediately after the Firestore instance is created.

Pattern (the exact line shape may vary based on the current code — adapt as needed):

```ts
// BEFORE (whatever the current init looks like):
const db = getFirestore(app);

// AFTER:
const db = getFirestore(app);
db.settings({ ignoreUndefinedProperties: true });
```

**Critical:** `db.settings()` can only be called **once** before the first read/write. If the codebase has any path that returns a Firestore instance and immediately uses it, ensure settings are applied at module load time before any caller can read.

If the existing init is wrapped in a singleton (likely — Phase 1's pattern was an `initOnce()` helper), apply settings inside that singleton, after `getFirestore` but before returning.

Verify: pulling the function should not crash. The existing call sites won't need changes — `ignoreUndefinedProperties: true` is permissive (it strips undefined keys on write rather than throwing).

Commit: `phase-4a-hotfix(firebase): ignoreUndefinedProperties on admin Firestore`

### W2 — Engine: replace silent catch with warning collection

**File.** `netlify/functions/shared/backtest/engine.ts`

Find the per-ticker scoring `try { ... } catch { ... }` block inside the main rebalance loop. The current code likely looks like:

```ts
const scored: ScoredCandidate[] = [];
for (const ticker of universeTickers) {
  try {
    const result = await scoreTickerAtDate(ticker, rebalanceDate, board, ctx);
    if (result) scored.push(result);
  } catch {
    // swallow — provider hiccup shouldn't abort the run
  }
}
```

Replace with structured warning collection:

```ts
const scored: ScoredCandidate[] = [];
const failures: TickerFailure[] = [];   // collect per-ticker errors

for (const ticker of universeTickers) {
  try {
    const result = await scoreTickerAtDate(ticker, rebalanceDate, board, ctx);
    if (result) scored.push(result);
  } catch (err) {
    failures.push({
      rebalanceDate,
      ticker,
      message: err instanceof Error ? err.message : String(err),
      stage: 'scoreTickerAtDate',
    });
  }
}

// After the rebalance loop completes, if failures count is high, that's a signal.
// Surface in the result's warnings array — not just dropped on the floor.
if (failures.length > 0) {
  warnings.push({
    code: 'ticker_scoring_failures',
    count: failures.length,
    rebalanceDate,
    sample: failures.slice(0, 5),
  });
  log.warn('ticker_scoring_failures', { rebalanceDate, count: failures.length, sample: failures.slice(0, 3) });
}
```

Add the `TickerFailure` type alongside other engine types (probably `backtest/types.ts`):

```ts
export interface TickerFailure {
  rebalanceDate: string;
  ticker: string;
  message: string;
  stage: string;
}
```

**Threshold check (P0 within this workstream).** Add a sanity check at the end of `runBacktest`: if `>50%` of all ticker-rebalance attempts failed, the run is fundamentally broken and the result should reflect that. Append a top-level warning like:

```ts
const totalAttempts = walkForwardDateCount * meanUniverseSize;
const failureRate = totalFailures / totalAttempts;
if (failureRate > 0.5) {
  result.warnings.push({
    code: 'high_failure_rate',
    message: `${(failureRate * 100).toFixed(1)}% of ticker scoring attempts failed — result is not trustworthy`,
    failureRate,
  });
}
```

The previous smoke test would have surfaced "100% of ticker scoring attempts failed" instead of presenting all-zeros as a clean run.

Commit: `phase-4a-hotfix(engine): replace silent catch with structured failure tracking`

### W3 — Missing happy-path integrity test

**File.** `netlify/functions/shared/backtest/__tests__/walk-forward-integrity.test.ts`

Add a new test to the existing W11 suite:

```ts
it('produces non-trivial output for a sane backtest config', async () => {
  // Mock providers to return realistic scores for every ticker
  vi.mock('../score-at-date', () => ({
    scoreTickerAtDate: vi.fn(async (ticker, asOfDate) => ({
      composite: 60 + Math.random() * 20,   // 60-80 range, comfortably above minComposite
      layers: { fundamental: 65, momentum: 55, technical: 70 },
      metadata: { ticker, asOfDate },
    })),
  }));

  const result = await runBacktest({
    universe: 'dow',
    startDate: '2023-01-01',
    endDate: '2023-06-30',
    rebalanceFrequency: 'monthly',
    board: 'prophet',
    portfolioConfig: { topN: 5, weighting: 'equal', maxPositionPct: 0.25, maxSectorPct: 0.5, cashSleeve: 0.05, minComposite: 50 },
    costs: { slippageBps: { dow: 3, sp500: 5, ndx: 5, russell2k: 20 }, commission: 0 },
  });

  // The whole point of this test: against realistic mocked scores, the engine MUST produce trades.
  expect(result.trades.length).toBeGreaterThan(0);
  expect(result.metrics.rebalances).toBeGreaterThan(0);
  expect(result.dailyEquity[result.dailyEquity.length - 1].value).not.toBe(100_000);
  expect(result.warnings.find(w => w.code === 'high_failure_rate')).toBeUndefined();
});
```

This is the test that would have caught the original bug. The mocked `scoreTickerAtDate` returns clean values that the cache layer never had to write; with the fix in place (or without the bug), trades happen. Without the fix, the test would fail before the smoke test wastes 13 minutes.

Commit: `phase-4a-hotfix(tests): happy-path integrity test (engine produces non-trivial output)`

### W4 — Verify locally, push, open PR

```bash
npm test 2>&1 | tail -10                  # all 279+ tests green, including the new one
npx tsc --noEmit                          # clean
npm run build 2>&1 | tail -3              # clean

# Bump version
# In src/App.jsx, change APP_VERSION to '0.13.1-alpha'

# Commit version bump
git add src/App.jsx
git commit -m "phase-4a-hotfix(version): bump 0.13.1-alpha"

git push origin phase-4a-hotfix-cache-undef
```

Open PR via API:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d "$(jq -n \
    --arg title 'Phase 4a hotfix: cache undef-rejection + silent catch + missing happy-path test (v0.13.1-alpha)' \
    --arg head 'phase-4a-hotfix-cache-undef' \
    --arg base 'main' \
    --arg body 'Phase 4a smoke test produced all-zeros result (NAV held at \$100K for 7 years, 0 trades). Diagnosed: Firestore Admin SDK rejects undefined field values by default; getEarningsIntel returns objects with optional fields that stay undefined; cache write throws; engine catch{} silently drops every ticker.\n\nFix: (1) firebase-admin.ts settings({ ignoreUndefinedProperties: true }) — defense in depth. (2) engine.ts replaces silent catch{} with structured failure tracking + high-failure-rate top-level warning. (3) New W11 happy-path integrity test: against mocked realistic scores, asserts trades.length > 0 — would have caught the bug at PR time.\n\nRe-run smoke test (W5) confirms honest numbers post-fix.' \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

Capture PR number.

### W5 — Re-run the smoke test

After PR opened (and after user merges), the engine should now produce real numbers. Don't wait for merge if you can run against the branch.

Same procedure as the previous smoke-test brief:
1. Pull env vars from Netlify (see the original `briefs/phase-4a-smoke-test-brief.md` for the exact procedure)
2. Run the Dow 2018-2024 monthly top-20 config
3. Capture metrics + runId
4. Apply the sanity-check bands (Sharpe > 2.5 is suspect, win rate > 70% is suspect, etc.)
5. Report metrics block

Expect this run to be much faster than 13 minutes — the previous run primed ~10,000 cache entries already, and your fix should let earnings_intel finally cache too.

**Critical sanity rule:** if the new run produces metrics in the believability range (Sharpe 0.5-1.5, CAGR 8-18%, Max DD 20-35%, win rate 50-60%), report as success. If it still produces all zeros, you have a second bug — the fix didn't work or there's another layer. If it produces Sharpe > 2.5, you have a look-ahead leak that the original cache-write bug had been masking.

Wipe secrets when done.

---

## Out of scope

- Any other engine improvements. Hotfix only.
- Quiver lobbying schema noise (2,318 mismatches caught in the prior run) — separate hygiene issue.
- Quiver patents endpoint 404s — separate issue.
- Phase 4b UI. After 0.13.1-alpha verifies honest, that's the next phase.
- SA key rotation — user's action, not agent's.

---

## What to do if blocked

- **`db.settings()` throws "already initialized."** Means a caller invoked Firestore before the settings call. Move the settings into the singleton init function, before the first return.
- **Tests reveal a deeper bug.** Surface, don't patch. The previous agent's discipline ("brief said don't patch") was correct.
- **Re-run still produces zeros.** Document the warnings field — it'll tell you whether the fix didn't apply or there's a different failure path. Surface immediately.
- **Re-run produces suspiciously good numbers** (Sharpe > 2.5). Don't celebrate. The cache-write bug was masking actual ticker outputs; with the cache working, real scoring runs and may expose a different leak. Run the existing integrity tests first to verify they still pass.

---

## Report back

Format:

```
PHASE 4A HOTFIX — RESULTS

Bug fix landed: yes/no
PR: <number + URL>
Tests: <count green, including new happy-path test>
Tsc + build: <clean / errors>

RE-RUN SMOKE TEST
Run ID: <runId>
Duration: <minutes>

METRICS  (or "still zeros" + warnings if fix didn't work)
  Total return:    X%
  CAGR:            X%
  Sharpe:          X
  Sortino:         X
  Max DD:          -X%
  Win rate:        X%
  IC:              X
  IR:              X
  Trades:          X
  Failures:        X (from new warning collection)

SANITY VERDICT
  <in range / suspicious / still broken>

PRIOR-RUN BUG: confirmed fixed by which evidence
```

Wipe secrets.

---

## First actions

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-4a-hotfix-cache-undef
npm ci --silent

# Inspect existing firebase-admin.ts to see how getFirestore is wired
cat netlify/functions/shared/firebase-admin.ts

# Inspect engine.ts catch block
grep -B2 -A8 "catch" netlify/functions/shared/backtest/engine.ts | head -30
```

Then W1 → W2 → W3 → W4 → W5.

---

End of brief.
