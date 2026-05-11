# Production Hotfix Brief — Seed Snapshots (All Boards in Fallback)

User reports "Earnings tab is not working at all." Live diagnosis shows the issue is broader: **all 7 board snapshots are null in production**. Every board is serving from `fallback-partial` synchronous scans. Earnings stands out because its fallback (Finnhub calendar + per-ticker bars + history) frequently exceeds the 26s function timeout and returns 0 setups; other boards return small partial counts that mask the same root cause.

Phase 1 introduced scheduled functions that populate `boardSnapshots/{board}/runs/{runId}` in Firestore. The cron schedules in `netlify.toml` look correct. Either the crons aren't firing, or they're firing but throwing on first invocation. Your job is to find out which, fix what surfaces, and confirm all boards flip from `fallback-partial` to `snapshot` source.

This is a production hotfix, not a phase. No new code unless investigation reveals a bug. ~30-45 min.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Currently live.** `0.13.1-alpha` (hotfix #1 merged) or `0.13.2-alpha` (if hotfix #2 also merged — check)
**Scheduled function files.** `netlify/functions/scheduled/scan-{target-board,prophet,williams,catalyst,insider,lynch,earnings}.ts`
**netlify.toml schedules.** All 7 boards configured (every 30 min market hours for intraday boards; once or twice daily for insider/lynch/earnings)

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

You'll need to pull `FIREBASE_SERVICE_ACCOUNT` from Netlify env to query Firestore directly. Same pattern as previous smoke-test briefs.

---

## Required tools

`bash_tool`, `view`, plus whatever's needed to invoke Netlify functions and query Firestore.

---

## Workstreams

### W0 — Confirm symptom + measure current state

```bash
# Health endpoint snapshot map
curl -sS https://tradeiq-alpha.netlify.app/api/health | python3 -m json.tool > /tmp/health.json
python3 -c "
import json
d = json.load(open('/tmp/health.json'))
print('boards with ANY non-null snapshot:', sum(1 for b, s in d['snapshots'].items() if any(v for v in s.values())))
for b, s in d['snapshots'].items():
    fresh = {k: v for k, v in s.items() if v is not None}
    print(f'  {b}: {len(fresh)} fresh ({list(fresh.keys()) or \"none\"})')"
```

Expected at brief start: 0 of 7 boards have any non-null snapshot.

### W1 — Pull env + check Firestore for existing snapshot docs

Pull env vars from Netlify (same pattern as the smoke-test brief):

```bash
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
TEAM_SLUG=davisdelivery

curl -sS -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/accounts/${TEAM_SLUG}/env?site_id=${SITE_ID}" \
  -o /tmp/netlify-env.json

python3 <<'EOF'
import json
data = json.load(open('/tmp/netlify-env.json'))
keys = ['FIREBASE_SERVICE_ACCOUNT']
out = []
for k in keys:
    for v in data:
        if v['key'] == k:
            vals = v.get('values', [])
            val = next((x['value'] for x in vals if x.get('context') in ('all','production') and x.get('value')), None)
            if val:
                escaped = val.replace("'", "'\\''")
                out.append(f"export {k}='{escaped}'")
open('/tmp/env-export.sh', 'w').write('\n'.join(out) + '\n')
EOF
source /tmp/env-export.sh
rm /tmp/env-export.sh /tmp/netlify-env.json
[ -n "$FIREBASE_SERVICE_ACCOUNT" ] && echo "FIREBASE_SERVICE_ACCOUNT: set" || echo "MISSING — STOP"
```

Now query Firestore directly to see if ANY snapshot docs exist:

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq && npm ci --silent

cat > /tmp/check-snapshots.mjs <<'EOF'
import admin from 'firebase-admin';
const sa = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(sa), projectId: sa.project_id });
const db = admin.firestore();

const boards = ['target-board','prophet','williams','catalyst','insider','lynch','earnings'];
for (const board of boards) {
  const runs = await db.collection('boardSnapshots').doc(board).collection('runs').orderBy('generatedAt', 'desc').limit(3).get();
  console.log(`\n${board}: ${runs.size} runs found`);
  runs.forEach(d => {
    const data = d.data();
    console.log(`  id=${d.id} universe=${data.universe} generatedAt=${data.generatedAt} resultCount=${data.results?.length ?? data.setups?.length ?? '?'}`);
  });
}
process.exit(0);
EOF
node /tmp/check-snapshots.mjs
rm /tmp/check-snapshots.mjs
```

Two possible outcomes:

**Outcome A: Some/all boards have run docs.** Scheduled functions ARE running but the snapshot reader (live endpoint's "is snapshot fresh enough?" check) is returning null for some reason. Skip to W3 — diagnose the reader. Skip W2.

**Outcome B: No board has any run docs.** Scheduled functions have NEVER successfully written. Proceed to W2 — manually trigger one and see what happens.

### W2 — Manually trigger a scheduled function (most likely path)

Netlify scheduled functions can be invoked via direct POST to the function URL. They check for the `Netlify-Schedule` header in production but the function code itself doesn't enforce that (it just runs).

Try invoking `scan-earnings` first since that's the user-facing complaint:

```bash
# Get the function URL
SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
echo "Function path: https://tradeiq-alpha.netlify.app/.netlify/functions/scheduled/scan-earnings"

# Invoke it. Background timeout is 15 min; do NOT add a small timeout flag.
# Use --max-time 900 to allow the full background timeout.
timeout 900 curl -sS -X POST -w "\nHTTP %{http_code} time %{time_total}s\n" \
  "https://tradeiq-alpha.netlify.app/.netlify/functions/scheduled/scan-earnings" 2>&1 | tee /tmp/trigger-earnings.log | tail -30
```

If the function returns 200 with a reasonable body, it ran successfully. Confirm by re-checking health:

```bash
curl -sS https://tradeiq-alpha.netlify.app/api/health | python3 -c "
import json, sys
d = json.load(sys.stdin)
e = d['snapshots'].get('earnings', {})
print('earnings snapshots:', e)"
```

If `earnings` now shows non-null timestamps, manual trigger works. Repeat for the other 6 boards:

```bash
for board in target-board prophet williams catalyst insider lynch; do
  echo "=== Triggering scan-${board} ==="
  timeout 900 curl -sS -X POST -w "HTTP %{http_code} %{time_total}s\n" \
    "https://tradeiq-alpha.netlify.app/.netlify/functions/scheduled/scan-${board}" 2>&1 | tail -3
  sleep 5   # don't hammer Polygon/Finnhub all at once
done
```

If invocations return:
- **200 with snapshot count in body:** function works. Proceed to W4.
- **404:** the URL pattern is wrong. Netlify may not expose scheduled functions on the same URL pattern as regular functions. Skip to W5 (alternate trigger via Netlify CLI).
- **500:** the function throws. Capture the response body and STOP — that's the real bug, not a missing trigger.
- **Empty body / hanging:** function may be running long. Wait the full 15 min.

### W3 — If snapshots exist but health shows null (Outcome A from W1)

Snapshots are being written but the live reader isn't finding them. Investigate `netlify/functions/health.ts` and `netlify/functions/shared/snapshot-store.ts` — specifically the function that determines "freshness."

```bash
grep -n "snapshot\|fresh\|generatedAt" netlify/functions/health.ts | head -10
grep -n "freshness\|isFresh\|ageMs\|stale" netlify/functions/shared/snapshot-store.ts | head -10
```

The likely culprit: a freshness budget that's too tight, comparing `generatedAt` against `Date.now()` with a window that fails for snapshots older than X minutes. If the most recent snapshot is from this morning but the budget is "within last 30 min," health will report null even though data exists.

Document the finding. If it's a bug, write up the proposed fix and STOP — don't patch without surfacing to user.

### W4 — Verify the user-facing fix

Re-hit each board endpoint and confirm `source` flipped from `fallback-partial` to `snapshot`:

```bash
for board in target-board prophet-picks catalyst-board insider-board williams-board lynch-board earnings-board; do
  curl -sS -o /tmp/b.json "https://tradeiq-alpha.netlify.app/api/${board}?universe=sp500"
  python3 -c "
import json
d = json.load(open('/tmp/b.json'))
count = len(d.get('setups', d.get('targets', d.get('picks', d.get('results', [])))))
print(f'${board}: source=\"{d.get(\"source\",\"?\")}\" count={count}')
"
done
```

Success: all 7 boards show `source: snapshot` with non-trivial counts.

If earnings specifically returns more than a handful of setups (50+), the user's complaint is resolved.

### W5 — Alternate trigger paths (if W2 URL approach fails)

If direct POST 404s, the scheduled function URL pattern is different. Try:

```bash
# Try without /scheduled/ prefix in path
curl -sS -X POST "https://tradeiq-alpha.netlify.app/.netlify/functions/scan-earnings"

# Or via Netlify API function invocation endpoint
SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
curl -sS -X POST -H "Authorization: Bearer $NETLIFY_TOKEN" \
  "https://api.netlify.com/api/v1/sites/${SITE_ID}/functions/scheduled%2Fscan-earnings/invoke"
```

If none work programmatically, surface to user with a one-step manual instruction:

> Netlify dashboard → tradeiq-alpha site → Functions → `scheduled/scan-earnings` → "Run" button (top right). Repeat for each scheduled function.

User can do that from a phone in ~2 minutes.

### W6 — If a function throws on invocation (real bug)

If W2 returned 500 or the function logged an error mid-run, that's the bug behind months of null snapshots. Capture the error message + stack trace from the response body or via Sentry (this would have fired a Sentry alert long ago — check Sentry for any `scheduled_scan_failed`-style issues).

Likely candidates:
- `FIREBASE_SERVICE_ACCOUNT` invalid or expired (you already verified it parses + has a valid key)
- Firestore write throwing on undefined fields (same class of bug as the hotfix you just landed — pit-cache.ts hotfix should have covered this via `ignoreUndefinedProperties: true`, but if firebase-admin isn't initialized that way universally, scheduled scans might still throw)
- A schema check on a provider response failing

Document the finding. Don't patch — surface and write up as the next hotfix brief.

---

## Out of scope

- Phase 4b UI.
- Phase 5 ML.
- Investigating the cron config (Netlify owns that). If manual invocation works, schedules will eventually catch up on their own.
- Fixing any non-snapshot bugs surfaced.

---

## Wipe secrets

```bash
unset FIREBASE_SERVICE_ACCOUNT
rm -f /tmp/check-snapshots.mjs /tmp/env-export.sh /tmp/netlify-env.json /tmp/trigger-earnings.log
```

---

## Report back

```
PRODUCTION HOTFIX — SEED SNAPSHOTS

Symptom confirmed: <0 of 7 boards have snapshots / N boards already had data>

W1 Firestore inspection:
  target-board: <N runs / 0>
  prophet: <N runs / 0>
  williams: <N runs / 0>
  catalyst: <N runs / 0>
  insider: <N runs / 0>
  lynch: <N runs / 0>
  earnings: <N runs / 0>

Outcome path: <A — reader bug / B — never ran / mixed>

W2 manual trigger results:
  scan-target-board: <HTTP X, snapshot count>
  scan-prophet: <...>
  scan-williams: <...>
  scan-catalyst: <...>
  scan-insider: <...>
  scan-lynch: <...>
  scan-earnings: <...>

W4 post-fix board status:
  target-board: source=<X> count=<Y>
  prophet-picks: source=<X> count=<Y>
  catalyst-board: source=<X> count=<Y>
  insider-board: source=<X> count=<Y>
  williams-board: source=<X> count=<Y>
  lynch-board: source=<X> count=<Y>
  earnings-board: source=<X> count=<Y>

USER-FACING FIX VERDICT
  Earnings tab now shows: <N setups, source=snapshot / still 0 / blocked on bug>

ROOT CAUSE
  <Triggers were never invoked / Cron not enabled / Function throws / Reader bug>

REMAINING ACTION
  <None — schedules will pick up from here / Hand brief for code fix / User must enable cron via UI>
```

Wipe secrets, report.

---

## First actions

```bash
# 1. Confirm symptom + check Firestore state
curl -sS https://tradeiq-alpha.netlify.app/api/health -o /tmp/health.json
python3 -c "
import json
d = json.load(open('/tmp/health.json'))
b = sum(1 for board, snaps in d['snapshots'].items() if any(v for v in snaps.values()))
print(f'boards with snapshots: {b}/7')"

# 2. Pull env vars (see W1)
# 3. Query Firestore directly (see W1)
# 4. Outcome A → W3 (reader bug investigation)
# 5. Outcome B → W2 (manual trigger)
```

Then W2 → W4 → report. If anything 500s, document and surface — don't patch.

---

End of brief.
