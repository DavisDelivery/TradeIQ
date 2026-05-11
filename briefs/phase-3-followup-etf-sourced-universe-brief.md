# Phase 3 Follow-up Brief (REPLACES Earlier Briefs) — Universe History via ETF Sponsors

You are running the corrected universe-history backfill. Earlier briefs reached for Wikipedia as a free source of historical S&P 500 / NDX constituents — that was the wrong call. **Wikipedia is not an acceptable data source for a trading app:** no SLA, anyone can edit, parse fragility, no audit trail, not what any real desk uses, and indefensible in any institutional review.

This brief replaces both prior follow-ups (the broader and the Russell-only). All four index histories are sourced from **ETF sponsors as vendors of record** — the firms contractually obligated to track these indices for billions in AUM:

| Index | ETF | Sponsor | URL |
|---|---|---|---|
| S&P 500 | SPY | State Street (SSGA) | ssga.com |
| NDX | QQQ | Invesco | invesco.com |
| Dow | DIA | State Street (SSGA) | ssga.com |
| Russell 2000 | IWM | iShares (BlackRock) | ishares.com (confirmed reachable) |

Additionally, this brief **rips out the Wikipedia code paths from `scripts/generate-universe-history.ts`** so they cannot be accidentally invoked again. Wikipedia URLs and parsing logic exit the repo.

One PR. ETF-sponsor data only. Wikipedia gone.

---

## What you are working on

**Repo.** `github.com/DavisDelivery/TradeIQ`
**Source branch.** `main` (Phase 3 already merged at `bd677f9`, v0.12.0-alpha live)
**Your branch.** `phase-3-followup-etf-sourced-universe`
**Files modified.**
- `scripts/generate-universe-history.ts` — rip Wikipedia, add SSGA + Invesco
- `netlify/functions/shared/universe-history.ts` — regenerated output
- `docs/UNIVERSE_HISTORY_RUNBOOK.md` — updated source table + Wikipedia decommissioning note
- `docs/POINT_IN_TIME_AUDIT.md` — add "Universe constituents (ETF sponsor)" row, remove any Wikipedia reference

---

## Preconditions — verify all four sources before writing code

The original agent's environment had Wikipedia + iShares both blocked. Second attempt confirmed iShares is reachable. We do not know yet if SSGA or Invesco are reachable from your environment.

```bash
curl -sS -o /dev/null -w "ishares (IWM):    %{http_code}\n" \
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"

curl -sS -o /dev/null -w "ssga (SPY):       %{http_code}\n" \
  "https://www.ssga.com/us/en/individual/etfs/spy-spdr-sp-500-etf-trust"

curl -sS -o /dev/null -w "ssga (DIA):       %{http_code}\n" \
  "https://www.ssga.com/us/en/individual/etfs/dia-spdr-dow-jones-industrial-average-etf-trust"

curl -sS -o /dev/null -w "invesco (QQQ):    %{http_code}\n" \
  "https://www.invesco.com/qqq-etf/en/home.html"
```

**Gate:**
- All 200: proceed with all four sources.
- iShares + SSGA reachable, Invesco blocked: proceed with SP500/DIA/IWM; NDX stays at current seed; document.
- Any other partial state: proceed with what's reachable; document the gaps honestly.
- All four blocked: STOP, surface to user. This whole brief is wasted in this environment.

Report the reachability table in your first response back to the user before doing any work.

---

## Important reality check on historical depth

ETF sponsors reliably publish **current** holdings via downloadable CSV. **Historical depth varies:**

- iShares: offers "Holdings History" — daily snapshots back years. Best case.
- SSGA: may only expose recent (last quarter or so) holdings in their downloadable format. The deep historical archive often requires a different access path (sometimes Excel files in fund documents, sometimes only available via Bloomberg/SS&C).
- Invesco: similar to SSGA — current holdings well-served, historical depth less guaranteed.

**This is unknown until you check.** Verify in W1 what historical depth each sponsor actually exposes via free public download before writing the scrape. If a sponsor only gives you 90 days, that's the honest limit for that index — note it in the runbook and ship it. **Do not look elsewhere for deeper history. Especially not Wikipedia.**

If we discover SSGA/Invesco historical depth is genuinely thin (< 24 months), the right move is a paid vendor (Sharadar, Norgate, Polygon CRSP) — not unofficial sources. Surface that finding to user so they can make the buy/skip call.

---

## Credentials

```
GITHUB_PAT=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
```

---

## Required tools

`bash_tool`, `str_replace`, `create_file`, `view`. This brief modifies code (the generator) — not just data.

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
git checkout -b phase-3-followup-etf-sourced-universe
npm ci --silent
```

---

## Workstreams

### W1 — Reachability + depth audit (before any code)

Run the curl preconditions above. For each reachable sponsor, probe their actual holdings endpoint to discover the data format and historical depth available:

```bash
# Find iShares IWM holdings download URL (likely a CSV linked from the fund page)
curl -sS "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf" \
  | grep -oE 'href="[^"]*holdings[^"]*"' | head -5

# SSGA SPY holdings (look for CSV/Excel download links)
curl -sS "https://www.ssga.com/us/en/individual/etfs/spy-spdr-sp-500-etf-trust" \
  | grep -oE 'href="[^"]*\.(csv|xlsx|xls)[^"]*"' | head -10

# Invesco QQQ holdings
curl -sS "https://www.invesco.com/qqq-etf/en/home.html" \
  | grep -oE 'href="[^"]*\.(csv|xlsx|xls)[^"]*"' | head -10
```

Document findings:
- Where does each sponsor expose holdings?
- What format (CSV / Excel / JSON)?
- What date range is freely downloadable?
- Is there a "holdings as of date X" parameter or only current?

Surface findings to user before writing scrapers. If SSGA / Invesco are current-only (no historical), user decides whether to ship current-only for those indices or buy a paid vendor source.

### W2 — Rip Wikipedia code paths out of the generator

Open `scripts/generate-universe-history.ts`. Find every:
- URL containing `wikipedia.org`
- Function or fetcher named `wikipedia`, `wiki`, or similar
- Parser keyed to Wikipedia's table HTML structure
- Comment referencing Wikipedia

Delete all of them. The script's source-routing should now only know about ETF sponsors.

If the Wikipedia code is structured as a fallback (i.e., "try ETF source first, fall back to Wikipedia"), the fallback path goes too. We're not falling back to Wikipedia — we're falling back to documenting that the data isn't available.

After ripping, the script should still typecheck and the existing Dow hand-curated data should remain in `universe-history.ts` (the brief in W4 will replace Dow with DIA source if SSGA covers it).

Commit this as a discrete commit so the rip-out is reviewable on its own.

### W3 — Add ETF sponsor sources to the generator

For each reachable sponsor from W1, add a fetcher to the generator. Pattern:

```ts
async function fetchSpyHoldingsCsv(asOfDate?: string): Promise<{ ticker: string; weight?: number }[]> {
  // SSGA's actual download endpoint, discovered in W1
  const url = '...';  // canonical SSGA CSV URL
  const headers = {
    'User-Agent': 'TradeIQ/0.12 (chad@davisdelivery.com) Phase-3 universe-history backfill',
    'Accept': 'text/csv,application/octet-stream',
  };
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`SSGA SPY ${res.status}`);
  const csv = await res.text();
  return parseSsgaHoldingsCsv(csv);
}
```

**Per-sponsor fetchers:**

- `fetchIwmHoldingsCsv(asOfDate?: string)` — iShares IWM → Russell 2000
- `fetchSpyHoldingsCsv(asOfDate?: string)` — SSGA SPY → S&P 500
- `fetchDiaHoldingsCsv(asOfDate?: string)` — SSGA DIA → Dow
- `fetchQqqHoldingsCsv(asOfDate?: string)` — Invesco QQQ → NDX

Each parses its sponsor's CSV format (each is slightly different — column names, encoding, header rows). Use a per-sponsor parser. Don't try to write one universal CSV parser; ETF holdings CSVs are not standardized.

**Identifying yourself in the User-Agent.** ETF sponsors are unlikely to block legitimate traffic, but identify the request so if there's ever a rate-limit conversation, the IP-to-purpose mapping is clear.

**Historical date parameter.** If a sponsor supports `?date=YYYY-MM-DD` or similar on their holdings download (iShares does for some funds), expose that as `asOfDate` in the fetcher. If they only expose current, the fetcher only returns current.

### W4 — Generator orchestration

The script's top-level should now loop:

```ts
const SOURCES = [
  { index: 'sp500',    fetcher: fetchSpyHoldingsCsv, vendor: 'State Street (SPY)' },
  { index: 'ndx',      fetcher: fetchQqqHoldingsCsv, vendor: 'Invesco (QQQ)' },
  { index: 'dow',      fetcher: fetchDiaHoldingsCsv, vendor: 'State Street (DIA)' },
  { index: 'russell2k',fetcher: fetchIwmHoldingsCsv, vendor: 'iShares (IWM)' },
];

for (const { index, fetcher, vendor } of SOURCES) {
  for (const monthEnd of monthEndsForCoverage()) {
    try {
      const holdings = await fetcher(monthEnd);
      snapshots.push({ date: monthEnd, index, tickers: holdings.map(h => h.ticker).sort() });
    } catch (err) {
      log(`${index} ${monthEnd} fetch failed: ${err}; skipping`);
      // Continue — partial coverage is acceptable; do not synthesize.
    }
  }
}
```

If a sponsor only exposes current holdings (no historical), the loop will only produce one row for that index. That's the truthful state. Document in the runbook.

### W5 — Run the generator

```bash
npx tsx scripts/generate-universe-history.ts 2>&1 | tee /tmp/generator.log
```

Watch the log:
- Sponsor reachability + format-parse success per source
- Per-index, per-month snapshot count
- Any errors (logged + continued, not fatal)

### W6 — Validate output

```bash
# Per-index snapshot count
grep -E "^\s*\{" netlify/functions/shared/universe-history.ts \
  | grep -oE "index: '[^']+'" | sort | uniq -c

# Sanity checks
npm test -- universe-history 2>&1 | tail -10

# Spot-check known historical names
node -e "
const { wasInIndexOnDate, tickersInIndexOnDate } = require('./netlify/functions/shared/universe-history');
console.log('SP500 size 2024-01-31:', tickersInIndexOnDate('sp500', '2024-01-31').length);
console.log('AAPL sp500 2024-01-31:', wasInIndexOnDate('AAPL', 'sp500', '2024-01-31'));
console.log('NDX size 2024-01-31:', tickersInIndexOnDate('ndx', '2024-01-31').length);
console.log('Russell2k size 2024-01-31:', tickersInIndexOnDate('russell2k', '2024-01-31').length);
console.log('Dow size 2024-01-31:', tickersInIndexOnDate('dow', '2024-01-31').length);
"
```

Expected sizes:
- SP500: ~500 (it's 503 currently because of dual-class stocks, but ~500 is the right ballpark)
- NDX: 100
- Russell2k: ~1900–2000
- Dow: 30

If any count is wildly off, surface to user with the actual data.

### W7 — Update docs

`docs/UNIVERSE_HISTORY_RUNBOOK.md`:
- Replace the source table to reflect ETF-sponsor sourcing
- Add a "Why not Wikipedia?" subsection explaining the decision (no SLA, parse fragility, audit/compliance posture, not what real desks use)
- Document actual depth achieved per sponsor

`docs/POINT_IN_TIME_AUDIT.md`:
- Add a "Universe constituents" row noting the vendor-of-record sourcing
- Remove any prior Wikipedia mentions if present

### W8 — Typecheck + build + commit + PR

```bash
npx tsc --noEmit
npm run build 2>&1 | tail -3
npm test 2>&1 | tail -5      # all 182+ tests still green
```

Commits (granular):
- `phase-3-fix(rip): remove Wikipedia code paths from universe-history generator`
- `phase-3-fix(ssga): add SPY + DIA holdings fetchers for SP500 + Dow`
- `phase-3-fix(invesco): add QQQ holdings fetcher for NDX`
- `phase-3-fix(ishares): IWM holdings fetcher refactored into the new pattern`  *(if needed)*
- `phase-3-fix(universe-history): regenerated from ETF sponsors; <coverage>`
- `phase-3-fix(docs): runbook + audit doc updated; Wikipedia explicitly decommissioned`

```bash
git push origin phase-3-followup-etf-sourced-universe

curl -sS -X POST \
  -H "Authorization: Bearer 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" \
  -H "Accept: application/vnd.github+json" \
  https://api.github.com/repos/DavisDelivery/TradeIQ.git/pulls \
  -d "$(jq -n \
    --arg title 'Universe history: ETF-sponsor sourcing (Wikipedia removed)' \
    --arg head 'phase-3-followup-etf-sourced-universe' \
    --arg base 'main' \
    --arg body 'Phase 3 follow-up correcting an orchestrator-level error. Original Phase 3 brief reached for Wikipedia as a free source for SP500/NDX historical constituents. Wikipedia is not an acceptable data source for a trading app (no SLA, parse fragility, no audit trail, not vendor-of-record). This PR rips out the Wikipedia code paths and replaces them with ETF-sponsor sourcing: SSGA for SPY (SP500) and DIA (Dow), Invesco for QQQ (NDX), iShares for IWM (Russell 2000). Each sponsor is vendor-of-record for its ETF, contractually obligated to track its index accurately. Historical depth varies per sponsor — actual coverage and any gaps documented in the runbook honestly. No fake data, no Wikipedia, no version bump (pure data extension within Phase 3 deploy scope).' \
    '{title: $title, head: $head, base: $base, body: $body}')"
```

Capture PR number, report to user.

---

## Out of scope

- **No Wikipedia.** This is the entire point of the brief.
- No paid-vendor integration (Sharadar / Norgate / CRSP). If historical depth from ETF sponsors falls short, user makes the buy/skip call separately.
- No script modifications beyond W2 (rip-out) and W3 (ETF fetchers).
- No version bump.
- No hand-editing of `universe-history.ts`.
- No merging the PR.
- Nothing Phase 4.

---

## What to do if blocked

- **All four ETF sponsor sources unreachable from your env.** STOP. Report state. This whole brief assumes at least one sponsor is reachable.
- **Sponsor exposes only current holdings, no historical.** Acceptable. Ship current. Document in runbook. Surface to user so they can decide on a paid-vendor follow-up.
- **CSV format parse failure.** Save the raw response to `/tmp/<sponsor>-raw.csv`, surface to user with the actual bytes so they can update the parser in a separate brief. Don't guess at the format.
- **Sponsor returns 403 / Cloudflare challenge.** Try with a more browser-like User-Agent; if still blocked, document as "blocked from this env" and continue with reachable sponsors only.
- **You discover Wikipedia code that's deeply entangled and can't be cleanly ripped.** Rip what you can, comment out the rest with `// REMOVED: Wikipedia source — see ORCHESTRATOR Phase 3 follow-up. Do not re-enable.` Don't leave dead URLs in code.

---

## Report back

End your turn with:
- Sponsor reachability table (all 4 sources, HTTP status)
- Historical depth discovered per sponsor (date range available)
- Wikipedia code paths removed: yes/partial/no
- Per-index snapshot count after regeneration
- Ticker count sanity checks: <SP500=…, NDX=…, Russell=…, Dow=…>
- Tests: <count green>
- Tsc / build: <clean / errors>
- PR opened: <PR number + URL>
- Any caveats

If anything in W5–W6 looks suspect, surface to user with raw data before pushing.

---

## First actions

```bash
# 1. Reachability gate — all four sponsors
curl -sS -o /dev/null -w "ishares (IWM):    %{http_code}\n" \
  "https://www.ishares.com/us/products/239710/ishares-russell-2000-etf"
curl -sS -o /dev/null -w "ssga (SPY):       %{http_code}\n" \
  "https://www.ssga.com/us/en/individual/etfs/spy-spdr-sp-500-etf-trust"
curl -sS -o /dev/null -w "ssga (DIA):       %{http_code}\n" \
  "https://www.ssga.com/us/en/individual/etfs/dia-spdr-dow-jones-industrial-average-etf-trust"
curl -sS -o /dev/null -w "invesco (QQQ):    %{http_code}\n" \
  "https://www.invesco.com/qqq-etf/en/home.html"

# Report the table to user, then proceed (or stop if all blocked).

# 2. Working tree
cd /home/claude
[ -d tradeiq ] || git clone https://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@github.com/DavisDelivery/TradeIQ.git tradeiq
cd tradeiq
git config user.email "chad@davisdelivery.com"
git config user.name "Chad Davis"
git remote set-url origin https://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@github.com/DavisDelivery/TradeIQ.git
git fetch origin
git checkout main
git pull --ff-only origin main
git checkout -b phase-3-followup-etf-sourced-universe
npm ci --silent

# 3. Inspect current generator state (what to rip out vs what to keep)
grep -n "wikipedia\|wiki" scripts/generate-universe-history.ts | head
head -80 scripts/generate-universe-history.ts
```

Then W1 (depth audit) → W2 (rip Wikipedia) → W3 (add sponsors) → W4 (orchestration) → W5 (run) → W6 (validate) → W7 (docs) → W8 (commit + PR).

---

End of brief.
