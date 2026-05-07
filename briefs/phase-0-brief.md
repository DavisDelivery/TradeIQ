# Phase 0 Agent Brief — TradeIQ Engineering Foundation

You are the Phase 0 agent for TradeIQ. Your job is to land Phase 0 of the orchestrator: tests, CI, spend cap, error tracking, backups, dead-code purge, structured logging. One PR, one version bump, status table updated, done.

You have all credentials embedded below. Do not ask the user for tokens — they are already in this brief.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Live site.** https://tradeiq-alpha.netlify.app
**Netlify site ID.** `8e90d525-78f3-4288-9c15-8b1968e994c1`
**Netlify team ID.** `69c43f638748ee6e940f5f62`
**Currently live.** v0.7.25-alpha (commit `b6c2863`, ORCHESTRATOR.md just landed)
**Stack.** React 18 + Vite frontend, TypeScript Netlify Functions, Tailwind, Firebase Firestore for trade journal sync.
**Owner / single user.** Chad Davis (chad@davisdelivery.com).

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
NETLIFY_TEAM_ID=69c43f638748ee6e940f5f62
```

The GitHub PAT has write access to the DavisDelivery org. Use it in clone URLs as `https://<token>@github.com/DavisDelivery/TradeIQ.git`.

The Netlify token is for setting env vars (Sentry DSN, Anthropic budget cap config) and verifying deploys. Use the Netlify MCP connector for env-var writes; CLI is fine for reads.

API keys already set on Netlify (do not re-create, just reference by env-var name in code):
- `ANTHROPIC_API_KEY` (now powering Opus 4.7 on all AI surfaces)
- `POLYGON_API_KEY`
- `FINNHUB_API_KEY`
- `FRED_API_KEY`
- `QUIVER_API_KEY`

You will create new env vars in this phase:
- `SENTRY_DSN` (after creating Sentry project)
- `ANTHROPIC_DAILY_BUDGET_USD` (default `25`)
- `BACKUP_GITHUB_PAT` (only if doing GitHub-based backups; can reuse the main PAT)

---

## Required tools for this turn

You need: `bash_tool`, `str_replace`, `create_file`, `view`, plus the Netlify deploy/read connectors. Without shell + file edit tools you cannot ship Phase 0. If your environment lacks them, write copy-paste patches to a markdown doc and stop — do not attempt to land partial work.

---

## Read these first (in order)

1. `ORCHESTRATOR.md` — the master plan. Read top to bottom. Phase 0 spec lives there; this brief is the implementation directive.
2. `README.md` — high-level architecture.
3. `SPEC.md` — alpha layer context (relevant to later phases, but useful background).
4. `package.json` — current deps and scripts.
5. `netlify.toml` — function timeouts and routing.
6. `src/App.jsx` first 200 lines — see ErrorBoundary, MOCK constants, view structure.
7. `netlify/functions/shared/data-provider.ts` — the API call patterns you'll be wrapping.
8. List of functions: `ls netlify/functions/` so you know what surfaces exist.

You do not need to read every file before starting. Read each workstream's target files when you get to that workstream.

---

## Phase 0 scope (eight workstreams)

### Workstream 1 — Test harness (Vitest)

**Stack.** Vitest 1.x. Reasons: native Vite integration, fast, supports both browser-style React tests and node TS tests in one config.

**Install.**
```bash
npm install -D vitest @vitest/ui @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom
```

**Files to create.**
- `vitest.config.ts` — workspace config with two projects: `frontend` (jsdom env, `src/**/*.test.{js,jsx}`) and `functions` (node env, `netlify/functions/**/*.test.ts`).
- `src/test/setup.ts` — `@testing-library/jest-dom` extensions, any global mocks.
- `package.json` — add scripts: `"test": "vitest run"`, `"test:watch": "vitest"`, `"test:ui": "vitest --ui"`, `"coverage": "vitest run --coverage"`.

**Validation.**
```bash
npm test  # should run 0 tests successfully (harness works, no tests yet)
```

### Workstream 2 — Regression tests for known bug families

The cache-poisoning bug pattern hit v0.7.18 (target-board), v0.7.19 (prophet), v0.7.21 (earnings-board, insider-board). The fix in each case: don't write to `resultCache` when the result is empty. One regression test per affected endpoint guarantees a fourth recurrence is caught at PR time.

**File.** `netlify/functions/__tests__/cache-poisoning.test.ts`

**Test pattern (apply to all four endpoints).**
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// For each endpoint: target-board, prophet-picks, earnings-board, insider-board
// 1. Mock all upstream data calls to return empty arrays
// 2. Invoke the handler
// 3. Assert resultCache (or whatever the cache var is named) was NOT written to
// 4. Invoke again with same key
// 5. Assert handler re-attempted the work (didn't return cached empty)
```

You may need to refactor each endpoint slightly to make `resultCache` injectable or exported for testing. That refactor is part of this workstream.

**Validation.** All 4 tests pass. Manually break the fix in one endpoint (re-add the bug) and confirm the test fails.

### Workstream 3 — Layer scorer unit tests

**File.** `netlify/functions/shared/__tests__/prophet-layers.test.ts`

The 7 layers in `prophet-layers.ts` are all pure functions of bar arrays + fundamentals. Each is straightforwardly testable with fixture bar data.

**Approach.**
- Create fixtures for: a clean uptrend, a clean downtrend, a chop range, a breakout, a breakdown, a low-vol grind, a high-vol regime, a momentum divergence.
- For each layer, write 3–5 tests asserting expected `score`, `pass`, and key flags on each fixture.
- Aim for ≥ 60% line coverage on `prophet-layers.ts`.

**Validation.** `npm run coverage` reports prophet-layers.ts coverage ≥ 60%.

### Workstream 4 — CI gates (GitHub Actions)

**Files.**
- `.github/workflows/ci.yml` — runs on every PR and push to main. Steps: checkout, setup-node 20, `npm ci`, `npx tsc --noEmit`, `npm test`. Fails the workflow if any step fails.
- `.github/workflows/coverage.yml` (optional, can be combined into ci.yml) — runs `npm run coverage` and uploads artifact. Fails if coverage drops below threshold (start permissive, e.g., 30% overall).

**Branch protection.** Set on main: require status checks to pass before merge. Cannot do this without GitHub admin API call — use the PAT to enable it via the REST API, or document the manual step in the PR description for the user to flip. Recommend documenting; user does it once.

**Validation.** Open a PR with this work. CI runs, all checks green. Verify a deliberately broken commit fails the check.

### Workstream 5 — Anthropic spend cap + circuit breaker

**Storage choice.** Use Netlify Blobs (free, durable, low-latency from same region as functions). Avoid Firestore for this — adds a Firebase dependency to backend functions that don't otherwise need it.

**Files.**
- `netlify/functions/shared/anthropic-budget.ts` — the budget + circuit breaker module.
- `netlify/functions/shared/anthropic-client.ts` — thin wrapper around the Anthropic API. Every Claude call goes through this. Pre-flight checks budget + circuit. Post-flight increments spend.

**Spend cap logic.**
- Daily key: `anthropic-spend:{YYYY-MM-DD}` in the `tradeiq-budget` Netlify Blob store.
- On call: read remaining; estimate cost from `max_tokens * output_rate + estimated_input_tokens * input_rate` (Opus: $15/M input, $75/M output).
- If estimated cost would exceed remaining budget → return error tagged `budget_exhausted`. Surface to UI as a friendly toast.
- After call: increment by actual `usage.input_tokens * 15 / 1e6 + usage.output_tokens * 75 / 1e6`.
- Default budget: `process.env.ANTHROPIC_DAILY_BUDGET_USD || 25`.

**Circuit breaker logic.**
- Key: `anthropic-circuit` in same blob store.
- Track `{errors: number, firstErrorAt: timestamp, openUntil: timestamp | null}`.
- On error: increment errors. If `errors >= 5` within 60s window → open circuit, set `openUntil = now + 5min`.
- On call when `openUntil > now` → fail fast with `circuit_open`.
- Half-open: when openUntil passes, allow one call. Success → reset; failure → re-open.

**Files to modify.**
- `netlify/functions/research.ts`, `prophet-picks.ts`, `chart-analysis.ts` — replace direct `fetch` to Anthropic API with the new client wrapper.

**Frontend handling.**
- `src/lib/validateResponse.js` — handle the new error shapes. Surface friendly messages.
- `src/App.jsx` — show a small banner at top when budget is exhausted: "AI features paused until tomorrow (daily budget reached)". Don't block other tabs.

**Validation.**
- Set `ANTHROPIC_DAILY_BUDGET_USD=0.01` in Netlify, hit `/api/research?ticker=NVDA`, expect 503 with budget_exhausted.
- Reset to 25 after testing.

### Workstream 6 — Error tracking (Sentry)

**Provider.** Sentry free tier (5k errors/month, more than enough for personal use).

**Setup steps.**
1. Create Sentry project at sentry.io. Two platforms: "React" for frontend, "Node" for serverless. Or use one combined project with two source maps.
2. Get the DSN.
3. Set Netlify env var `SENTRY_DSN` to the DSN value.
4. (Optional) Set `SENTRY_AUTH_TOKEN` for source map uploads.

**Install.**
```bash
npm install @sentry/react @sentry/node
```

**Files.**
- `src/lib/sentry.js` — frontend init + ErrorBoundary integration.
- `netlify/functions/shared/sentry.ts` — backend init + handler wrapper.
- `src/main.jsx` — call `initSentry()` before app render.
- Every netlify function — wrap handler with `withSentry(handler)`.
- `src/App.jsx` ErrorBoundary `componentDidCatch` — also call `Sentry.captureException(error, { contexts: { react: { componentStack: info.componentStack } } })`.

**Source maps.** Vite generates source maps in build. Upload via Sentry CLI in CI, or use `@sentry/vite-plugin` with the auth token.

**Validation.** Throw a deliberate error in `src/views/EngineTestView.jsx`, verify it shows up in Sentry within 30s. Remove the throw.

### Workstream 7 — Structured logging

**File.** `netlify/functions/shared/logger.ts`

**Implementation.** Simple — no Pino, no Winston. ~30 lines.

```ts
type Level = 'debug' | 'info' | 'warn' | 'error';
interface LogContext { [key: string]: any }

export function createLogger(fn: string) {
  return {
    debug: (msg: string, ctx?: LogContext) => log('debug', fn, msg, ctx),
    info: (msg: string, ctx?: LogContext) => log('info', fn, msg, ctx),
    warn: (msg: string, ctx?: LogContext) => log('warn', fn, msg, ctx),
    error: (msg: string, ctx?: LogContext) => log('error', fn, msg, ctx),
  };
}

function log(level: Level, fn: string, msg: string, ctx?: LogContext) {
  const entry = {
    ts: new Date().toISOString(),
    level,
    fn,
    msg,
    ...ctx,
  };
  // Netlify captures stdout — JSON line is queryable in their logs UI
  console.log(JSON.stringify(entry));
}
```

**Wrap pattern.** Every function gets:
```ts
const log = createLogger('target-board');
// At handler entry:
const start = Date.now();
log.info('request', { qs: event.queryStringParameters });
// At handler exit:
log.info('response', { status, durationMs: Date.now() - start, cached: ... });
// On error:
log.error('failed', { error: String(err), durationMs: Date.now() - start });
```

**Files to modify.** Every `netlify/functions/*.ts` handler — replace ad-hoc `console.log` with structured logger calls. Keep this surgical: entry, exit, errors, and any cache hit/miss. Do not add chatty debug logs.

**Validation.** Hit `/api/health` and verify Netlify function logs show structured JSON entries.

### Workstream 8 — Firestore backups

**Recommended approach for personal-tool simplicity.** Weekly GitHub Action that exports the `tradeLog` collection to JSON and commits it to a private backup repo.

**Why this and not GCS.**
- No GCP service account setup.
- Free.
- Version-controlled (each backup is a commit).
- Multi-region durable (GitHub).
- Restore is `git clone backup-repo && find backup file && firebase import`.

**Files.**
- `.github/workflows/backup-firestore.yml` — runs `0 6 * * 0` (Sundays 6am UTC). Steps: checkout TradeIQ, install deps, run export script, push to backup repo.
- `scripts/export-firestore.ts` — uses `firebase-admin` SDK with a service account. Reads all documents in `tradeLog` (and any other collections), writes to `backups/firestore-{YYYY-MM-DD}.json`. Compresses with gzip if > 1MB.
- `scripts/restore-firestore.ts` — reverse direction. For drill testing.

**One-time setup the user must do (document in PR description):**
1. Create a private GitHub repo `DavisDelivery/TradeIQ-backups`.
2. Create a Firebase service account JSON for the `tradeiq-alpha` project. Save the JSON.
3. Set the JSON as a GitHub Actions secret named `FIREBASE_SERVICE_ACCOUNT` on the TradeIQ repo.
4. Set the GitHub PAT as `BACKUP_REPO_PAT` (can reuse main PAT if scope covers DavisDelivery org).

**Validation.** Manually trigger the workflow. Verify a JSON file lands in the backup repo with > 0 trade entries.

### Workstream 9 — Dead code purge

**Action.**
```bash
git rm -r app/
```

The `app/` directory is the v1 source recovered from a deploy map (per README). It's not built, not referenced, just confusing. Update README to remove the recovery note that's now stale.

**Validation.** `npm run build` still succeeds. Repo size drops.

### Workstream 10 — README hygiene

**File.** `README.md`

Rewrite to reflect current state. Should include:
- One-paragraph description of what TradeIQ is.
- Link to ORCHESTRATOR.md as the source of truth on roadmap.
- Local dev setup (`npm install`, `npm run dev`, env vars needed).
- Test commands (`npm test`, `npm run coverage`).
- Deploy story (auto-deploy on push to main, after CI green).
- Link to live site.
- Brief architecture note (React + Vite + Netlify Functions + Firestore + Anthropic).

Remove the v1 recovery section — it's no longer relevant.

---

## Standing rules (apply to every commit)

- ALWAYS bump `APP_VERSION` in `src/App.jsx` on any user-visible change. Phase 0's bump: `0.7.25-alpha → 0.8.0-alpha` (minor bump because the engineering foundation is a meaningful new layer).
- Every data table column is sortable via the `useSortable` hook + `SortableTh` component. (No new tables in Phase 0, but if you add any debug views, follow the rule.)
- Anything to be copied into another tool/conversation goes in a markdown doc or code block. Never plain prose.
- Critical data ingest preserves four layers: original bytes (gzipped), `{source}_rows_raw` with all columns, parsed/normalized rows, aggregations.
- Brand blue: `#1e5b92` (Davis Delivery family — TradeIQ stays neutral dark).
- Don't refer to Davis Delivery Dispatch as "Glory Bound Dispatch".

---

## Deploy pattern (Netlify MCP is flaky)

After your PR is merged to main, Netlify auto-deploys. Verify:

1. Wait 50–60s after merge.
2. `curl -sS https://tradeiq-alpha.netlify.app/ -o /tmp/index.html && grep -oE 'assets/[^"]*\.js' /tmp/index.html | head -1`
3. Download the bundle: `curl -sS https://tradeiq-alpha.netlify.app/<bundle-path> -o /tmp/b.js`
4. Verify version: `grep -oE "0\.[0-9]+\.[0-9]+-alpha" /tmp/b.js | head -1` should show `0.8.0-alpha`.
5. If verification fails, use the Netlify MCP `get-deploy-for-site` to check `state` and `enhancedSecretsScanMatches`.

If you need an explicit deploy trigger:
1. `Netlify:netlify-deploy-services-updater` with `{operation: "deploy-site", params: {siteId: "8e90d525-78f3-4288-9c15-8b1968e994c1"}}`.
2. Copy returned proxy-path (expires in seconds).
3. `timeout 90 npx -y @netlify/mcp@latest --site-id 8e90d525-78f3-4288-9c15-8b1968e994c1 --proxy-path "<path>" --no-wait`.
4. Retry with fresh proxy-path on silent fail or 503.
5. Sleep 50–55s, verify with `get-deploy-for-site` checking `state: "ready"`.
6. Confirm bundle: download to `/tmp/b.js` first, then grep — don't pipe curl through grep.

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
git checkout -b phase-0-engineering-foundation
```

---

## Commit and PR protocol

**During work.** Commit in logical chunks per workstream. Examples:
- `phase-0(tests): add Vitest harness + initial config`
- `phase-0(tests): regression tests for cache-poisoning across 4 endpoints`
- `phase-0(tests): unit tests for prophet-layers (62% coverage)`
- `phase-0(ci): GitHub Actions for tsc + tests on PR + main`
- `phase-0(spend-cap): Anthropic budget + circuit breaker via Netlify Blobs`
- `phase-0(sentry): error tracking on frontend + functions`
- `phase-0(logging): structured JSON logger across all functions`
- `phase-0(backups): weekly Firestore export to backup repo`
- `phase-0(cleanup): remove dead /app/ directory`
- `phase-0(docs): README rewrite + version bump 0.8.0-alpha`

**PR.**
- Title: `Phase 0: Engineering foundation + safety nets (v0.8.0-alpha)`
- Description: list of workstreams completed, success criteria evidence (test counts, coverage %, CI green screenshot, Sentry test event link, sample log line, backup repo first-commit link).
- Document any one-time user actions: branch protection setup, Sentry project creation, Firebase service account creation, backup repo creation.

**Merge.** Self-merge after CI green and after the user has done the one-time setup steps. Verify deploy.

---

## Status table update (do this last)

After deploy is verified live and the version matches, edit `ORCHESTRATOR.md` Status table:

```
| 0 | Engineering foundation + safety nets | done | 0.8.0-alpha | YYYY-MM-DD | <one-line summary of what shipped> |
```

Commit the status update directly to main (skip PR for this trivial doc edit):
```bash
git checkout main
git pull
# edit ORCHESTRATOR.md
git add ORCHESTRATOR.md
git commit -m "ORCHESTRATOR: Phase 0 done at v0.8.0-alpha"
git push
```

---

## Success criteria (testable definition of done)

All must be true before marking Phase 0 done:

- [ ] `npm test` runs ≥ 30 tests, all green.
- [ ] CI workflow blocks a PR with a failing test (verified by deliberately breaking one).
- [ ] Cache-poisoning regression tests exist for target-board, prophet, earnings-board, insider-board (4 tests minimum).
- [ ] `prophet-layers.ts` line coverage ≥ 60%.
- [ ] `/api/research?ticker=NVDA` while over daily Anthropic budget returns 503 with `error: 'budget_exhausted'`.
- [ ] An Anthropic API failure five times in 60s opens the circuit breaker for 5min.
- [ ] An exception in `/api/prophet-picks` shows up in Sentry within 30s.
- [ ] A frontend ErrorBoundary catch shows up in Sentry within 30s.
- [ ] All netlify functions emit structured JSON log lines on entry, exit, error.
- [ ] First Firestore backup exists in `DavisDelivery/TradeIQ-backups` repo.
- [ ] `app/` directory is removed.
- [ ] README rewritten, references ORCHESTRATOR.md, no stale v1 recovery section.
- [ ] APP_VERSION = `0.8.0-alpha` and verified in live bundle.
- [ ] ORCHESTRATOR.md Status table shows Phase 0 as `done`.

---

## What to do if blocked

- **Sentry account creation.** If the user must create the project, document the exact steps in your PR description and pause that workstream. Ship everything else; do a follow-up commit when DSN is available.
- **Backup repo creation.** Same — needs user action. Document and ship.
- **Branch protection.** Same — document the manual GitHub UI step.
- **Firebase service account.** Same — needs user to download the JSON and add as GitHub secret.
- **Netlify env var write fails via MCP.** Document the env var in PR description; user adds via Netlify UI.

Don't block the whole phase on user action items. Ship the code paths, document the manual setup, mark those workstreams as `pending-user-action` in the PR.

---

## Out of scope for Phase 0

These are tempting but defer them:
- Universe coverage / scheduled scans / snapshot infrastructure (that's Phase 1).
- Refactoring App.jsx (that's Phase 2).
- Adding Zod schemas at API boundaries (Phase 2).
- TanStack Query (Phase 2).
- Any change to scoring logic, analyst weights, or composite math.
- Any change to the alphabetical-cap behavior in `target-board.ts`, `prophet-picks.ts`, etc. — leave those caps alone. Phase 1 will replace them with snapshot-backed reads.
- Any new feature visible to the user except the budget banner.
- Anything in the `app/` directory beyond deleting it.

If you find yourself reaching into Phase 1+ work, stop and note it in a comment in ORCHESTRATOR.md status table notes.

**One important alignment note for Phase 0 → Phase 1 handoff.** When you create the Firebase service account JSON for Phase 0 backups, store it somewhere the user can reuse it for Phase 1's `FIREBASE_SERVICE_ACCOUNT` env var. Same project (`tradeiq-alpha`), same JSON works for both. Document this in your PR so the user doesn't end up with two service accounts.

---

## First actions

```bash
# 1. Get the working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git pull --rebase
git checkout -b phase-0-engineering-foundation

# 2. Read the orchestrator + current state
cat ORCHESTRATOR.md | head -100
cat package.json
ls netlify/functions/
wc -l src/App.jsx

# 3. Start with Workstream 1 (test harness) — lowest risk, unblocks everything else
npm install -D vitest @vitest/ui @vitest/coverage-v8 @testing-library/react @testing-library/jest-dom jsdom
```

Then proceed through the workstreams in order. Workstream 4 (CI) should land before Workstream 5+ so subsequent workstreams get tested by CI as you push.

---

End of brief. Begin work.
