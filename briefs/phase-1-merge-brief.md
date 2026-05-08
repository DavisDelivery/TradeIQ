# Phase 1 Merge & Verify Brief

You are the Phase 1 merge agent for TradeIQ. Phase 1 is built on branch `phase-1-universe-coverage` (12 commits ahead of main, head at `aad24f0`). Your job: open the PR, gate on the required Netlify env var being set, merge, verify the deploy, seed the first scheduled snapshot.

This is a small, well-scoped task. Do not modify code on the branch. Do not start any new workstream. Merge, verify, report.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

GitHub PAT has write to the DavisDelivery org (sufficient for opening + merging PRs). Netlify token can read env vars and trigger deploys.

Firebase project for reference (do not create or modify): project ID `tradeiq-alpha`, project number `101124117025`.

---

## Required tools

`bash_tool`, `view`, plus the Netlify deploy/read connectors. No file editing required.

---

## Step 1 — Confirm branch is up-to-date and CI-clean

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git fetch origin
git log origin/phase-1-universe-coverage --oneline -5
git diff origin/main..origin/phase-1-universe-coverage --stat | tail -3
```

Expect: head commit `aad24f0`, ~50 files changed, version bumped to `0.9.1-alpha`. If anything looks off, STOP and surface to user.

Then sanity-build the branch locally:

```bash
git checkout phase-1-universe-coverage
npm ci --silent
npx tsc --noEmit && npm run build 2>&1 | tail -3
```

Expect: typecheck clean, build clean. If either fails, STOP — do not merge a broken branch.

## Step 2 — Open the PR

The branch is pushed but the PR is not open yet. Open it via GitHub API. Body comes from `briefs/phase-1-pr-description.md` on the branch.

```bash
PR_BODY=$(jq -Rs . < briefs/phase-1-pr-description.md)
curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d "$(jq -n \
    --arg title 'Phase 1: Universe coverage + snapshot infrastructure (v0.9.1-alpha)' \
    --arg head 'phase-1-universe-coverage' \
    --arg base 'main' \
    --argjson body "$PR_BODY" \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

Capture the PR number from the response. If a PR already exists for this branch, the API returns 422 — in that case fetch the existing PR number:

```bash
curl -sS \
  -H "Authorization: Bearer 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" \
  "https://api.github.com/repos/DavisDelivery/TradeIQ/pulls?head=DavisDelivery:phase-1-universe-coverage&state=open" \
  | jq '.[0].number'
```

Save the PR number for Step 4.

## Step 3 — GATE: verify FIREBASE_SERVICE_ACCOUNT is set on Netlify

This is the single hard prerequisite. Without this env var, every scheduled function throws on first call and the entire Phase 1 universe-coverage win is dead on arrival.

Use the Netlify MCP connector (`netlify-project-services-reader`, operation `get-project`, params `{ siteId: '8e90d525-78f3-4288-9c15-8b1968e994c1' }`) to read the env var list. Confirm `FIREBASE_SERVICE_ACCOUNT` exists.

If the env var is **NOT set**, STOP and tell the user with this exact message:

> Phase 1 merge is blocked until `FIREBASE_SERVICE_ACCOUNT` is set on Netlify. Without it, every scheduled scan throws and you'll get fallback-partial results forever. Steps:
>
> 1. Firebase Console → tradeiq-alpha project (project number `101124117025`) → Settings → Service accounts → Generate new private key → download the JSON.
> 2. Netlify → tradeiq-alpha site → Site configuration → Environment variables → Add a variable. Key: `FIREBASE_SERVICE_ACCOUNT`. Value: paste the entire JSON (single-line or multi-line both work).
> 3. Reply "set" when done and I'll resume.

Do not merge. Do not proceed.

If the env var IS set, continue.

## Step 4 — Merge the PR

```bash
PR_NUMBER=<from step 2>

curl -sS -X PUT \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls/$PR_NUMBER/merge \
  -d '{"merge_method": "merge", "commit_title": "Phase 1: Universe coverage + snapshot infrastructure (v0.9.1-alpha)"}'
```

Expect 200 with `{"merged": true}`. If 405 (not mergeable), surface the conflict to the user.

## Step 5 — Verify deploy lands at v0.9.1-alpha

Netlify auto-deploys on push to main. Wait 60s, verify version:

```bash
sleep 60
curl -sS https://tradeiq-alpha.netlify.app/ -o /tmp/index.html
BUNDLE=$(grep -oE 'assets/[^"]*\.js' /tmp/index.html | head -1)
curl -sS "https://tradeiq-alpha.netlify.app/$BUNDLE" -o /tmp/b.js
grep -oE "0\.9\.[0-9]+-alpha" /tmp/b.js | head -1
```

Expect: `0.9.1-alpha`. If you see the older version, wait another 30s and retry. If after 3 minutes the version hasn't moved, use the Netlify MCP `get-deploy-for-site` to inspect the most recent deploy and surface its `state` + any `enhancedSecretsScanMatches`.

## Step 6 — Seed the first scheduled snapshot

The scheduled functions won't run on their cron schedule for up to 30 minutes. Trigger one manually so the first board has data immediately and the user can see snapshots flowing.

Use the Netlify functions API to invoke `scheduled/scan-target-board`:

```bash
curl -sS -X POST \
  -H "Authorization: Bearer nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278" \
  "https://api.netlify.com/api/v1/sites/8e90d525-78f3-4288-9c15-8b1968e994c1/functions/scheduled/scan-target-board/invocations"
```

If that endpoint isn't directly invokable (Netlify treats scheduled functions as HTTP-triggerable for testing — depends on plan), try via the UI guidance: tell the user to go to Netlify → tradeiq-alpha site → Functions → `scheduled/scan-target-board` → Run. Either way: don't block on this — log "manual trigger required" and continue.

## Step 7 — Verify snapshot reached Firestore

Wait 2 minutes after triggering. Hit the health endpoint:

```bash
curl -sS https://tradeiq-alpha.netlify.app/api/health | jq '.snapshots'
```

Expect: at least one entry under `target-board.{universe}` showing `{ageMs, generatedAt}` not `null`. If all entries are `null` after 5 minutes, the FIREBASE_SERVICE_ACCOUNT JSON is probably malformed (the env var existed in Step 3 but didn't actually parse). Surface the issue with the URL of the function logs.

## Step 8 — Smoke-check the comprehensive scan worked

```bash
curl -sS "https://tradeiq-alpha.netlify.app/api/target-board?universe=russell2k" | jq '{source, ageMs, modelVersion, count: (.targets // [] | length), tickerSampling: ((.targets // [])[0:5] | map(.ticker))}'
```

Expect: `source: "snapshot"`, count > 80 (the old alphabetical cap), and at least one ticker not starting with A-G. If `source` reads `fallback-partial`, the scheduled scan hasn't completed yet — wait longer.

## Report back

End your turn with a structured status:

- PR number opened/found
- Merge commit SHA
- Live version verified at: 0.9.1-alpha
- Snapshot seeded for boards: <list>
- /api/target-board?universe=russell2k smoke check: <pass/fail with sample tickers>
- Any blockers surfaced to user

If anything failed at Steps 3, 5, 7, or 8, surface clearly to user and stop. Do not paper over deploy or env-var issues.

---

## Out of scope

- Do not modify the branch.
- Do not start Phase 0 reconciliation work.
- Do not edit ORCHESTRATOR.md (orchestrator handles status updates after both phases land).
- Do not touch any other repo.

---

## First actions

```bash
# 1. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git fetch origin
git log origin/phase-1-universe-coverage --oneline -5

# 2. Sanity-build
git checkout phase-1-universe-coverage
npm ci --silent
npx tsc --noEmit && npm run build 2>&1 | tail -3
```

Then proceed Step 2 → Step 3 (gate) → Step 4 → Step 5 → Step 6 → Step 7 → Step 8.

End of brief.
