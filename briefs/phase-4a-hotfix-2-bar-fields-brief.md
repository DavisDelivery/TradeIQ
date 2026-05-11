# Phase 4a Hotfix #2 — ML-Row Price Lookup Bug

The previous Phase 4a hotfix (#8, v0.13.1-alpha) confirmed the engine produces honest numbers — but the smoke-test report flagged a second engine bug:

ML training rows have `entryPrice: null` and all forward-return horizons (`forward5d`, `forward20d`, `forward60d`, `forward252d`) `null`. 206 rows written, every one missing the price + return fields that Phase 5 needs for ML training.

Root cause diagnosed in the smoke-test report:

> `lastCloseAtOrBefore` reads `bars[i].date` but the Polygon Bar shape uses `t` (Unix ms). The fallback `typeof bars[i].t === 'number'` path should hit, but if not, every row returns null.

The fallback path apparently doesn't hit either, because the helper also reads `bars[i].close` (doesn't exist — it's `bars[i].c`). So every call returns `null`. Every ML row has null prices. IC ends up 0.000 because Spearman over an all-null forward-return series has no signal.

This hotfix replaces the helper with the canonical implementation that uses the actual Bar shape, audits the rest of the backtest module for sibling instances, adds a unit test, and re-runs the smoke test on warm cache to confirm ML rows populate.

Target version: `0.13.2-alpha`. ~30 min agent time.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Branch.** `phase-4a-hotfix-bar-fields` (new from main, after PR #8 merges)
**Currently live.** `0.13.1-alpha` (assumed merged — confirm in W0)
**Target version.** `0.13.2-alpha`

---

## Credentials

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
```

For the W5 re-run, pull env vars from Netlify same way the previous smoke-test briefs did.

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
```

---

## Workstreams

### W0 — Precondition

PR #8 must be merged. Check:

```bash
grep "APP_VERSION = '0.13.1-alpha'" src/App.jsx
```

Should hit. If it's still `0.13.0-alpha`, PR #8 hasn't merged yet — STOP and surface.

Branch off main once confirmed:

```bash
git checkout -b phase-4a-hotfix-bar-fields
npm ci --silent
```

### W1 — Fix `lastCloseAtOrBefore`

**File.** `netlify/functions/shared/backtest/engine.ts` (helper location — grep to confirm).

```bash
grep -n "lastCloseAtOrBefore\|function lastCloseAtOrBefore" netlify/functions/shared/backtest/*.ts
```

Read the current implementation. It probably looks like:

```ts
function lastCloseAtOrBefore(bars: Bar[], date: string): number | null {
  for (let i = bars.length - 1; i >= 0; i--) {
    if ((bars[i] as unknown as { date?: string }).date && (bars[i] as any).date <= date) {
      return (bars[i] as any).close;
    }
    if (typeof bars[i].t === 'number' && new Date(bars[i].t).toISOString().slice(0, 10) <= date) {
      return (bars[i] as any).close;   // wrong — should be .c
    }
  }
  return null;
}
```

Replace with the canonical implementation that uses the actual `Bar` shape (Polygon daily aggregates: `{ o, h, l, c, v, t }` where `t` is Unix ms at market open):

```ts
/**
 * Return the close price of the most recent bar whose trading day is on or before `date`.
 * Bars are Polygon daily aggregates: { o, h, l, c, v, t } where t = Unix ms at market open
 * and c = close price. Bars are assumed sorted ascending by t.
 */
export function lastCloseAtOrBefore(bars: Bar[], date: string): number | null {
  if (!bars || bars.length === 0) return null;
  for (let i = bars.length - 1; i >= 0; i--) {
    const bar = bars[i];
    if (typeof bar.t !== 'number' || typeof bar.c !== 'number') continue;
    const barDate = new Date(bar.t).toISOString().slice(0, 10);
    if (barDate <= date) return bar.c;
  }
  return null;
}
```

If `lastCloseAtOrBefore` isn't exported but used internally, leave it un-exported. The test in W3 can import it via a re-export or test it indirectly through `runBacktest`.

Commit: `phase-4a-hotfix-2(bars): fix lastCloseAtOrBefore to use Bar.t and Bar.c`

### W2 — Audit for sibling bugs

Run a focused grep for any other place in the backtest module that reads `.date` or `.close` on a Bar:

```bash
grep -rn "bar\.\|bars\[" netlify/functions/shared/backtest/ | grep -E "\.date|\.close" | grep -v "__tests__\|\.test\."
```

Any hit that's accessing a non-existent field on a Bar is a sibling bug. Patterns to look for:
- `bars[i].close` → should be `bars[i].c`
- `bars[i].date` → should be derived from `bars[i].t`
- `bar.open / bar.high / bar.low / bar.volume` → should be `bar.o / bar.h / bar.l / bar.v`
- `bar.timestamp` → should be `bar.t`

Fix each in place. If the same incorrect pattern appears in 3+ places, consider introducing a small helper:

```ts
function barDate(bar: Bar): string {
  return new Date(bar.t).toISOString().slice(0, 10);
}
```

And refactor call sites to use it. Don't refactor for refactor's sake — only if there are 3+ hits.

Commit: `phase-4a-hotfix-2(bars): audit + fix sibling Bar field access (.close → .c, .date → derived from .t)`

### W3 — Unit test for the helper

**File.** `netlify/functions/shared/backtest/__tests__/last-close-at-or-before.test.ts` (new, or add to existing helper test file).

```ts
import { describe, it, expect } from 'vitest';
import { lastCloseAtOrBefore } from '../engine';
import type { Bar } from '../../data-provider';   // adjust import path if needed

function bar(date: string, close: number): Bar {
  return {
    t: new Date(date + 'T14:30:00Z').getTime(),   // 9:30 AM ET market open
    o: close, h: close, l: close, c: close, v: 1_000_000,
  } as Bar;
}

describe('lastCloseAtOrBefore', () => {
  const bars: Bar[] = [
    bar('2024-01-02', 100),
    bar('2024-01-03', 102),
    bar('2024-01-04', 105),
    bar('2024-01-05', 103),
    bar('2024-01-08', 107),   // Monday after weekend
  ];

  it('returns null for empty bars', () => {
    expect(lastCloseAtOrBefore([], '2024-01-05')).toBeNull();
  });

  it('returns null for date before all bars', () => {
    expect(lastCloseAtOrBefore(bars, '2023-12-31')).toBeNull();
  });

  it('returns latest close for date after all bars', () => {
    expect(lastCloseAtOrBefore(bars, '2024-01-15')).toBe(107);
  });

  it('returns exact-day close when date matches a trading day', () => {
    expect(lastCloseAtOrBefore(bars, '2024-01-03')).toBe(102);
  });

  it('returns most recent prior close when date falls on a non-trading day', () => {
    // 2024-01-06 = Saturday; should return Friday Jan 5 close
    expect(lastCloseAtOrBefore(bars, '2024-01-06')).toBe(103);
    // 2024-01-07 = Sunday; same
    expect(lastCloseAtOrBefore(bars, '2024-01-07')).toBe(103);
  });

  it('skips bars with malformed timestamps', () => {
    const dirty: Bar[] = [
      ...bars,
      { t: NaN as unknown as number, o: 0, h: 0, l: 0, c: 999, v: 0 } as Bar,
    ];
    // Last valid bar still wins
    expect(lastCloseAtOrBefore(dirty, '2024-01-15')).toBe(107);
  });
});
```

If `lastCloseAtOrBefore` isn't currently exported, export it for testability. Internal-export-for-test is a fine pattern.

Commit: `phase-4a-hotfix-2(tests): unit tests for lastCloseAtOrBefore`

### W4 — Version bump + PR

```bash
# Edit src/App.jsx — bump APP_VERSION to '0.13.2-alpha'
git add src/App.jsx
git commit -m "phase-4a-hotfix-2(version): bump 0.13.2-alpha"

# Verify suite passes
npx tsc --noEmit
npm test 2>&1 | tail -10                  # 281 + new tests, all green
npm run build 2>&1 | tail -3

git push origin phase-4a-hotfix-bar-fields

# Open PR
curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d "$(jq -n \
    --arg title 'Phase 4a hotfix #2: Bar field-name bug in lastCloseAtOrBefore (v0.13.2-alpha)' \
    --arg head 'phase-4a-hotfix-bar-fields' \
    --arg base 'main' \
    --arg body 'Phase 4a smoke test (#8) confirmed the engine produces honest numbers but flagged ML rows had entryPrice null + all forward returns null. Root cause: lastCloseAtOrBefore reads bars[i].date (does not exist on Bar) and bars[i].close (should be bars[i].c — Polygon shape is { o, h, l, c, v, t }). Every call returned null, every ML row missed prices, IC computed over an empty series returned 0.000.\n\nFix: replace helper with canonical implementation using actual Bar shape (t for date, c for close). Audited backtest module for sibling .close/.date accesses. Added unit tests covering empty input, before/after range, exact match, weekend rollback, and malformed timestamps.\n\nPhase 5 ML training data was unusable before this fix because forward returns were null on every training row.' \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

Capture PR number.

### W5 — Re-run smoke test (verify ML rows populate)

Don't wait for PR #9 to merge — run against the branch.

Same procedure as previous smoke tests. Pull env vars from Netlify:

```bash
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
TEAM_SLUG=davisdelivery

curl -sS -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/accounts/${TEAM_SLUG}/env?site_id=${SITE_ID}" \
  -o /tmp/netlify-env.json

# ... extract vars to /tmp/env-export.sh, source, verify all 6 set ...
```

Run the same Dow 2018-2024 monthly top-20 config. Should complete in ~3-5 min on the warmed cache from PR #8's run.

```bash
npx tsx scripts/run-backtest.ts --config configs/dow-2018-2024-monthly-top20.json 2>&1 | tee /tmp/hotfix2-run.log
```

### W6 — Verify ML rows populate

Capture the new runId, then query Firestore:

```bash
RUN_ID=$(grep -oE "runId: [a-zA-Z0-9_]+" /tmp/hotfix2-run.log | head -1 | cut -d' ' -f2)
echo "Run ID: $RUN_ID"

cat > /tmp/check-ml-rows.mjs <<EOF
import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();
const runId = '${RUN_ID}';

const ml = await db.collection('backtestRuns').doc(runId).collection('mlTraining').limit(5).get();
console.log('Sample ML rows:');
ml.forEach(doc => {
  const d = doc.data();
  console.log(JSON.stringify({
    ticker: d.ticker,
    asOfDate: d.asOfDate,
    entryPrice: d.entryPrice,
    exitPrice: d.exitPrice,
    forward5dReturn: d.forward5dReturn,
    forward20dReturn: d.forward20dReturn,
    forward60dReturn: d.forward60dReturn,
  }));
});

// Aggregate check
const all = await db.collection('backtestRuns').doc(runId).collection('mlTraining').get();
const withPrices = all.docs.filter(d => d.data().entryPrice !== null).length;
console.log(\`\nTotal ML rows: \${all.size}\`);
console.log(\`Rows with non-null entryPrice: \${withPrices}\`);
console.log(\`Rows with non-null forward20dReturn: \${all.docs.filter(d => d.data().forward20dReturn !== null).length}\`);

// Read the result IC
const doc = await db.collection('backtestRuns').doc(runId).get();
console.log(\`IC: \${doc.data().metrics.ic}\`);

process.exit(0);
EOF
node /tmp/check-ml-rows.mjs
rm /tmp/check-ml-rows.mjs
```

Expected after fix:
- `entryPrice` is a positive number on every sampled row
- `forward20dReturn` is a small decimal (e.g., -0.03 to +0.05) on most rows; null only on rows where the run-end date is within 20 trading days of the last rebalance (acceptable — no future data yet)
- `Rows with non-null entryPrice` ≈ all rows
- `IC` is now a non-zero decimal (probably small, e.g., 0.01-0.08 — IC measures composite vs forward-return correlation; small honest IC is the believability range)

If `entryPrice` is still null, the fix didn't work or there's a deeper bug. Surface.

If `IC` is now > 0.15, that's a leak signature — investigate before celebrating.

### W7 — Wipe + report

Wipe all secret files from the container.

Report back in same format as previous smoke-test brief, with an added section:

```
ML ROW VERIFICATION
- Total ML rows: N
- Rows with non-null entryPrice: N (X%)
- Rows with non-null forward20dReturn: N (X%)
- Sample row: { ticker, asOfDate, entryPrice, forward20dReturn }
- IC (recomputed): X (vs 0.000 before)
```

---

## Out of scope

- Composite scores clustering at 50 / fundamental layer returning 0 — separate scorer issue, file as follow-up.
- Quiver lobbying / patents schema noise — ongoing hygiene, not blocking.
- SA key rotation — user's action.
- Phase 4b UI.

---

## What to do if blocked

- **The helper is structured differently than the brief assumes.** Read the current code, apply the same intent (use `Bar.t` and `Bar.c`, derive date string from `t`). Don't force the brief's exact template if the existing shape disagrees.
- **Sibling audit (W2) finds nothing.** Good — the bug was isolated. Skip W2's commit if there's nothing to fix.
- **Re-run still produces null ML prices.** The fix didn't propagate to the call site. Trace `entryPrice =` in engine.ts and check that the helper's return is being used. Surface to user with the diagnosis.
- **Re-run produces suspiciously high IC** (> 0.15). Don't celebrate. Run the existing W11 integrity tests, then surface — there may be a forward-data leak the previous bug had been masking.

---

## First actions

```bash
# 0. Working tree (precondition: PR #8 merged)
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main

# Precondition gate
grep "APP_VERSION = '0.13.1-alpha'" src/App.jsx || (echo "STOP: PR #8 not merged" && exit 1)

git checkout -b phase-4a-hotfix-bar-fields
npm ci --silent

# 1. Locate the helper
grep -n "lastCloseAtOrBefore" netlify/functions/shared/backtest/*.ts

# 2. View current implementation
# 3. Apply W1 fix
# 4. W2 sibling audit
# 5. W3 unit tests
# 6. W4 PR
# 7. W5 re-run smoke test
# 8. W6 verify ML rows populate
# 9. W7 wipe + report
```

---

End of brief.
