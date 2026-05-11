# ⚠️ SUPERSEDED

This brief is **superseded** by `briefs/phase-3-followup-etf-sourced-universe-brief.md`.

Reason: this brief targeted Wikipedia as a data source for historical S&P 500 / NDX constituents. Wikipedia is not acceptable for a trading app (no SLA, parse fragility, no audit trail, not vendor-of-record). The replacement brief uses ETF sponsors (State Street SPY/DIA, Invesco QQQ, iShares IWM) as vendors of record.

Do not execute this brief. Use the ETF-sourced version instead.

---

# Phase 3 Follow-up Brief (Narrowed) — Russell 2000 Universe Backfill

You attempted the broader universe-backfill brief and correctly stopped at the egress gate: Wikipedia is hostname-blocked (403) but iShares is reachable (200). This narrower brief scopes the work to **Russell 2000 only** — the index iShares serves and the one most valuable for TradeIQ's small-cap thesis (insider, political, patent, short-interest signals have most edge in small-cap names).

SP500 + NDX backfills will be handled in a separate session from a non-restricted environment. They stay at current-seed-only after this PR.

This is one workstream. ~20 minutes if iShares cooperates. Same hard rules as before: no fake data, no hand edits, no script modifications.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Source branch.** `main` (Phase 3 already merged at `bd677f9`, v0.12.0-alpha live)
**Your branch.** `phase-3-followup-russell2k-backfill` (new — create from main)
**Generator script.** `scripts/generate-universe-history.ts` (don't modify)
**Output file.** `netlify/functions/shared/universe-history.ts` (regenerate — Russell rows replaced, Dow/SP500/NDX rows preserved)
**Runbook.** `docs/UNIVERSE_HISTORY_RUNBOOK.md` (update coverage table only)

---

## Precondition — environment check

The prior attempt confirmed iShares is reachable. Re-verify, then proceed:

```bash
curl -sS -o /dev/null -w "ishares: %{http_code}\n" \
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"
```

Should return 200. If it doesn't (URL drift, blocked since last check), STOP and surface — the entire workstream depends on this single source.

Don't re-check Wikipedia. We know it's blocked. SP500/NDX/Dow are out of scope for this brief; preserve their existing entries.

---

## Credentials (use these — do not request)

```
GITHUB_PAT=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
```

---

## Required tools

`bash_tool`, `view`. Same as before.

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
git checkout -b phase-3-followup-russell2k-backfill
npm ci --silent
```

---

## Workstreams

### W1 — Inspect the generator to find the Russell-only invocation path

Read `scripts/generate-universe-history.ts`. The Phase 3 agent already coded support for partial-source failures (it shipped Dow successfully while Wikipedia was blocked). Look for either:

- A CLI flag (`--index=russell2k`, `--only russell`, etc.)
- A per-source try/catch that continues past failures
- Source-routing logic where a subset can be invoked

```bash
head -60 scripts/generate-universe-history.ts
grep -n "russell\|index" scripts/generate-universe-history.ts | head -20
```

**If a Russell-only flag exists:** use it in W2.

**If only fail-soft try/catch exists (no flag):** run the script as documented in the runbook; the Wikipedia parts will fail gracefully and Russell will be regenerated. SP500/NDX/Dow rows in the output file get re-emitted from current seed (Dow keeps its full history because the script reads the existing file for Dow as documented in the runbook — confirm this assumption by reading the script's handling of Dow).

**If neither exists** (i.e., script is structured such that one source failure aborts everything): STOP and surface to user. Modifying the script is out of scope for this brief.

### W2 — Run the generator (Russell-only path)

```bash
npx tsx scripts/generate-universe-history.ts <whatever-flag-if-any> 2>&1 | tee /tmp/generator.log
```

Watch the log. Expected behavior:
- iShares fetches succeed
- Wikipedia fetches fail with 403 (expected — log noise, not an error)
- Russell rows in the output get extended back ≥ 24 months month-end
- Dow/SP500/NDX rows preserved

### W3 — Validate output

```bash
grep -E "^\s*\{" netlify/functions/shared/universe-history.ts \
  | grep -oE "index: '[^']+'" | sort | uniq -c
```

Expected after this commit:

| Index | Required | Expected post-W3 |
|---|---|---|
| `dow` | ≥ 60 | unchanged (100+) |
| `sp500` | ≥ 60 | unchanged (1) — out of scope |
| `ndx` | ≥ 60 | unchanged (1) — out of scope |
| `russell2k` | ≥ 24 | should now meet spec |

If Russell didn't land ≥ 24 month-end snapshots, surface to user with the actual count. Acceptable to ship partial if iShares simply doesn't go back far enough; not acceptable to ship synthesized.

### W4 — Sanity check the data

```bash
# Tests
npm test -- universe-history 2>&1 | tail -10

# Spot-check known Russell historical names
node -e "
const { wasInIndexOnDate, tickersInIndexOnDate } = require('./netlify/functions/shared/universe-history');
// Count tickers in Russell 2000 at a known historical month
const tickers2023 = tickersInIndexOnDate('russell2k', '2023-12-31');
console.log('Russell2k tickers on 2023-12-31:', tickers2023.length);
// Should be in the 1800-2000 range — Russell rebalances to ~2000 each June

// Verify a name that's been in Russell for a while
console.log('OPCH russell2k 2023-12-31:', wasInIndexOnDate('OPCH', 'russell2k', '2023-12-31'));
"
```

Expected:
- Russell2k 2023-12-31 ticker count: somewhere in 1800-2000 range
- Tests: 21+ green (no test breakage from data extension)

If counts are wildly off (e.g., 50 tickers) or tests fail, STOP and surface. Don't commit broken data.

### W5 — Typecheck + build + commit

```bash
npx tsc --noEmit                         # clean
npm run build 2>&1 | tail -3             # clean

git add netlify/functions/shared/universe-history.ts docs/UNIVERSE_HISTORY_RUNBOOK.md
git commit -m "universe-history: backfill russell2k from iShares (sp500/ndx remain seed-only)

Narrow follow-up to Phase 3. Original agent's environment had egress
blocks to BOTH Wikipedia and iShares; first attempt at the broader
backfill confirmed iShares is now reachable from this env but Wikipedia
remains hostname_blocked (403). This commit extends Russell 2000
coverage only — the index most material to TradeIQ's small-cap thesis.

Coverage after this commit:
- Dow:       2018-01-31 -> 2026-04-30 monthly (unchanged)
- SP500:     2026-04-30 only (unchanged — Wikipedia blocked)
- NDX:       2026-04-30 only (unchanged — Wikipedia blocked)
- Russell2k: <fill in actual months from W3 output>

SP500 + NDX backfill is a separate workstream from a non-restricted
environment (user's local machine or another agent session).

Verified:
- Russell2k 2023-12-31 ticker count: <fill in>
- 21+ universe-history tests green
- tsc clean, build clean"
```

### W6 — Push + open PR

```bash
git push origin phase-3-followup-russell2k-backfill

curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ/pulls \
  -d "$(jq -n \
    --arg title 'Universe history: Russell 2000 backfill from iShares' \
    --arg head 'phase-3-followup-russell2k-backfill' \
    --arg base 'main' \
    --arg body 'Narrowed Phase 3 follow-up. iShares is reachable from this env but Wikipedia remains hostname_blocked (verified). Russell 2000 backfilled to spec; SP500 + NDX remain at current seed only and will be handled in a separate follow-up from an unrestricted environment. Only modifies universe-history.ts and the runbook coverage table. No logic changes, no test changes, no version bump. CI gates the regenerated Russell data against the existing 21+ universe-history tests.' \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

Capture and report the PR number.

---

## Out of scope

Same as the broader brief:
- No script modifications
- No hand edits to `universe-history.ts`
- No version bump
- No SP500 / NDX work (Wikipedia blocked here)
- No merging the PR (user does after CI green)
- Nothing Phase 4

---

## What to do if blocked

- **Generator script aborts on Wikipedia failure** (no fail-soft, no flag). Stop, surface to user with the error. Do not patch the script.
- **iShares 200 but data parse fails.** Their CSV format occasionally changes. Surface to user with the response body so they can update the script in a separate brief.
- **Russell coverage comes in below 24 months.** Acceptable to ship partial. Document in commit message; user decides if it's enough.

---

## Report back

- iShares reachability: `<200/other>`
- Generator run time: `<duration>`
- Russell2k snapshot count after regeneration: `<number>`
- Other indices preserved as-is: `<yes/no>`
- Tests: `<count green>`
- Tsc / build: `<clean / errors>`
- PR opened: `<PR number + URL>`

---

## First actions

```bash
# Re-verify iShares (Wikipedia known blocked, don't bother)
curl -sS -o /dev/null -w "ishares: %{http_code}\n" \
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"

# If 200, proceed. If not, STOP.

cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-3-followup-russell2k-backfill
npm ci --silent

# Inspect the generator to figure out the Russell-only invocation
head -60 scripts/generate-universe-history.ts
grep -n "russell\|index" scripts/generate-universe-history.ts | head -20
```

Then proceed W2 → W3 → W4 → W5 → W6.

---

End of brief.
