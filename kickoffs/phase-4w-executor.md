# Phase 4w Executor Kickoff — Massive Financials VX Endpoint Migration

> **For Chad:** paste the bootstrap block at the end of this file into
> a fresh Claude chat. The PAT is embedded inline. This is its own
> executor agent — NOT W1b, W1c, or Phase 6.
>
> **DO NOT KICK OFF THIS AGENT UNTIL YOU'VE VERIFIED THE PLAN-ACCESS
> PREREQUISITE.** See PART 0 below. The agent's first probe call will
> fail in seconds if your Massive subscription doesn't cover the new
> Fundamentals endpoints.

---

# PART 0 — PREREQUISITES (Chad action; do BEFORE kicking off the agent)

## Plan-access verification (5 minutes)

Massive's sunset email notes: "Depending on your current plan,
accessing the Fundamentals endpoints may require an upgrade or
add-on."

**Steps:**

1. Log into massive.com (or polygon.io dashboard if Massive is a
   Polygon rebrand and the auth still routes there)
2. Check subscription tier. Confirm one of:
   - **Stocks Advanced** (individual tier with fundamentals access)
   - **Stocks Financials Add-on** (sits on top of a lower tier)
   - **Stocks Business** or **Stocks Financials for Business
     Add-on** (organization tiers)
3. Verify your API key has access to the three new endpoints:
   - `/v1/reference/financials/balance-sheets` (or whatever the
     exact URL is per current docs)
   - `/v1/reference/financials/cash-flow-statements`
   - `/v1/reference/financials/income-statements`

If your current plan covers: proceed to kicking off the agent.

If your current plan does NOT cover:
- Upgrade plan via massive.com dashboard, OR
- Add the Financials Add-on, OR
- Escalate to find an alternative fundamentals provider (longer
  re-scope — surface to orchestrator)

## W1c merge status check

W1c W2 PR is shipping changes to the same file (`data-provider.ts`).
The agent's W1 work is read-only and can start anytime, BUT W2/W3
implementation must wait for W1c to merge to avoid conflicts.

When kicking off this agent, tell them where W1c currently stands:
- W1c W2 PR not yet open → agent does W1 only, then waits for W1c
  before W2
- W1c W2 PR open but not merged → agent does W1, then waits
- W1c W2 PR merged + verified → agent proceeds through W1 → W2 → W3

---

# PART 1 — FOR THE AGENT (after Chad confirms Prereq 1)

You are an executor agent. Your single assignment is **Phase 4w** —
the Massive Financials VX endpoint migration. The full brief is at
`briefs/phase-4w-brief.md`. Read this kickoff end-to-end, then read
the brief, then proceed.

**Hard deadline: Monday, June 22, 2026.** Internal target: merge by
**early June 2026** for 2-3 weeks buffer. This is real money / real
data risk if missed — the fundamental analyst breaks live AND
backtest at midnight on June 22 if we don't ship.

**Scope discipline (read twice):**

- You migrate `getFundamentals` in `data-provider.ts` from the
  sunsetting VX endpoint to three new Fundamentals endpoints.
- You do NOT modify `runFundamentals` scoring math (read-only).
- You do NOT touch any other analyst's fetch path.
- You do NOT touch the russell2k path (W1b territory, PR #52).
- You do NOT touch earnings or insider paths (W1c territory, PR
  #53 — but DO read W1c's merged PR for the WithStatus pattern
  you'll mirror).
- You do NOT touch the backtest engine.
- You do NOT touch Phase 6 frontend or its `/api/stock-detail`
  endpoint (consumes `getFundamentals` via abstraction — insulated).
- You do NOT add new dependencies.
- You do NOT build a VX-fallback path. VX is dead June 22.
- You do NOT silently drop any VX field that has no equivalent in
  the new endpoints. Surface to orchestrator first.

## What TradeIQ is (one paragraph)

TradeIQ is a personal multi-board equity-research app at
`https://tradeiq-alpha.netlify.app`. A React/Vite SPA backed by
TypeScript Netlify functions and Firestore. The `fundamental`
analyst is one of ten in the target composite. It fetches via
`getFundamentals()` in `netlify/functions/shared/data-provider.ts`.
Owner: Chad Davis.

## What Phase 4w is

Massive (TradeIQ's fundamentals data vendor; possibly Polygon.io
under rebrand) is sunsetting the Financials VX endpoint on **June
22, 2026**. The endpoint was deprecated 2025-09-20. Sunset is the
hard kill — every call returns errors after that date.

The migration replaces ONE endpoint with THREE: Balance Sheets,
Cash Flow Statements, Income Statements. Work happens entirely
inside `getFundamentals` — three parallel calls, assemble into the
existing return shape, consumers unchanged.

Two PRs on one branch:
- **PR-1 (W1 design)**: probe + design report only. NO code.
- **PR-2 (W2 + W3)**: implementation + tests + cleanup script,
  after W1 review.

## The W1 design gate — diagnose-before-fix discipline

W1 ships ONLY a design report (`reports/phase-4w/design.md`). NO
code changes in PR-1. Orchestrator reviews and authorises W2 before
implementation begins.

This gate exists because shipping a fundamentals migration without
explicit field-mapping and historical-depth verification is exactly
how Phase 6 detail panels go subtly broken when shape mismatches
land. Diagnose first.

---

# PART 2 — COLD START

```bash
mkdir -p /home/claude && cd /home/claude
git clone https://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@github.com/DavisDelivery/TradeIQ.git
cd TradeIQ
git log --oneline -10
git config user.email "executor-4w@tradeiq.local"
git config user.name "Executor 4w"

npm ci    # if it fails on cross-platform optional deps: npm install
npx tsc --noEmit
npm test
npm run build

git checkout -b phase-4w-massive-fundamentals-migration
```

If baseline fails, STOP and report. APP_VERSION is bumped only on
the W2/W3 fix PR (not the W1 design-only PR).

**Environment note:** if commits fail from `/home/claude/TradeIQ`,
relocate to `/home/user/TradeIQ` or `/tmp`.

Read `briefs/phase-4w-brief.md` after this kickoff. The brief is the
substantive spec with the workstream breakdown, acceptance criteria,
disciplines, and the architectural framing.

**Read W1c's merged work BEFORE starting your W1**:
- `git log --all --oneline | grep -i w1c` to find the W1c commits
- Read `reports/phase-4t-w1c/diagnosis.md` for the "no silent []"
  architectural framing
- Read the W1c W2 PR diff to see the WithStatus pattern and the
  `shouldPersist` predicate mechanism — you'll mirror both
- Read `netlify/functions/shared/insider-provider.ts` (post-W1c
  shape) — this is the model for your three new fetch helpers
- Read `netlify/functions/shared/pit-cache.ts` (post-W1c) — for
  the `shouldPersist` opt-in mechanism
- If W1c has flagged anything specifically about `getFundamentals`
  in their audit findings (look in the W1c PR description and any
  follow-up commits), incorporate that into your W1 probe

**Secrets:** GitHub PAT in the clone URL. The deployed Netlify
functions have the Massive API key in env (whatever variable name
— probably `POLYGON_API_KEY` if Massive is a Polygon rebrand). For
local probe work, ask Chad to add the key to your env or run probes
against the deployed Netlify function via a temporary diagnostic
endpoint.

---

# PART 3 — REPO ORIENTATION

## 3.1 Key files

Read-only references (do NOT modify):
- `netlify/functions/shared/data-provider.ts` — `getFundamentals`
  is here. Read its current implementation.
- `netlify/functions/shared/insider-provider.ts` — W1c's
  WithStatus pattern (model for new fetch helpers)
- `netlify/functions/shared/earnings-intel.ts` — earlier pattern
  reference if useful
- `netlify/functions/shared/pit-cache.ts` — `pitCacheWrap` with
  the `shouldPersist` predicate W1c just added
- `analysts/core.ts` (or wherever `runFundamentals` lives) — the
  consumer; understand what shape it expects from `getFundamentals`
- `reports/phase-4t-w1c/diagnosis.md` — architectural precedent
- `netlify/functions/target-rationale.ts` — calls
  `runFundamentals` indirectly; useful for smoke testing
- Phase 6's stock-detail endpoint (find via `grep -rn
  'stock-detail' netlify/functions/`) — another consumer of
  `getFundamentals`

## 3.2 Files you'll MODIFY (W2 only; not W1)

W1 (PR-1) commits ONLY:
- `reports/phase-4w/design.md` (new)

W2+W3 (PR-2) commits:
- `netlify/functions/shared/data-provider.ts` — `getFundamentals`
  refactored; three new fetch helpers added
- `__tests__/...` — new regression tests for the migrated function
- `scripts/clear-stranded-vx-fundamentals-cache.ts` — new cleanup
  script
- `src/App.jsx` — APP_VERSION bump

## 3.3 Files you may NOT modify (any workstream)

- Analyst scoring math (`analysts/*.ts` — `runFundamentals`,
  others — all read-only)
- Backtest engine (`shared/backtest/*`)
- W1b russell2k path or PR #52 territory
- Recovery / reinvoke / sweep code (PR #51 territory)
- Other analyst data fetches (earnings, insider, news, etc.) —
  Phase 4w is fundamentals-only
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`
- `package.json` (no new deps without orchestrator checkpoint)

---

# PART 4 — W1 WORK (design report only)

## 4.1 Endpoint shape probe (W1.a)

For each new endpoint, make a probe call against a known-good
ticker (NVDA 2024-09-30 suggested) and document:
- Exact URL used
- Full response body (sample, redacted if needed)
- URL parameter semantics (`from`, `to`, `period_of_report`, etc.)
- Rate-limit headers
- Error response shape

## 4.2 Field mapping (W1.b)

Build the VX → new-endpoint field mapping table. Document every
field `getFundamentals` currently returns (from reading its source
+ a captured VX response), and where each field maps to in the new
endpoints.

Flag any VX field with NO new-endpoint equivalent — that's a
regression risk requiring orchestrator decision before W2.

## 4.3 Historical depth probe (W1.c)

Probe 2018-2020 era tickers (AAPL Q1 2018, MSFT Q1 2018, AMZN Q1
2018, then 2019, 2020) on each new endpoint. Document:
- Does the response return data, or empty?
- If empty, is it a successful response with no records, or a 404?
- Where does the cliff actually land on the new endpoints?

If the new endpoints have DEEPER historical coverage than VX did,
the migration delivers a real backtest unlock. Document specifically.

## 4.4 Cache key strategy (W1.d)

Decide and document: Option A (versioned same-namespace) or Option
B (separate dataClass per endpoint). Recommend Option B unless
there's a reason not to.

## 4.5 shouldPersist opt-in (W1.e)

Per the W1c discipline, decide whether each new fetch opts into
`shouldPersist: (v) => v !== null`. Recommendation: yes for all
three.

## 4.6 W1 deliverable

`reports/phase-4w/design.md` with the structured sections per the
brief. Commit to the branch `phase-4w-massive-fundamentals-migration`
and open PR-1 as a DRAFT with only this report committed.

Hand off to orchestrator. **WAIT for orchestrator review before any
W2 code.**

---

# PART 5 — W2 + W3 WORK (after W1 review AND W1c merge)

## 5.1 The three new fetch helpers (W2.a)

Each helper:
- Constructs the new endpoint URL with proper params
- Handles WithStatus envelope per W1c pattern (throw on
  rateLimitExhausted / errorMessage)
- Returns the endpoint's response shape (one helper per endpoint)
- Is wrapped in `pitCacheWrap` with `shouldPersist: (v) => v !==
  null` (per W1c discipline)

## 5.2 The assembler (W2.a)

`assembleFundamentals(balanceSheets, cashFlows, incomeStatements)`
combines the three into the existing VX-shape that
`getFundamentals` returns. Field mapping per W1's design.md.

Handles partial failure correctly — if one of three is null
(caught error), assembly still produces a usable result with the
affected fields marked `_noData` (or returns null entirely if the
analysis can't proceed without that data — W1 decides).

## 5.3 Tests (W2.c)

- Unit tests for each of the three new fetch helpers
- Unit test for `assembleFundamentals`
- Integration test for `getFundamentals` end-to-end against mocked
  endpoints
- Golden-reference test: a captured VX response (from prod cache or
  saved sample) is the reference; the assembled output for the
  same ticker must match the VX-shape exactly
- All existing tests still pass (1054 baseline pre-W1c; may be
  higher after W1c lands)

## 5.4 Cleanup script (W3.a)

`scripts/clear-stranded-vx-fundamentals-cache.ts` — dry-run
default, `--confirm` flag for actual delete. Mirrors W1c's
`clear-stale-insider-empties.ts` exactly.

## 5.5 Post-deploy verification documented in PR description (W3.b)

The orchestrator-executed post-merge sequence per the brief's W3.b
section.

---

# PART 6 — CONVENTIONS

- TypeScript `strict: true`
- WithStatus pattern from W1c for all three new fetch helpers
- `shouldPersist: (v) => v !== null` for all three new cache wraps
- Mirror W1c's discipline-naming in code comments: reference
  "Phase 4o W1's 'no silent []' intent" and back-reference Phase
  4w's design.md
- No new dependencies
- No silent fallbacks

---

# PART 7 — HAND-OFF FORMAT

After W1 (design PR opens draft):

```
PHASE 4w — W1 design PR #N open (DRAFT):
  https://github.com/DavisDelivery/TradeIQ/pull/N

Design: reports/phase-4w/design.md

Probe findings:
  Balance Sheets:        <one-line summary, URL params, response shape>
  Cash Flow Statements:  <one-line>
  Income Statements:     <one-line>

Field mapping: <X fields total; Y mapped to new endpoints;
                Z VX fields with NO equivalent → see design.md §...>

Historical depth: <found data back to <year>; cliff at <date>>
                  <UNLOCK CONFIRMED / no improvement vs VX>

Cache strategy: Option <A/B> recommended — <reasoning one-line>

shouldPersist opt-in: yes for all three / <other>

Estimated W2 diff: <LOC>

Open questions:
  - <if any>

Standing by for orchestrator review. NO code written. Will not
proceed to W2 until diagnosis authorised AND W1c W2 has merged.
```

After W2+W3 (fix PR opens ready-for-review):

```
PHASE 4w — W2+W3 fix PR #M open (ready for review):
  https://github.com/DavisDelivery/TradeIQ/pull/M

Implementation:
  - 3 new fetch helpers (Balance Sheets, Cash Flow, Income Statements)
  - assembleFundamentals: field mapping per design.md
  - shouldPersist: (v) => v !== null on all three cache wraps
  - getFundamentals: thin assembler; return shape byte-equivalent
    to pre-migration VX response (golden test passes)
  - APP_VERSION <prev> → <bumped>

Cleanup script:
  - scripts/clear-stranded-vx-fundamentals-cache.ts
  - dry-run default, --confirm for delete
  - PR description includes dry-run output snippet

Tests:
  - <count> new tests in __tests__/...
  - Golden-reference assertion: <ticker> matches pre-migration shape
  - Fails-without-fix verified: <count> assertions
  - All existing tests pass: <count>

Verification: tsc clean / build clean / no consumer changes /
no scoring math changes / no W1b/W1c/PR#51 territory touched

Acceptance: DEFERRED to orchestrator review + merge + post-merge
cleanup + sp500 re-fire verification.
```

---

# PART 8 — FAILURE MODES TO AVOID

- **Shipping code in W1.** W1 is design-only. The diagnose-before-
  fix gate is non-negotiable.
- **Silently dropping VX fields with no new-endpoint equivalent.**
  Surface to orchestrator. Don't make the decision unilaterally —
  Phase 6 detail panels may depend on those fields.
- **Building a VX-fallback path.** VX is dead June 22. Defensive
  fallback code is wasted effort that hides real failures.
- **Touching W1c-territory files** beyond reading them for pattern
  reference. The `data-provider.ts` may have outstanding W1c
  changes that haven't merged yet — rebase carefully.
- **Touching `runFundamentals` or any Phase 6 consumer.** Insulated
  by the abstraction.
- **Adding new dependencies.** Mirror the existing fetch / parse
  patterns.
- **Missing the deadline silently.** If W1 surfaces complexity that
  pushes W2 past mid-June, escalate IMMEDIATELY. The June 22
  deadline is non-negotiable; we'll find a way (alt provider,
  Massive support contract) but we need lead time.
- **Drafting PR-2.** W1 PR is draft. W2/W3 PR is ready-for-review.

═══════════════════════════════════════════════════════════════════
BOOTSTRAP — Chad pastes everything below into a fresh Claude chat
═══════════════════════════════════════════════════════════════════

You're an executor agent for Phase 4w of the TradeIQ project at
DavisDelivery/TradeIQ. This is its own phase — you do Phase 4w only.
The W1c agent (PR #53, earnings + insider), W1b agent (PR #52,
russell2k), and Phase 6 agent (comprehensive stock detail panel)
are all in other hands; do not interact with them.

This is the MASSIVE FINANCIALS VX ENDPOINT MIGRATION. The vendor
Massive (TradeIQ's fundamentals data provider; possibly Polygon.io
rebranded) is sunsetting their Financials VX endpoint on Monday,
June 22, 2026. The endpoint was deprecated 2025-09-20; sunset is
the hard kill. The `getFundamentals` abstraction in
netlify/functions/shared/data-provider.ts depends on it. Without
migration: the fundamental analyst breaks across live target board
scoring AND backtest at midnight on June 22.

The migration replaces ONE endpoint with THREE: Balance Sheets,
Cash Flow Statements, Income Statements. Work happens entirely
inside `getFundamentals` — three parallel calls, assemble into the
existing return shape, consumers unchanged.

GitHub PAT (write-scoped, repo): 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

Do this:
1. mkdir -p /home/claude && cd /home/claude
2. git clone https://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@github.com/DavisDelivery/TradeIQ.git
3. cd TradeIQ
4. Read kickoffs/phase-4w-executor.md — your full procedural guide —
   then read briefs/phase-4w-brief.md — the substantive spec with
   the workstream breakdown, acceptance criteria, and the
   architectural framing.

BEFORE writing any code: read W1c's merged work (look for commits
matching "W1c" or "chronic-silent" on main). Specifically read:
- reports/phase-4t-w1c/diagnosis.md — architectural precedent
- netlify/functions/shared/insider-provider.ts (post-W1c) — the
  WithStatus pattern you'll mirror for the three new fetch helpers
- netlify/functions/shared/pit-cache.ts (post-W1c) — the
  shouldPersist predicate mechanism you'll opt into

THIS IS A TWO-PR PHASE on one branch:
- PR-1 (W1 design): probe the three new endpoints, build the field
  mapping table, probe historical depth, decide cache strategy,
  decide shouldPersist opt-ins. Commit ONLY reports/phase-4w/design.md.
  NO CODE. Open as DRAFT. Wait for orchestrator review.
- PR-2 (W2+W3 implementation + cleanup): after orchestrator
  authorises the design AND W1c W2 PR has merged. Three new fetch
  helpers + assembler + tests + cleanup script. Open ready-for-review.

Constraints (non-negotiable):
- getFundamentals return shape must be BYTE-EQUIVALENT to
  pre-migration (golden-reference test)
- No new dependencies
- No VX-fallback path (VX is dead June 22; don't write defensive
  fallback code)
- Do NOT silently drop any VX field that has no new-endpoint
  equivalent — surface to orchestrator first
- Do NOT modify runFundamentals scoring math (read-only)
- Do NOT touch other analyst paths, the backtest engine, W1b/W1c
  territory, Phase 6 frontend, or recovery code
- WithStatus pattern from W1c for all three new fetch helpers
- shouldPersist: (v) => v !== null on all three new cache wraps
- W1 ships diagnosis-only PR; no code; orchestrator reviews before
  W2

Hard deadline: Monday, June 22, 2026 (sunset day).
Internal target: merge to main by EARLY JUNE 2026 for 2-3 weeks
buffer.

If W1 surfaces complexity that would push W2 past mid-June,
escalate immediately. The deadline is non-negotiable; we'll find a
way but need lead time.

PREREQUISITE: Chad must have confirmed his Massive plan covers the
new Fundamentals endpoints (Stocks Advanced or Stocks Financials
Add-on, or org tier equivalent). If your first probe call to
massive.com returns a 401/403 plan-access error, STOP and surface to
orchestrator — the prerequisite wasn't cleared.

If commits fail from /home/claude/TradeIQ, relocate to
/home/user/TradeIQ or /tmp. Start with PART 2 (cold start) once
you've read both files. ~2-4 hour W1 session; W2+W3 is a separate
session of ~4-7 hours after the W1c gate clears.
