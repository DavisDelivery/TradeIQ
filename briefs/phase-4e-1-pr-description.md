# Phase 4e-1 — Prophet Portfolio: engine + backtest validation

**Verdict:** PENDING LIVE-DATA RUN — see `reports/phase-4e-1/backtest-validation.md`
**Layers active:** unknown (audit pending; § 0 of the report)

This PR lands the Prophet Portfolio engine, the rebalance rule (v1, per
`briefs/phase-4e-1-brief.md`), the backtest harness + CLI, the daily
mark-to-market function, the read endpoint, the forward-return
populator, and the binding verdict report — all wired to ship dormant
because the executor session had no production credentials
(`FIREBASE_SERVICE_ACCOUNT` + `POLYGON_API_KEY`) to populate the W0
layer-activity audit or run the W4 historical backtest. The live
scheduled rebalance function (`scan-prophet-portfolio-rebalance.ts`)
is intentionally **NOT** included in this PR — it ships in a follow-up
once the verdict in `backtest-validation.md` flips to SHIP / SHIP WITH
CAVEATS per the brief's W5 gate. APP_VERSION bumps to `0.16.1-alpha`
(engine landed, manager not active).

## What's in this PR

**New engine modules** under `netlify/functions/shared/prophet-portfolio/`:
- `types.ts` — shared types (state, config, swap, decision, signal interface)
- `state.ts` — Firestore CRUD for `prophetPortfolio/{universe}/` collections (state, swaps, equityCurve, decisionLog)
- `signal.ts` — pluggable `RankingSignal` interface + `compositeRankingSignal` (`composite-v1`); 5b's ML signal will export the same interface and slot in with zero rebalance refactor
- `rebalance.ts` — pure `decideRebalance` function encoding the v1 rule (forced exits on earnings-gate fail, drop-outs with 30-day min-hold, swap budget = 3, sector cap = 4, equal-weight 10%); 10 brief-spec test cases all green
- `backtest-harness.ts` — orchestrator that walks a `[start, end]` window stepping through rebalances, applying the rule, marking equity, computing Sharpe / max DD / excess vs SPY / QQQ / IWF / cost drag; data is injected via `PriceSource` + `RankingSignal` so the harness is unit-testable and the CLI fails loud-and-clear when credentials are missing
- `decision-log.ts` — `buildDecisionLogRows` (W8 writer; emits ADD / EXIT / HOLD_IN / HOLD_OUT rows for every rebalance) + `computeForwardReturns` (used by the daily fwd-returns scan)

**New scheduled / HTTP functions:**
- `netlify/functions/prophet-portfolio.ts` — `GET /api/prophet-portfolio?universe=largecap` returns persisted state + last 20 swaps + last 252-day equity curve + on-the-fly window metrics (sinceInception / YTD / last1y). 5-minute in-memory cache; 405 on POST; 400 on unknown universe.
- `netlify/functions/scan-prophet-portfolio-mtm.ts` — weekday 21:00 UTC mark-to-market. No-op pre-W5 (no state to mark).
- `netlify/functions/scan-prophet-portfolio-fwd-returns.ts` — daily 21:00 UTC populator for `forwardReturn30d/60d/90d` on decisionLog rows.

**CLI runner:**
- `scripts/run-portfolio-backtest.ts` — `npx tsx scripts/run-portfolio-backtest.ts --window full` (and `half-2018`, `half-2022`, `covid`, `rate-hikes`, `rolling-YYYY`). Fails fast with exit code 2 when `FIREBASE_SERVICE_ACCOUNT` or `POLYGON_API_KEY` is unset — no half-baked numbers shipped to the verdict report.

**Wiring:**
- `netlify.toml` — one new redirect (`/api/prophet-portfolio` → function)
- `src/lib/validateResponse.js` — new `prophetPortfolio` response shape
- `src/App.jsx` — `APP_VERSION` → `0.16.1-alpha`
- `ORCHESTRATOR.md` — 4e (placeholder) → 4e-1 (done, engine dormant) + 4e-1-finish (pending live-data run) + 4e-2 (pending, no brief yet)
- `reports/phase-4e-1/backtest-validation.md` — verdict PENDING, with a complete "how to populate" runbook so the live-data follow-up is mechanical

## What's NOT in this PR (intentional, per brief)

- **W5 — `scan-prophet-portfolio-rebalance.ts`:** the brief's W5 spec says ONLY built if backtest verdict is SHIP or SHIP WITH CAVEATS. PENDING is treated identically to DON'T SHIP for this gate; W5 lands in a follow-up.
- **UI tab:** Phase 4e-2 territory. The engine + endpoint are wired so the UI can be built on top without touching backend code.
- **MODEL_VERSION bump:** scoring math is unchanged. Holds at `2026.02.0`.

## Why PENDING and not DON'T SHIP

DON'T SHIP implies the brief's W4 was executed and the rule was
disqualified. Neither happened. Marking it DON'T SHIP would
mis-represent why W5 is being held — the rule has not yet been tested.
The verdict report (§ "Why this verdict is PENDING and not DON'T SHIP")
documents this explicitly so Chad can read it cold.

## Verification

- `npx tsc --noEmit` — clean
- `npm test` — passing, 446 → 486 (12 W1 state + 12 W2 signal + 10 W3 rebalance + 7 W4 harness + 4 W6 mtm + 7 W7 endpoint + 9 W8 decisionLog + 5 W8 fwd-returns = **66 new tests** vs. the brief's 15–25 target; the extra coverage is mostly on the data-shape boundaries between the new modules)
- `npm run build` — clean (953 kB chunk warning is the pre-existing one)

## Smoke test (deploy preview, post-merge)

The PR includes a `GET /api/prophet-portfolio` endpoint and a redirect.
Pre-cron (and forever in this PR's deployed state, since W5 doesn't
exist yet) the endpoint will return:

```json
{
  "ok": true,
  "universe": "largecap",
  "state": null,
  "swaps": [],
  "equityCurve": [],
  "metrics": {
    "sinceInception": { "portfolioReturnPct": 0, "spyReturnPct": 0, "excessReturnPct": 0, "sharpe": 0, "maxDDPct": 0, "days": 0 },
    "ytd": { ... same shape ... },
    "last1y": { ... same shape ... }
  },
  "generatedAt": "<ISO>"
}
```

POST should return 405; `?universe=bogus` should return 400; `?universe=russell2k` should return 200 with `state: null` (forward-compatible — universe is in the schema for 4e-2's eventual rollout).

## Next steps

1. Run `scripts/run-portfolio-backtest.ts` with credentials set in a
   secure environment.
2. Populate `reports/phase-4e-1/backtest-validation.md` § 0–§ 5 from
   the JSON outputs.
3. Flip the verdict at the top.
4. If SHIP / SHIP WITH CAVEATS → file 4e-1-finish PR with
   `scan-prophet-portfolio-rebalance.ts` (W5) and APP_VERSION bump to
   `0.17.0-alpha`.
5. If DON'T SHIP → file `briefs/phase-4e-1-fix-brief.md` with a
   specific v2 rule revision.

The decisionLog writer is wired so that whenever W5 ships, Phase 5c
(monitoring + retraining) gets training data from day 1 — every day
without it delayed is another day of missing rows.
