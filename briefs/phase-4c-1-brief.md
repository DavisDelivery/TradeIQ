# Phase 4c-1 — Prophet Detail Completeness Hotfix

**Author:** orchestrator
**Target version:** 0.15.1-alpha (frontend) + endpoint changes
**Dependencies:** Phase 4a + 4b-1 + 4b-2 all merged. Phase 5a brief drafted but not executed.
**Status when this brief is written:** main = `64bfe12`, APP_VERSION = `0.15.0-alpha`, 367 tests passing.

---

## Why this exists

Two bugs surfaced from a user-uploaded screenshot of the Prophet detail view (ticker PWR @ composite 63, LOW conviction):

### Bug 1 — AI Thesis missing on most picks

The Prophet detail view renders an "AI Thesis · Claude Sonnet" block conditionally on `pick.narrative` being truthy. The endpoint at `netlify/functions/prophet-picks.ts` only generates narratives for the top-N picks within a time budget (`narrateTopN`). Live prod probe confirms: rank-1 (AAPL) has a 650-char narrative; ranks 2 and 3 (CSCO, AMD) return `narrative: null`. Mid-pack picks like PWR get nothing.

The UI silently omits the entire block when `narrative` is null. From the user's perspective, the top pick has an AI thesis and every other pick mysteriously doesn't — no message, no placeholder, no way to ask for one.

Compounding factor: prod is currently serving `source: fallback-partial`, which means the snapshot scanner's narrative work isn't reaching the user — the request is doing a fresh live scan every time, which has a tight budget and runs out before narrating past the top of the list.

### Bug 2 — `0/4 beats` showing on most picks

The user reports "show 0/4 eps beats on everything." In the screenshot, the pick above PWR shows `4/4 beats`; PWR itself shows `0/4 beats`. Reasonable hypothesis: the `epsBeats` field in `catalyst.details` is populated correctly for some tickers but is null/zero/missing for most, and the UI defaults a missing value to `0/4` without distinguishing "we know it's 0" from "we don't know."

Two upstream candidates for the data issue:
- Finnhub's earnings-history endpoint returns 4 quarters by default; if the response is empty or the field path changed, all four quarter-comparison checks land as false → `0/4`.
- The catalyst layer's beat-counting code may be looking at the wrong field name (`eps`, `epsBeats`, `beats`, `epsActual`, etc.) and falling through to a default zero.

This brief solves both bugs in a single coordinated PR. Both are surface-level UX problems for end users; both compound the appearance that the Prophet board is unreliable.

---

## Operational context

- Repo: `DavisDelivery/TradeIQ`
- Netlify site: `tradeiq-alpha.netlify.app` (site ID `8e90d525-78f3-4288-9c15-8b1968e994c1`)
- Firebase project: `tradeiq-alpha`
- `GITHUB_PAT`: `<read-only-PAT, provided per session>` — Chad provides a write-scoped PAT per session.
- `ANTHROPIC_API_KEY`: already set on Netlify across all contexts; verified via env probe earlier this session.
- Conventions:
  - `APP_VERSION` bumps on every user-visible change → `0.15.1-alpha` for this PR.
  - Mobile-first, single column, phone-sized typography.
  - Never deploy from a build chat. Push to feature branch; Chad merges.
  - `tsc --noEmit`, `npm test`, `npm run build` all clean before opening the PR.

## W0 — Preconditions

1. `git fetch origin && git log --oneline -3 origin/main` — confirm at `64bfe12` or later.
2. `npm ci && npm test` — confirm 367 tests passing as baseline.
3. `npm run build` — confirm clean, capture bundle size.
4. Read `netlify/functions/prophet-picks.ts` end-to-end. Locate `narrateTopN`, `getCachedNarrative`, `generateNarrative`. Note the `MAX_NARRATIVES` and `NARRATIVE_BUDGET_MS` constants.
5. Read `netlify/functions/shared/prophet/layers/catalyst.ts` (or whichever file computes `catalyst.details.epsBeats`). Identify the exact upstream field used (Finnhub `earnings()` response shape? Polygon? something else?).
6. Read `src/ProphetView.jsx` — find the line that renders `4/4 beats` text. Confirm whether it reads `pick.catalyst.details.epsBeats` or another field, and what the fallback is when missing.

## W1 — UI honesty patch (option A from the original diagnosis)

**File:** `src/ProphetView.jsx`

When `pick.narrative` is null/empty, render a placeholder where the AI Thesis block would normally sit. Three states:

- `pick.narrative` truthy → render the existing AI Thesis block (no change).
- `pick.narrative` null AND user has not yet requested → render a small "Generate AI thesis" button (W2 will wire the action; for W1 the button is rendered but its handler is a no-op stub).
- `pick.narrative` null AND in-flight from W2's lazy endpoint → spinner.

UI treatment: matches the existing emerald-tinted block visually so the user understands the missing thesis isn't a layout glitch.

```jsx
{/* AI narrative — three states */}
{pick.narrative ? (
  <div className="border border-emerald-500/20 bg-emerald-500/5 p-3">
    <div className="flex items-center gap-2 mb-1.5">
      <Brain className="h-3 w-3 text-emerald-400" />
      <span className="text-[9px] font-mono uppercase tracking-widest text-emerald-400">
        AI Thesis · Claude Sonnet
      </span>
    </div>
    <p className="text-[12px] text-neutral-200 leading-relaxed whitespace-pre-wrap">
      {pick.narrative}
    </p>
  </div>
) : (
  <div className="border border-neutral-700/40 bg-neutral-900/30 p-3">
    <div className="flex items-center gap-2 mb-1.5">
      <Brain className="h-3 w-3 text-neutral-500" />
      <span className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">
        AI Thesis · not cached for this pick
      </span>
    </div>
    <button
      type="button"
      onClick={() => generateNarrativeForPick(pick)}
      disabled={narrativeStatus === 'loading'}
      className="text-[11px] text-emerald-400 hover:text-emerald-300 disabled:text-neutral-600 font-mono underline underline-offset-2"
    >
      {narrativeStatus === 'loading' ? 'Generating…' : '→ Generate AI thesis'}
    </button>
    {narrativeStatus === 'error' && (
      <p className="text-[10px] text-rose-400 font-mono mt-1.5">
        Failed to generate. Try again in a moment.
      </p>
    )}
  </div>
)}
```

Tests in `src/__tests__/ProphetDetail.test.jsx` (new file if no existing test for the detail block):
- Renders the AI Thesis block when `narrative` is a non-empty string.
- Renders the "Generate" placeholder when `narrative` is null.
- Clicking the button calls the generation hook.
- Loading state renders "Generating…" and disables the button.

## W2 — Lazy on-demand narration endpoint (option B)

**File:** `netlify/functions/prophet-narrate.ts` (new file)

A new endpoint that takes a single pick's identifying data and returns a freshly-generated narrative. Reuses the same Claude prompt as `generateNarrative` in `prophet-picks.ts`.

```
POST /api/prophet-narrate
Content-Type: application/json
Body: {
  ticker: string,
  composite: number,
  layers: { [name: string]: { score, pass, details } },
  conviction: string,
  flags: string[],
  direction: 'long' | 'short',
}

Response:
  200 { ok: true, narrative: string, cached: boolean }
  400 { ok: false, error: 'missing fields' }
  429 { ok: false, error: 'Anthropic budget exceeded' }   ← only if budget cap exists
  500 { ok: false, error: <msg> }
```

Implementation requirements:

1. **Reuse the narrative cache.** The endpoint must check `narrativeCache` in `prophet-picks.ts` using the same `${ticker}:${band}` key, so if `prophet-picks` already generated a narrative for this ticker at this composite band within the TTL, we return it without re-spending a Claude call. Extract the cache into `netlify/functions/shared/narrative-cache.ts` so both endpoints share it. (This is a small refactor of `prophet-picks.ts`; verify the existing `narrateTopN` still works after the extraction.)

2. **Use the existing prompt.** `generateNarrative` is currently a function inside `prophet-picks.ts`. Extract it to `netlify/functions/shared/narrative-generator.ts`. Both endpoints import from there.

3. **Anthropic call.** Use the same model + parameters as `generateNarrative`. Phase 4a hotfix removed `temperature` from the call signature (Opus 4.7 deprecated it). Verify the new endpoint uses the same Opus 4.7 model string as the existing code. Do NOT add `temperature`.

4. **Budget guard.** If the Anthropic budget cap from Phase 0's leftover list is implemented, this endpoint must respect it (return 429 when exceeded). If the budget cap is still not implemented (likely the case), surface a warning log every time the endpoint fires and document in the PR description that this endpoint can be a runaway cost if used heavily. Chad should know.

5. **Rate limit.** Defense-in-depth: track per-IP request counts in-memory (no Firestore needed) and refuse more than 30 narrations per hour from the same client. The frontend won't hit this normally; this prevents an accidental loop or scripted abuse.

6. **Redirect rule in `netlify.toml`:**
```toml
[[redirects]]
  from = "/api/prophet-narrate"
  to = "/.netlify/functions/prophet-narrate"
  status = 200
```

Tests in `netlify/functions/__tests__/prophet-narrate.test.ts`:
- 400 on missing required fields.
- Returns cached narrative when one exists (no Claude call).
- Calls Claude with the expected prompt shape when not cached.
- 500 surfaces Claude API errors readably.
- Rate-limit returns 429 after threshold.

## W3 — Frontend hook for lazy narration

**File:** `src/hooks/useGenerateNarrative.js` (new file)

Standard TanStack mutation:

```js
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '../lib/queryKeys.js';

export function useGenerateNarrative() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (pick) => {
      const r = await fetch('/api/prophet-narrate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker: pick.ticker,
          composite: pick.composite,
          layers: pick.layers,
          conviction: pick.conviction,
          flags: pick.flags,
          direction: pick.direction,
        }),
      });
      const json = await r.json();
      if (!r.ok || !json.ok) throw new Error(json.error || `HTTP ${r.status}`);
      return { ticker: pick.ticker, narrative: json.narrative };
    },
    onSuccess: ({ ticker, narrative }) => {
      // Patch the prophet picks query data so the next render shows the
      // narrative inline without a refetch.
      qc.setQueriesData(
        { queryKey: queryKeys.prophet() },
        (old) => {
          if (!old?.picks) return old;
          return {
            ...old,
            picks: old.picks.map((p) =>
              p.ticker === ticker ? { ...p, narrative } : p,
            ),
          };
        },
      );
    },
  });
}
```

`ProphetView.jsx` consumes this hook and wires `generateNarrativeForPick` from W1's stub to call `mutation.mutate(pick)`.

Tests in `src/hooks/__tests__/useGenerateNarrative.test.jsx`:
- Successful POST patches the cached prophet query with the new narrative.
- 429 surfaces as a readable error.
- 500 surfaces with the error message.

## W4 — Narrate-all in the scheduled scanner (option C)

**File:** `netlify/functions/scan-prophet-{largecap,russell,all}.ts` — three files, identical change.

Currently each scheduled scan writes a snapshot with picks but no narratives. The live `prophet-picks` endpoint then runs `narrateTopN` on the snapshot's top picks before serving. That works while the snapshot is fresh but degrades when the request happens during off-hours (live partial scan with tight budget).

The fix: when the scheduled scan completes its scoring, it narrates ALL qualified picks before calling `writeSnapshot`. The snapshot then ships with narratives embedded; the live endpoint serves them directly with zero added Claude latency.

Changes to each scan-prophet-*.ts:

```ts
// After the scan completes, before writeSnapshot:
log.info('narrating_all_picks', { count: scan.picks.length });
const narrateStart = Date.now();
await narrateAll(scan.picks, log);  // new helper in shared/narrative-generator.ts
log.info('narrated_all_picks', {
  count: scan.picks.filter(p => p.narrative).length,
  ms: Date.now() - narrateStart,
});

const { snapshotId } = await writeSnapshot('prophet', UNIVERSE, {
  ...scan,
  results: scan.picks,  // picks now include narrative field
});
```

`narrateAll` parameters:
- Iterates picks in parallel with `Promise.all` and concurrency 4 (Claude API tolerates this).
- Per-pick try/catch — one failure doesn't kill the batch; failed picks ship without a narrative and the W1+W2 lazy-load handles them.
- Global budget guard: stops if cumulative Anthropic spend approaches the configured cap (Phase 0 dependency). If no cap is in place, log a warning and proceed.
- Returns void; mutates `picks[i].narrative` in place.

**Anthropic spend impact, written down honestly:**

- Largecap universe: ~50–80 qualified picks per scan, every 30 min during 9a-5p ET M-F = ~16 scans/day × 60 picks ≈ 960 narrations/day.
- Russell universe: ~100–200 qualified picks per scan (after W2 sieve from the russell brief lands; before, much smaller) × 16 scans/day = up to ~3200 narrations/day.
- "All" universe: similar to largecap+russell combined.

Per-narration cost at current Sonnet pricing is roughly $0.001–0.003. Daily ceiling: ~$15/day during heavy usage. Monthly ceiling: ~$450/month worst case if all three universes run at max qualified-pick counts continuously.

**This brief does NOT ship W4 to production without the budget cap.** If the Phase 0 Anthropic budget cap (in `briefs/phase-0-brief.md` and friends) is still unimplemented, W4 is gated on it. The brief specifies the W4 code but the deploy plan is:

- Day 1: ship W1+W2+W3 (UI placeholder + lazy endpoint). Live narration on detail expand. Spend is bounded by user clicks.
- Day 2+: ship W4 only after the budget cap is wired and tested. Specify the cap in the PR description ($20/day initially, raise once observed usage stabilizes).

## W5 — EPS beats data bug

**Files:** `netlify/functions/shared/prophet/layers/catalyst.ts` (the layer scorer) + `src/ProphetView.jsx` (the renderer).

Diagnostic step (mandatory, before writing any fix):

1. From the agent sandbox, hit `/api/prophet-picks?universe=largecap&limit=20`. For each pick, log `pick.catalyst.details` — dump every key/value verbatim. Identify:
   - Which field name actually carries the beat count?
   - Which tickers have it populated correctly vs return 0?
   - Is the issue at the Finnhub level (raw data missing) or at our parsing (field path wrong)?

2. Compare against the source code. Look at `getFundamentals(ticker)` or whichever fetcher returns earnings history. Trace the field path from API response → catalyst layer → pick.catalyst.details. The break could be at any hop.

3. Once root cause is known, document in the PR description: which layer of the data pipeline was returning what.

Likely root causes, ranked by probability:

- **Most likely**: the catalyst layer reads `fundamentals.earnings[0..3]` and counts beats, but `fundamentals.earnings` is undefined or empty for most tickers (Finnhub free-tier limit, or schema field renamed). Default falls through to 0/4.
- **Second**: the field is populated but the beat condition uses the wrong comparator (e.g. comparing `epsActual >= epsEstimate` when both are strings, or one is null and Javascript truthy-coerces to false).
- **Third**: caching layer has stale data with the old schema.

Fix shapes:

- **If data is missing upstream**: render `— / 4 beats` (em-dash) instead of `0 / 4 beats`. Don't pretend we know the answer when we don't.
- **If data is present but comparator is wrong**: fix the comparator, add a unit test against synthetic earnings history with known beat patterns.
- **If cache is stale**: invalidate; log the schema mismatch; add a Zod schema in `netlify/functions/shared/schemas/finnhub.ts` to catch it next time.

Tests in `netlify/functions/shared/prophet/layers/__tests__/catalyst.test.ts`:
- 4 beats in 4 quarters → returns `epsBeats: 4`.
- 0 beats in 4 quarters → returns `epsBeats: 0`.
- Missing earnings history → returns `epsBeats: null` (NOT `0`).
- Mixed presence (2 quarters returned, 2 missing) → returns `epsBeats: 2` with a flag that history is incomplete.

In `src/ProphetView.jsx`, render `epsBeats === null` as `— / 4 beats` and `epsBeats === 0` as `0 / 4 beats` so the user can distinguish "we don't know" from "we know they missed."

## W6 — Version + ORCHESTRATOR + PR

- `APP_VERSION` → `0.15.1-alpha`.
- `ORCHESTRATOR.md`:
  - Row for `4c-1` (this PR), `done`, summarize W1–W5 outcomes.
  - Phase 0 leftover row for Anthropic budget cap: bump priority to `urgent` (gates W4 production deploy).
- PR description in `briefs/phase-4c-1-pr-description.md`.

## Verification

1. `npx tsc --noEmit` — clean.
2. `npm test` — passing, ≥372 (367 + ~5 new).
3. `npm run build` — clean.
4. Manual smoke test on deploy preview:
   - Navigate to Prophet board.
   - Confirm AAPL (rank 1) shows AI Thesis as before.
   - Confirm CSCO, AMD, PWR (mid-rank) show the placeholder "→ Generate AI thesis" button.
   - Click the button. Confirm spinner appears, then narrative renders inline within ~3 seconds.
   - Confirm a refresh of the page preserves the narrative (cached via TanStack `setQueriesData`).
   - Confirm "0/4 beats" picks now render `— / 4 beats` if upstream data is missing, OR an honest beat count if data is present and the comparator bug was the issue.
5. Sentry log review: no new errors from the narrate endpoint or the catalyst layer changes.

## Out of scope

- **Narrate-all in scheduled scanner (W4) does not deploy in this PR.** W4 code lands behind the budget cap; deploy in a follow-up after Anthropic budget cap is wired.
- **Anthropic budget cap implementation** is its own brief. This PR documents the dependency.
- **The russell sieve architecture** is its own brief (`briefs/phase-4c-2-brief.md`). The two are independent.
- **Visual redesign of the prophet detail layout** — no.
- **Adding new analyst layers** — Phase 6+.

## Files target

```
netlify/functions/prophet-narrate.ts                 NEW   ~110 lines
netlify/functions/shared/narrative-cache.ts          NEW   ~40 lines  (extracted)
netlify/functions/shared/narrative-generator.ts      NEW   ~80 lines  (extracted)
netlify/functions/prophet-picks.ts                   edit  ~20 lines  (use extracted modules)
netlify/functions/scan-prophet-largecap.ts           edit  ~10 lines  (W4 code, gated)
netlify/functions/scan-prophet-russell.ts            edit  ~10 lines  (W4 code, gated)
netlify/functions/scan-prophet-all.ts                edit  ~10 lines  (W4 code, gated)
netlify/functions/shared/prophet/layers/catalyst.ts  edit  varies     (depends on W5 root cause)
netlify/functions/__tests__/prophet-narrate.test.ts  NEW   ~120 lines
netlify/functions/shared/prophet/layers/__tests__/catalyst.test.ts  NEW   ~80 lines
netlify.toml                                          edit  ~6 lines  (redirect)
src/components/ProphetDetail*.jsx OR src/ProphetView.jsx  edit  ~50 lines  (UI states)
src/hooks/useGenerateNarrative.js                    NEW   ~40 lines
src/hooks/__tests__/useGenerateNarrative.test.jsx    NEW   ~80 lines
src/__tests__/ProphetDetail.test.jsx                 NEW   ~80 lines
src/App.jsx                                           edit  1 line   (APP_VERSION)
ORCHESTRATOR.md                                       edit  4c-1 row + Phase 0 budget cap bump
briefs/phase-4c-1-pr-description.md                  NEW
```

~16 files, ~700 lines net. Mid-size PR.

## Note to the executing agent

The big trap on this brief is shipping W4 (narrate-all in scanner) without the budget cap. Don't. The Anthropic API key has no per-day cap configured in their dashboard by default — a runaway scan loop could rack up real money in hours. W1+W2+W3 ship freely because user clicks bound the spend; W4 is unbounded by default and must wait.

On W5 — the EPS bug diagnosis is what's load-bearing. If you fix the comparator without understanding why most tickers fall through to it, the fix may break differently next quarter. Document what you found in the PR description.

On the cache extraction (W2 step 1) — `prophet-picks.ts` is the most-touched file in this repo. The extraction must preserve the existing `narrateTopN` behavior exactly. Run the prophet endpoint tests both before and after the refactor to catch any drift.
