# BROKER-1 — execution-path hardening + attribution

**Campaign:** BROKER-1
**Status:** brief, awaiting executing agent
**Author:** orchestrator session, 2026-08-12
**Basis:** live read-only Robinhood MCP calls (accounts / portfolio / positions / orders) + repo read at `26a0b0f`
**Full audit:** the findings below are condensed. Long form with evidence: `reports/broker-1/integration-audit.md` (added by W0 of this brief).

---

## W0 — Unmerged-work resolution pass (do this first)

1. `gh pr list --state open` — **at brief time there were ZERO open PRs.** If that has changed, read each before branching; this brief touches `broker-execute.ts`, `shared/robinhood.ts`, `verdicts.ts`, `StockDetailHero.jsx`, `Sidebar.jsx`, `MobileDrawer.jsx`. Any open PR touching those is a genuine conflict — resolve before starting.
2. There are ~30 stale `claude/*` branches. Ignore them; branch from `main`.
3. Confirm `main` is green (`npx tsc --noEmit && npm test && npm run build`) BEFORE any change, so a pre-existing failure isn't attributed to this work.
4. Copy this brief's audit into `reports/broker-1/integration-audit.md` (content supplied alongside this brief) so the evidence lives in the repo, not just in chat.

---

## Why this campaign exists

`OrderButtons` → `OrderTicket` → `POST /api/broker-execute` places **real money orders**. That path was built fast and never got the measurement discipline the rest of this repo enforces. Compare `stop-watch.ts`, which refuses to serve an empty list without a freshness stamp because *"a watcher the app cannot tell is dead is worse than no watcher."* The execution path has no equivalent guarantee about **which account it trades**, **how much it can spend in a day**, or **whether its journal reflects reality**.

Second driver: `reports/research-2026-08/board-trust-audit.md` concludes backtesting is exhausted as an instrument (≈10 years to separate one board from SPY, ≈48 board-vs-board; a 3-year re-slice is *"noise wearing a table"*). Every board is `NO_EDGE`, `PENDING`, or unregistered. **Live attributed trading is the only measuring instrument left** — and it only works if orders are attributable, which today they are not.

---

## Findings this brief closes

| # | Finding | Severity |
|---|---------|----------|
| F1 | `getAccount()` returns `results[0]` — nothing pins WHICH of 4 accounts is traded | **critical** |
| F2 | Agentic account co-mingled with manually-bought positions the agent could liquidate | **critical** |
| F8 | Buy renders without a VerdictChip on boards lacking a thesis/research panel | **high** |
| F5 | `PER_ORDER_CAP` is the only quantitative limit — no daily/aggregate/position caps | medium |
| F7 | Journal written at placement; nothing reconciles broker order state back | medium |
| F6 | No pre-trade validation (buying power, halt, PDT) | medium |
| F3/F4 | Private-API path is unsanctioned, and tags orders `placed_agent:user` → unattributable | high (spike only) |

---

## W1 — Verdict enforcement on every order surface (ship first, smallest)

This is the roadmap item already scoped in `reports/research-2026-08/tradeiq-roadmap.html`. It ships **first** because it is the last thing standing between a `NO_EDGE` board and a real order, and it is the smallest diff in this brief.

1. Add `'UNMEASURED'` to `VerdictStatus` in `netlify/functions/shared/verdicts.ts`. Register `catalyst`, `trident`, `screens` with that status (`excessVsSPYPp: null`, `runId: null`, honest `note`). Extend `VerdictBoard`.
2. `verdictLabel()` → `'NOT MEASURED'` for the new status. `isUnvalidated()` must return **true** for `UNMEASURED` as well as `NO_EDGE` — an unmeasured board is not a validated one.
3. Render `<VerdictChip board={board} />` in `src/components/detail/StockDetailHero.jsx`, next to the score badge and **above** the Buy row. It must render whether or not a thesis/research panel is present.
4. Derive the nav `section` at render time in `Sidebar.jsx` and `MobileDrawer.jsx` from `BOARD_VERDICTS` instead of a hardcoded list — any board whose status is `NO_EDGE` or `UNMEASURED` falls below the Unvalidated divider. `fable` moves automatically; keep `VIEWS` the single source of truth.

**Acceptance:** every board header and every `StockDetailHero` renders a chip. No board reaches a Buy button without an edge statement. Test: for each key in `BOARD_VERDICTS`, chip text is non-empty; a board absent from the registry fails the test loudly rather than rendering blank.

---

## W2 — Pin the brokerage account (F1)

**The bug.** `netlify/functions/shared/robinhood.ts`:

```ts
const a = data?.results?.[0];   // whatever Robinhood returns first
```

`broker-auth.ts` persists that as `accountUrl`; `broker-execute.ts` reuses it forever. There is no env var, no config, no UI picker, no assertion. The owner has **four** Robinhood accounts. Robinhood's official account listing returns the **margin / option-level-3** account first and the **agentic** account last. The existing tests (`robinhood.test.ts`, `broker-auth.test.ts`) use account numbers ending `6945` — i.e. they assume the agentic account — but the code never enforces it.

**Before writing code:** read `accountMasked` from `GET /api/broker-auth` (or the Settings UI). Record the actual value in the PR description. If it is not the agentic account, say so plainly — that means live orders have been landing in the main margin account and the finding is confirmed rather than hypothetical.

**Change:**
1. New env var `ROBINHOOD_ACCOUNT_NUMBER` (Netlify env; value = the agentic account number, `<provided per session — the account whose nickname is "Agentic" and whose masked form ends 6945>`). Reference the variable name only; never commit the literal.
2. `getAccount(token, { accountNumber })` selects from `results` by `account_number` and **throws** `robinhood account <masked> not found` when absent. Delete the `results[0]` fallback entirely — a wrong-account order is worse than a failed order.
3. `broker-auth.ts` verifies at connect time and stores the resolved `accountUrl`/`accountNumber`. If a previously-stored `accountUrl` disagrees with the configured number, **overwrite it and log a warning** — a stale Firestore doc must not outrank config.
4. `broker-execute.ts` and `broker-positions.ts` assert the resolved account matches config on every call, before placing anything.
5. Surface the masked account in the order ticket UI so it is visible at the moment of the click.

**Acceptance:** a mocked 4-account payload with the agentic account LAST resolves the agentic account. A payload missing it throws and places nothing. Regression test pins both.

---

## W3 — Real risk limits (F2, F5)

`PER_ORDER_CAP = 500` is currently the only quantitative guardrail. Ten clicks is $5,000. No daily cap, no position count, no per-ticker ceiling, no cooldown.

1. Add server-side, in `broker-execute.ts` (config via env, sane defaults):
   - `DAILY_NOTIONAL_CAP` — sum of today's placed notional, read from the `tradeLog`/orders record, not from memory (the function is stateless across invocations).
   - `MAX_OPEN_POSITIONS`.
   - `PER_TICKER_EXPOSURE_CAP` — existing position value + this order.
2. `DO_NOT_TOUCH` symbol list (env, comma-separated). Any `sell` of a listed symbol is rejected with a clear error. This protects manually-bought holdings that currently sit in the agentic account. Applies to **both** `broker-execute` and the `trade-queue` execute path.
3. Every rejection returns a specific message naming the limit hit — never a generic 400.

**Owner decision required before this ships (do not decide for him):** the agentic account currently holds four manually-bought positions worth ~$5.5k. Either (a) move them to the main account so the agentic account holds only agent capital and the broker's own ring-fence does the work, or (b) keep them and rely on `DO_NOT_TOUCH`. (a) is structurally safer; (b) is zero-friction. Implement `DO_NOT_TOUCH` regardless — it is cheap and it is the backstop if (a) is chosen later.

**Acceptance:** unit tests for each limit at boundary and over. A sell of a `DO_NOT_TOUCH` symbol is rejected before any network call.

---

## W4 — Order-state reconciliation (F7)

`broker-execute` writes the journal doc at **placement** with `pending: order.state !== 'filled'` and `brokerOrderState` frozen at that instant. Nothing updates it. A resting limit that fills tomorrow stays `pending: true` forever; a native stop that fires never becomes an exit. `PositionsPanel`, `baseRates`, and the Journal therefore drift from reality — and base rates are what the Desk uses to tell the owner whether a setup works.

`stop-watch.ts` does **not** cover this: it watches price-vs-stop-level breaches, not order state.

1. New scheduled function `broker-reconcile-background.ts` (follow the existing `-background` + checkpoint conventions; the `-background` suffix is what grants the 15-min container).
2. For each `tradeLog` doc with `pending: true` and a `brokerOrderId`, fetch the current order state and update `pending` / `brokerOrderState` / fill price / fill time. Terminal states (`filled`, `cancelled`, `rejected`, `failed`, `voided`) stop future polling for that doc.
3. Closed round trips write exit fields so realized P&L is derivable without re-deriving from positions.
4. Emit a heartbeat doc and surface staleness, exactly as `stop-watch.ts` does. **A reconciler the app cannot tell is dead is worse than no reconciler** — same standing rule.
5. Cron outside 21:30–22:45 UTC to avoid the documented Finnhub bucket contention.

**Acceptance:** a placed-then-filled order transitions `pending: true → false` with the real fill price. A cancelled order stops being polled. `/api/stop-watch`-style freshness fields present and tested.

---

## W5 — SPIKE (timeboxed, no production change): backend as an MCP client

**Do not migrate anything in this PR. Answer one question and write it down.**

`shared/robinhood.ts` talks to Robinhood's **private** API: mobile `client_id`, password grant, access + refresh tokens in Firestore, plus a hand-rolled Pathfinder device-approval flow (user_machine → sheriff challenge → prompt poll → workflow finalize). The file is candid that this *"leans against Robinhood's terms (accounts can be flagged for unofficial API use)"* and that *"the token is a money-moving credential held in our infra."* It also breaks whenever Robinhood changes that flow.

The stated reason it exists: *"the owner wants to click Buy/Sell in TradeIQ and have the order actually placed, with no agent/chat session in the loop."* That requirement is sound — but the conclusion does not follow. **MCP is JSON-RPC over HTTP with OAuth; a server can be an MCP client.** A Netlify function holding the OAuth grant can speak MCP to `https://agent.robinhood.com/mcp/trading` with no chat session anywhere.

Note also that `broker-sync.ts` asserts *"TradeIQ's backend cannot reach Robinhood itself (the OAuth lives in the agent session)"* — which `broker-positions.ts` disproves. The codebase currently holds both beliefs at once.

**Spike deliverable** (`reports/broker-1/mcp-client-spike.md`), answering:
1. Can a Netlify function complete and persist the `agent.robinhood.com/mcp/trading` OAuth grant, and refresh it unattended? What does first-time consent require?
2. Can it call `review_equity_order` and `place_equity_order` server-to-server?
3. Do orders placed that way carry `placed_agent: 'agentic'` in `get_equity_orders`? **This is the load-bearing question** — it is what makes TradeIQ orders distinguishable from manual taps and therefore measurable.
4. What is lost? (Stop-order support, order types, extended hours, fractional handling — compare against what `broker-execute` supports today.)

If yes → BROKER-2 migrates `broker-execute` onto it and retires the private client, resolving F3/F4/F6 together (`review_equity_order` brings buying-power / halt / PDT checks for free). If no → keep the private path, and BROKER-2 instead adds equivalent pre-trade checks manually and accepts that TradeIQ orders stay unattributable.

**Do not place a live order during the spike.** `review_equity_order` is a simulation and is sufficient. Any live-fire test needs the owner's explicit go-ahead, in the agentic account, at minimum size.

---

## Out of scope (log, don't build)

- **Live per-board scorecard** — the actual payoff: `placed_agent=agentic` × `sourceBoard` × realized P&L vs SPY. Blocked on W5 answering yes. When built, **pre-register the decision rule before data accumulates**, per `reports/fable/design.md` discipline, and match the horizon FABLE-2 found signal at (rank-IC +0.027/+0.028 at 63d/126d vs −0.017 at 21d) rather than a 21-day cadence.
- **`broker-sync` POST removal** — its premise is false and the endpoint is unauthenticated by design. Point the Desk card at `broker-positions` (authenticated, live) and delete the POST. Small, but it is a write endpoint and deserves its own PR.
- **Unused Robinhood capability**: `get_equity_tax_lots` + specified-lot selling (repo currently sells FIFO; there is already a "Stocks sold for loss" watchlist, so lot selection is real money); server-side scanner as rate-limit relief on the documented Finnhub 55rpm contention — **note the scanner exposes EMA, not SMA, so the crosses board is not a drop-in**; writable watchlists to mirror `tradeQueue` into the Robinhood mobile app.

---

## Conventions (binding)

- `APP_VERSION` bumped in `src/App.jsx` on every user-visible change; `MODEL_VERSION` unchanged.
- Tables sort via `useSortable` + `SortableTh`, no exceptions.
- No literal secrets in this or any brief — env var **names** only (`SECRETS_SCAN_OMIT_PATHS = "briefs/*"` is the backstop, not the fix).
- `npx tsc --noEmit && npm test && npm run build` green before PR.
- Smoke-test every changed HTTP route on the deploy preview before merge (the 4b-2 routing bug reached prod for 5 minutes).
- Ship W1 as its own commit so it can merge ahead of the rest if W2–W4 need iteration.

## Deviations to flag up front

If the account check in W2 shows the agentic account was correctly selected all along, **say so in the PR** — the fix still ships (the code must not depend on Robinhood's response ordering), but the severity was lower than this brief assumed, and the record should reflect that.
