# Phase 3 Follow-up Brief — Universe History Backfill

You are running a small follow-up to the Phase 3 PR (`phase-3-point-in-time-data`, currently open as PR #5). Phase 3's universe history shipped Dow at full spec but SP500 / NDX / Russell2k at current-seed only because the original Phase 3 agent's environment had egress blocks to Wikipedia and iShares. Your job is to run the existing generator script in an unrestricted environment, verify the output meets the brief spec, and commit the regenerated `universe-history.ts` to the same branch so it ships with the Phase 3 PR.

This is one workstream, not a phase. No new code. No new tests. No version bump. ≤30 minutes if Wikipedia and iShares cooperate.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Branch.** `phase-3-point-in-time-data` (open as PR #5, not yet merged — DO NOT branch from main)
**Generator script.** `scripts/generate-universe-history.ts` (already on the branch — do not rewrite it)
**Output file.** `netlify/functions/shared/universe-history.ts` (regenerate, don't hand-edit)
**Runbook.** `docs/UNIVERSE_HISTORY_RUNBOOK.md` (already on the branch)

---

## Precondition — environment check (do this first)

Confirm your environment can reach the external sources before doing anything else. The original agent's run failed at this exact step.

```bash
curl -sS -o /dev/null -w "wikipedia: %{http_code}\n" "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
curl -sS -o /dev/null -w "ishares: %{http_code}\n" "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"
```

Both should return 200. If either is 000 / timeout / blocked, STOP — you're in the same constrained environment the original agent was. Surface to user immediately with the curl output. Do not proceed and do not synthesize fake data.

---

## Credentials (use these — do not request from user)

```
GITHUB_PAT=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
```

No other credentials needed — this workstream doesn't touch Netlify, Anthropic, or Firebase.

---

## Required tools

`bash_tool`, `view`, plus whatever the generator script needs (Node, fetch, etc. — already configured if the repo `npm ci` is clean).

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
git checkout phase-3-point-in-time-data
git pull --ff-only origin phase-3-point-in-time-data
npm ci --silent
```

Confirm you're on the right branch and the generator exists:

```bash
git rev-parse --abbrev-ref HEAD     # phase-3-point-in-time-data
ls scripts/generate-universe-history.ts
```

---

## Workstreams

### W1 — Run the generator

The script is already written by the Phase 3 agent. Don't modify it. Run as documented in `docs/UNIVERSE_HISTORY_RUNBOOK.md`:

```bash
npx tsx scripts/generate-universe-history.ts 2>&1 | tee /tmp/generator.log
```

(If `tsx` isn't on the path, use whatever the runbook prescribes — likely `npx --yes tsx ...`.)

Watch the log. The generator will report what it scraped per index. If a source fails partway through (Wikipedia revision history is sometimes rate-limited), the script may retry or fail — read the runbook's troubleshooting section.

### W2 — Validate output meets spec

After regeneration, count snapshots per index:

```bash
grep -E "^\s*\{" netlify/functions/shared/universe-history.ts \
  | grep -oE "index: '[^']+'" | sort | uniq -c
```

Expected (from the Phase 3 brief spec):

| Index | Minimum required |
|---|---|
| `dow` | ≥ 60 (already shipping at 100+) |
| `sp500` | ≥ 60 |
| `ndx` | ≥ 60 |
| `russell2k` | ≥ 24 |

If any index is below the threshold, STOP and document why in the commit message + surface to user. Do not pad with synthetic data. Partial coverage is acceptable to ship — fake data is not.

### W3 — Validate the data is sane

Two quick sanity checks before committing:

```bash
# 1. Run the existing universe-history tests against the regenerated file
npm test -- universe-history 2>&1 | tail -10
# Should be 21+ tests, all green.

# 2. Spot-check that known historical constituents are present
node -e "
const { wasInIndexOnDate } = require('./netlify/functions/shared/universe-history');
// TSLA joined S&P 500 in Dec 2020 — should be false in 2018, true in 2022
console.log('TSLA sp500 2018-01-01:', wasInIndexOnDate('TSLA', 'sp500', '2018-01-01'));
console.log('TSLA sp500 2022-01-01:', wasInIndexOnDate('TSLA', 'sp500', '2022-01-01'));
// AAPL has been in S&P 500 since the 80s
console.log('AAPL sp500 2018-01-01:', wasInIndexOnDate('AAPL', 'sp500', '2018-01-01'));
"
```

Expected output:
```
TSLA sp500 2018-01-01: false
TSLA sp500 2022-01-01: true
AAPL sp500 2018-01-01: true
```

If TSLA tests come back wrong (e.g., true in 2018), the historical scrape is broken and shipping it would be worse than shipping the current-seed-only state. Surface to user with the test output.

### W4 — Typecheck + commit + push

```bash
npx tsc --noEmit                         # must be clean
npm run build 2>&1 | tail -3             # must be clean (universe-history is imported by some functions)

git add netlify/functions/shared/universe-history.ts docs/UNIVERSE_HISTORY_RUNBOOK.md
git commit -m "phase-3(universe-history): backfill sp500/ndx/russell2k from unrestricted env

Original Phase 3 agent's environment had egress blocks to Wikipedia and
iShares. This commit runs the existing scripts/generate-universe-history.ts
in a non-restricted environment to fill in the historical coverage that
W9 specified but couldn't ship.

Coverage after this commit:
- Dow:       2018-01-31 -> 2026-04-30 monthly (100+ snapshots, unchanged)
- SP500:     <fill in actual months from W2 output>
- NDX:       <fill in actual months from W2 output>
- Russell2k: <fill in actual months from W2 output>

Verified:
- TSLA not in SP500 on 2018-01-01, in SP500 by 2022-01-01
- AAPL in SP500 throughout
- 21+ universe-history tests green
- tsc clean, build clean

Phase 4 backtest can now run on all 4 indices with survivorship-bias
correction, not just Dow. Runbook updated with refresh cadence."

git push origin phase-3-point-in-time-data
```

If coverage came in below spec on any index (e.g., SP500 only got 40 months because Wikipedia revision history is slim that far back), be explicit in the commit message about which indices fell short and by how much. The brief is OK with that — just not silent about it.

---

## Out of scope

- Modifying `scripts/generate-universe-history.ts`. If the script has bugs, document them and surface to user — don't fix here.
- Modifying `universe-history.ts` by hand. It's generator output; hand edits get lost on next regen.
- Modifying any other file. This commit touches `universe-history.ts` and the runbook only.
- Bumping `APP_VERSION`. Phase 3's bump already covers this work scope — it's part of the same Phase 3 PR.
- Merging the Phase 3 PR. User does that.
- Anything Phase 4.

---

## What to do if blocked

- **Wikipedia rate-limits or blocks.** Use a User-Agent header that identifies you (Wikipedia's rate limits are gentler for identified scrapers). The generator script may already do this — check before working around it.
- **iShares CSV download fails.** Their URL structure changes occasionally. Check the runbook for the current canonical URL. If iShares is the bottleneck, ship Wikipedia-sourced sp500 + ndx and document Russell2k gap honestly. Do NOT scrape an unofficial mirror.
- **Generator script throws.** Read the error, surface to user. Don't fix the script in this brief — that's a separate task.
- **Output looks weird** (sanity checks fail, wrong tickers in known periods). Stop. Commit nothing. Surface to user with the diff of `universe-history.ts` vs the pre-run version, so they can see what the generator produced.
- **Some indices come in below spec.** Acceptable. Document in commit message. Ship partial; don't pad.

---

## Report back

End your turn with:
- Wikipedia / iShares reachability: `<200/blocked>`
- Generator run time: `<duration>`
- Snapshot count per index after regeneration: `<table>`
- Sanity check results: `<TSLA/AAPL outputs>`
- Tests: `<count green>`
- Tsc / build: `<clean / errors>`
- Commit SHA pushed: `<sha>`
- Any caveats or partial coverage flagged in commit message

If anything in W2 / W3 / W4 failed, surface to user explicitly and do NOT push.

---

## First actions

```bash
# 1. Environment check FIRST
curl -sS -o /dev/null -w "wikipedia: %{http_code}\nishares:   %{http_code}\n" \
  "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"
curl -sS -o /dev/null -w "ishares:   %{http_code}\n" \
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"

# If either returns non-200, STOP here and surface to user.

# 2. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout phase-3-point-in-time-data
git pull --ff-only origin phase-3-point-in-time-data
npm ci --silent

# 3. Confirm the generator exists and read the runbook
cat docs/UNIVERSE_HISTORY_RUNBOOK.md
head -30 scripts/generate-universe-history.ts
```

Then proceed W1 → W2 → W3 → W4. Stop and surface to user at any failure.

---

End of brief.
