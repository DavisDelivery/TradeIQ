# Phase 0 Reconciliation Brief

You are the Phase 0 reconciliation agent for TradeIQ. Phase 1 has merged to main since Phase 0 was authored. Phase 0's branch (`phase-0-engineering-foundation`) was forked from the same parent as Phase 1, so the two branches modified overlapping files independently and need to be reconciled before Phase 0 can merge.

This is a reconciliation task, not a build. The Phase 0 work is done — your job is to make it land cleanly on top of Phase 1's main.

---

## Precondition gate (do this first)

Phase 1 merged to main at commit `b8e8c23` (v0.9.1-alpha) and is verified live. Confirm before proceeding — if the gate fails, something is wrong with the local clone, not the world state.

```bash
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git fetch origin
git log origin/main --oneline | grep -E "b8e8c23|aad24f0|0\.9\.1-alpha" | head -3
```

Expect at least one match. If empty, surface to user — do not proceed.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
NETLIFY_TOKEN=nfp_cwoJworGUNTi6opj8rukZpkKWXL78pbV0278
NETLIFY_SITE_ID=8e90d525-78f3-4288-9c15-8b1968e994c1
```

The PR you'll be updating is **PR #1** at `github.com/DavisDelivery/TradeIQ/pull/1`. Branch `phase-0-engineering-foundation`.

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`, plus Netlify deploy/read connectors.

---

## Rebase strategy

Use a merge commit, not a hard rebase. Phase 0 has 12 commits and rebasing across overlapping function file rewrites is more error-prone than a single explicit merge commit with conflict resolutions.

```bash
git checkout phase-0-engineering-foundation
git pull --ff-only origin phase-0-engineering-foundation
git merge origin/main
# Conflicts will appear. Resolve per the specific list below.
```

---

## Known conflict surface (this is what to expect)

These are the files where Phase 0 and Phase 1 modified the same lines. Resolve each per the rule given. Don't deviate.

### `package.json`
**Conflict:** both phases added dependencies.
**Resolution:** union. Keep all of Phase 0's deps (`vitest`, `@vitest/ui`, `@vitest/coverage-v8`, `@testing-library/*`, `jsdom`, `@sentry/react`, `@sentry/node`) AND all of Phase 1's deps (`firebase-admin`). Sort alphabetically within each section. Run `npm install` after to regenerate `package-lock.json`.

### `netlify/functions/shared/logger.ts`
**Conflict:** both phases created this file with the same name.
**Resolution:** Phase 1's PR explicitly described its logger as a "drop-in replacement, no call-site changes" anticipating Phase 0's real version. **Keep Phase 0's** (it has Sentry hook integration, JSON output to stdout, `child()` for context propagation). Discard Phase 1's stub. Verify the public interface (function names, signatures) matches what Phase 1's call sites expect — `logger.info()`, `logger.warn()`, `logger.error()`, `logger.child({...})`. If a call site breaks, the fix is to align Phase 0's interface to match Phase 1's call shape, NOT to keep Phase 1's stub.

### `src/App.jsx`
**Conflict:** Phase 0 added Sentry init inside ErrorBoundary's `componentDidCatch`. Phase 1 added: HistoryView import, History tab in the views array, render branch for `activeView === 'history'`, EarningsView refactor with FreshnessPill, version bump to `0.9.1-alpha`.
**Resolution:**
- Keep all of Phase 1's structural changes (imports, nav, render branches, EarningsView).
- Re-apply Phase 0's Sentry init (in ErrorBoundary `componentDidCatch` — call `Sentry.captureException`).
- Re-apply Phase 0's `initSentry()` call wherever it lives (likely in `src/main.jsx` not App.jsx).
- **Bump APP_VERSION to `0.10.0-alpha`** — Phase 0 is a meaningful new layer (tests, CI, observability, spend cap, backups). Minor bump appropriate.

### `netlify/functions/*.ts` (live endpoints)
**Conflict:** Phase 0 added structured-logger calls (entry log, exit log, error log) to all 16 functions. Phase 1 wholesale-rewrote 7 of those handlers (`target-board.ts`, `prophet-picks.ts`, `catalyst-board.ts`, `insider-board.ts`, `williams-board.ts`, `lynch-board.ts`, `earnings-board.ts`) to be snapshot-first.
**Resolution:** For the 7 rewritten files, Phase 1's structure wins. Phase 1's rewrites already include `logger.child()` calls (since they use the logger stub). Those calls now resolve to Phase 0's real logger via the file you just kept in `shared/logger.ts`. **Do not re-add Phase 0's old log calls inside Phase 1's rewrites** — Phase 1 already logs at the right boundaries (snapshot hit, fallback, errors). For the other 9 functions Phase 1 didn't touch, keep Phase 0's log calls as-is.

### `netlify/functions/research.ts`, `prophet-picks.ts`, `chart-analysis.ts` (Anthropic clients)
**Conflict:** Phase 0 wrapped these with the new `anthropic-client.ts` for spend-cap + circuit-breaker. Phase 1 modified `prophet-picks.ts` for snapshot logic but NOT the Anthropic call inside it.
**Resolution:** Keep both changes. Phase 1's snapshot read happens before/around the Claude call; Phase 0's wrapper applies to the Claude call itself. They compose cleanly. Verify by tracing: `handler → snapshot read (Phase 1) → if miss, scan logic → narrative gen via wrapped anthropic-client (Phase 0) → response`.

### `netlify/functions/scheduled/*.ts` (the 7 scheduled scans)
**Phase 0 didn't touch these** — they're net-new from Phase 1. No conflict. They already use `logger.child()` from the kept Phase-0 logger; no further change needed.

### `app/` directory
**Phase 0 deleted it.** Confirm it stays deleted after merge — Phase 1 didn't touch `app/`, but a careless conflict resolution might restore it.

### `README.md`
**Conflict:** Phase 0 rewrote it. Phase 1 may not have touched it.
**Resolution:** keep Phase 0's rewrite. Add a one-line note in the "Roadmap" section that Phase 1 (universe coverage + snapshots) is also live as of v0.9.1-alpha.

---

## After merge resolution

```bash
git status                                  # confirm clean
npm install                                 # regenerate lockfile after package.json union
npx tsc --noEmit                            # MUST be clean
npm test                                    # MUST be all green; expect ≥70 tests
npm run build                               # MUST be clean
```

If any step fails, fix and re-verify before proceeding. Don't merge a broken reconciliation.

Then:

```bash
git add -A
git commit -m "Reconcile Phase 0 with main (Phase 1 already merged)

- package.json: union of vitest/sentry/testing-libs (Phase 0) and firebase-admin (Phase 1)
- shared/logger.ts: kept Phase 0's real logger, discarded Phase 1's stub
- src/App.jsx: kept Phase 1's HistoryView + earnings refactor, re-applied Phase 0's Sentry hook in ErrorBoundary, bumped APP_VERSION to 0.10.0-alpha
- 7 rewritten function handlers: kept Phase 1's snapshot-first structure, did not duplicate logger calls (Phase 1's logger.child() now resolves to Phase 0's real logger)
- 9 untouched functions: kept Phase 0's log instrumentation
- Anthropic clients: kept both Phase 0's spend-cap wrapper and Phase 1's snapshot wiring
- README.md: Phase 0's rewrite + roadmap note for Phase 1
- All 70+ tests green, typecheck clean, build clean"
git push origin phase-0-engineering-foundation
```

---

## Update PR #1 body

Append a "Reconciliation status" section to PR #1's body:

```bash
PR_BODY=$(curl -sS \
  -H "Authorization: Bearer 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" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls/1 | jq -r '.body')

NEW_SECTION=$(cat <<'EOF'

---

## Reconciliation status (post-Phase-1 merge)

This branch was reconciled with main after Phase 1 (v0.9.1-alpha) landed. Specific resolutions:

- `shared/logger.ts`: kept Phase 0's real Sentry-integrated logger, discarded Phase 1's stub.
- `src/App.jsx`: integrated Phase 0's Sentry hook into ErrorBoundary alongside Phase 1's HistoryView nav + earnings refactor. APP_VERSION bumped to `0.10.0-alpha`.
- 7 rewritten function handlers (target/prophet/catalyst/insider/williams/lynch/earnings boards): preserved Phase 1's snapshot-first structure; logger calls already in place via Phase 1's `logger.child()` now resolve to Phase 0's real logger.
- 9 functions Phase 1 didn't touch: Phase 0's logging instrumentation preserved as-is.
- `package.json`: union of both deps.
- All 70+ tests green, typecheck clean, build clean.
EOF
)

UPDATED_BODY=$(printf "%s%s" "$PR_BODY" "$NEW_SECTION")

curl -sS -X PATCH \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls/1 \
  -d "$(jq -n --arg body "$UPDATED_BODY" '{body: $body}')"
```

---

## Out of scope

- **Do not merge the PR.** That's the user's call after verifying CI passes (once they install the CI workflow per Phase 0's user action items) and reviewing the diff.
- **Do not perform Phase 0's user-action setup** (Sentry project creation, backup repo creation, branch protection, CI workflow install). Those stay with the user — they involve external services and one-time clicks the agent can't do safely.
- **Do not edit ORCHESTRATOR.md.** Status flips to `done` only after Phase 0 PR merges + deploy verifies live + user actions complete. Orchestrator handles that.
- **Do not start any other phase.**

---

## Report back

End your turn with:

- Conflicts encountered: <list per file>
- Resolution applied per file: <one-line each>
- Test count post-reconcile: <N tests, all green / N failures>
- Typecheck: clean / errors
- Build: clean / errors
- Branch pushed: yes/no
- PR #1 body updated: yes/no
- Any blockers surfaced to user

If reconciliation reveals a conflict not covered above (something unexpected in test files, a third-party config file, etc.), surface to user before guessing.

---

End of brief.
