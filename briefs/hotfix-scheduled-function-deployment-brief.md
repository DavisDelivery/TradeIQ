# Production Hotfix Brief — Scheduled Functions Not Deployed

**Updated with definitive diagnosis from the orchestrator's own investigation. Supersedes the original `seed-snapshots-brief.md`.**

User reported "Earnings tab not working at all." Live diagnosis traced through three layers:

1. **Symptom layer.** All 7 board snapshots null in Firestore. Every board serves `source: fallback-partial`. Earnings stands out because its fallback (Finnhub calendar + bars + history) frequently exceeds the 26s timeout and returns 0 setups.

2. **Cron layer.** Orchestrator tried direct HTTP triggering via the Netlify PAT. Three paths attempted (POST to scheduled function URL, with `Netlify-Schedule` header, via API `/invocations` endpoint). All failed. Triggered a clean redeploy via PAT. Still nothing.

3. **Root cause layer.** Netlify's API reports 16 deployed functions with **all schedules null**. The `scheduled/scan-*` functions live at `netlify/functions/scheduled/scan-{target-board,prophet,williams,catalyst,insider,lynch,earnings}.ts` and **are not in Netlify's deployed function list at all**. They've never deployed since Phase 1.

The `netlify.toml` schedule blocks (`[functions."scheduled/scan-prophet"]`) reference function paths Netlify doesn't recognize because Netlify's default function discovery only scans the flat `netlify/functions/` directory, not subdirectories. The Phase 1 implementation put them in a `scheduled/` subdirectory; Netlify never deployed them.

**The fix is structural.** Move the 7 scheduled function files out of the subdirectory into the flat `netlify/functions/` path, declare schedules in the function files themselves via the `schedule()` wrapper from `@netlify/functions`, clean up the `netlify.toml` schedule blocks.

Target version: `0.13.4-alpha`. ~30-45 min.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** `https://tradeiq-alpha.netlify.app`
**Site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Currently live.** `0.13.3-alpha`
**Target version.** `0.13.4-alpha`

---

## Credentials

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
```

---

## Required tools

`bash_tool`, `view`, `str_replace`, `create_file`.

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
git checkout -b hotfix-scheduled-function-deployment
npm ci --silent
```

---

## Workstreams

### W1 — Move files from `scheduled/` subdirectory to flat path

Move all 7 scheduled function files to `netlify/functions/` flat:

```bash
mkdir -p netlify/functions
cd netlify/functions
for f in scan-target-board scan-prophet scan-williams scan-catalyst scan-insider scan-lynch scan-earnings; do
  if [ -f "scheduled/${f}.ts" ]; then
    git mv "scheduled/${f}.ts" "${f}.ts"
    echo "moved: scheduled/${f}.ts -> ${f}.ts"
  fi
done
# Remove now-empty scheduled directory
rmdir scheduled 2>/dev/null || ls -la scheduled
cd /home/claude/tradeiq
```

If `scheduled/` still has files after the moves, surface them to user — there might be a shared helper or types file in there that needs different handling.

Commit: `hotfix(deploy): move scheduled scan files from scheduled/ to flat netlify/functions/`

### W2 — Add `schedule()` wrapper to each function

Each scheduled function currently looks roughly like:

```ts
import type { Handler } from '@netlify/functions';
// ... imports

export const handler: Handler = async (event) => {
  // ... scan logic
};
```

Replace with the `schedule()` wrapper pattern that Netlify uses to register a function as scheduled:

```ts
import { schedule } from '@netlify/functions';
// ... imports

export const handler = schedule('CRON_EXPRESSION_HERE', async (event) => {
  // ... scan logic
});
```

Schedule expressions per file (from current netlify.toml):

| File | Cron |
|---|---|
| `scan-target-board.ts` | `0,30 13-21 * * 1-5` |
| `scan-prophet.ts` | `0,30 13-21 * * 1-5` |
| `scan-williams.ts` | `0,30 13-21 * * 1-5` |
| `scan-catalyst.ts` | `0,30 13-21 * * 1-5` |
| `scan-insider.ts` | `30 21 * * 1-5` |
| `scan-lynch.ts` | `0 22 * * 1-5` |
| `scan-earnings.ts` | `30 11,21 * * 1-5` |

For each of the 7 files:
1. Replace `import type { Handler } from '@netlify/functions';` with `import { schedule } from '@netlify/functions';`
2. Replace `export const handler: Handler = async (event) => {` with `export const handler = schedule('CRON', async (event) => {`
3. Replace the closing `};` with `});`

The body of each handler stays unchanged. Only the wrapper changes.

If any file currently does `runProphetScan(...)` or similar imports from `../shared/scan-prophet` — those imports stay. Only the export declaration changes.

Commit per file or as one squashed commit:
- `hotfix(scheduled): use schedule() wrapper for scan-target-board`
- (etc. for each of 7) — or one combined commit

### W3 — Clean up netlify.toml

The `[functions."scheduled/scan-*"]` blocks in netlify.toml are now stale (they reference paths that don't exist anymore). The `schedule()` wrapper supersedes them.

```bash
grep -n 'scheduled/scan' netlify.toml
```

Remove or update each of the 7 stale blocks. If the blocks ONLY contained `schedule = "..."` and `timeout = 900`, they can be removed entirely (schedule is now in code, timeout 900 is also configurable in code via `export const config`).

If you want to keep the timeout config:

```toml
[functions."scan-prophet"]
  timeout = 900
```

(Without the `schedule` line, since the wrapper handles it.)

OR (cleaner): add `export const config = { timeout: 900 }` to each function file and remove netlify.toml blocks entirely.

Either path is fine. Pick one for consistency.

Commit: `hotfix(deploy): clean up netlify.toml stale scheduled/scan-* blocks`

### W4 — Verify TypeScript + tests + build

```bash
npx tsc --noEmit
npm test 2>&1 | tail -10
npm run build 2>&1 | tail -3
```

All should be clean. If tests reference the old `scheduled/scan-prophet` path (probably do, since Phase 1 wrote tests), update test imports to point at the new flat path.

```bash
grep -rn "scheduled/scan-" --include="*.test.ts" --include="*.test.js"
```

Update any hits.

Commit: `hotfix(tests): update test imports for moved scheduled functions`

### W5 — Version bump + PR

Bump APP_VERSION to `0.13.4-alpha`. Update ORCHESTRATOR.md:

| Row | What | Where | Version |
|---|---|---|---|
| 4a-fix-5 | Scheduled function deployment fix | this PR | 0.13.4-alpha |

```bash
git push origin hotfix-scheduled-function-deployment

curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d "$(jq -n \
    --arg title 'Hotfix: scheduled function deployment — fix months of all-null snapshots (v0.13.4-alpha)' \
    --arg head 'hotfix-scheduled-function-deployment' \
    --arg base 'main' \
    --arg body 'Diagnosed in orchestrator session: Netlify API reports 0 of 16 deployed functions have schedules registered, and the scheduled/scan-* functions are not in the deployed function list at all. They live at netlify/functions/scheduled/ but Netliflys default function discovery only scans the flat netlify/functions/ directory. The Phase 1 scheduled-function implementation has never deployed.\n\nFix: move 7 scan functions from scheduled/ to flat netlify/functions/, replace Handler import with schedule() wrapper from @netlify/functions, clean up stale netlify.toml schedule blocks. Each function keeps its existing scan logic unchanged.\n\nPost-merge verification: Netlify functions API must report 7 functions with non-null schedule. First cron tick will write the first snapshots; live boards flip from source=fallback-partial to source=snapshot. User-facing fix: Earnings tab populates.' \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

### W6 — Post-merge verification (after user merges)

Wait for user to merge PR. Then verify:

```bash
TOKEN="nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278"
SITE_ID="8e90d525-78f3-4288-9c15-8b1968e994c1"

# 1. Function deployment + schedule registration
curl -sS -H "Authorization: Bearer $TOKEN" \
  "https://api.netlify.com/api/v1/sites/$SITE_ID/functions" \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
funcs = d.get('functions', [])
scheduled = [f for f in funcs if f.get('schedule')]
print(f'Total functions: {len(funcs)}')
print(f'Scheduled functions: {len(scheduled)}')
for f in scheduled:
    print(f\"  {f['n']}: {f['schedule']}\")
"
```

Expected: 7 scheduled functions reported, each with the correct cron expression.

If that succeeds, wait for the next cron tick (next 30-min mark) and re-check health:

```bash
sleep_until_next_30min() {
  local now=$(date -u +%s)
  local next=$(( (now / 1800 + 1) * 1800 + 120 ))   # next 30-min mark + 2 min buffer
  local wait=$(( next - now ))
  echo "sleeping ${wait}s until next snapshot tick..."
  sleep $wait
}
sleep_until_next_30min

curl -sS https://tradeiq-alpha.netlify.app/api/health \
  | python3 -c "
import json, sys
d = json.load(sys.stdin)
print('snapshot state:')
for board, snaps in d['snapshots'].items():
    fresh = {k: v for k, v in snaps.items() if v is not None}
    print(f'  {board}: {len(fresh)} fresh universes')"
```

Expected: at least target-board, prophet, williams, catalyst have fresh snapshots (intraday boards run every 30 min). Earnings runs at 11:30 + 21:30 UTC so won't seed until next twice-daily tick — but the user can immediately verify Earnings by hitting the live endpoint with `?force=1` which triggers a synchronous scan that ALSO writes to the snapshot collection.

### W7 — Wipe + report

Standard.

Report:

```
PRODUCTION HOTFIX — SCHEDULED FUNCTION DEPLOYMENT

W1 file moves:                 7 moved
W2 schedule() wrappers:        7 added
W3 netlify.toml cleanup:       <N blocks removed/updated>
W4 tsc / tests / build:        clean
W5 PR:                         #N
W6 post-deploy verification:
  Functions registered:         <N>/16 with schedule (expect 7)
  Schedules confirmed:          <each function name + cron>
  Snapshot after first tick:    <board: N fresh universes>

USER-FACING FIX VERDICT
  Earnings tab populates: <verified / waiting for next 21:30 UTC tick>
```

---

## Out of scope

- Phase 4b UI.
- Any engine improvements.
- SA key rotation.

---

## What to do if blocked

- **Function file imports break after move.** Relative imports may need updating: `../shared/foo` becomes `./shared/foo`. Check each file.
- **`schedule()` not found in @netlify/functions.** Check `package.json` for `@netlify/functions` version. Old versions don't have it. May need to bump to `^2.0.0` or newer.
- **TypeScript complains about handler type.** The `schedule()` wrapper has its own return type. Don't manually type the handler — let inference work.
- **Netlify API still reports 0 scheduled functions after deploy.** Surface immediately. The fix didn't work and there's a deeper Netlify config issue.
- **First cron tick passes but snapshots still null.** The function ran but threw. Check Sentry or function logs.

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
git checkout -b hotfix-scheduled-function-deployment
npm ci --silent

# Confirm the diagnosis matches what's on disk
ls netlify/functions/scheduled/   # should show 7 scan-*.ts files
head -10 netlify/functions/scheduled/scan-prophet.ts   # should show 'import type { Handler }' pattern
grep '@netlify/functions' package.json   # confirm dep + version
```

Then W1 → W2 → W3 → W4 → W5 → W6 → W7.

---

End of brief.
