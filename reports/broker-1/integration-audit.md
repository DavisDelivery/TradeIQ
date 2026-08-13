# BROKER-1 — execution-path integration audit

**Status:** W0 complete. W1 shipped. W2–W4 blocked on owner decisions (below).
**Date:** 2026-08-13
**Basis:** repo read at `1a6bdf9`, six parallel read-only code audits, live
Robinhood OAuth discovery documents, one read-only `get_accounts` call.
**No order was placed. No Robinhood write tool was called.**

> The brief said to copy an audit supplied alongside it. That content was not
> provided, so this document is written from findings verified directly in this
> session. Where it differs from the brief, the difference is flagged.

---

## W0 — baseline

| Check | Result |
|---|---|
| Open PRs at start | **0** |
| `npx tsc --noEmit` | clean |
| `npm test` | 278 files / 3,027 tests pass |
| `npm run build` | ok |
| Stale `claude/*` branches | ~70, all rooted before the 2026-07-22 re-root; ignored |

Two paths in the brief do not resolve: `src/components/Sidebar.jsx` and
`src/components/MobileDrawer.jsx` are actually in `src/layout/`.

---

## Findings — confirmed, refuted, and sharpened

### F1 — account selection is unpinned · **CONFIRMED, worse than stated**

`shared/robinhood.ts:323` — `const a = data?.results?.[0]` — with no filter on
type, `state` or `deactivated`, no pagination, and no pin against the stored
`accountNumber` (which `StoredCreds` writes at `robinhood.ts:38` and never reads
back as a selector).

The live login has **four** accounts, and the agentic one is **last**:

| # | Account | Type | `agentic_allowed` |
|---|---|---|---|
| **[0]** | ••••0197 | margin, individual, option level 3, `is_default` | false |
| [1] | ••••3930 | limited margin, IRA traditional | false |
| [2] | ••••6112 | limited margin, managed | false |
| **[3]** | ••••6945 "Agentic" | **cash**, individual | **true** |

**Sharper than the brief:** `broker-auth.ts:42-44` re-derives the account via
`getAccount()` and **overwrites** the stored `accountUrl`/`accountNumber` on
**every** `status` call. There is therefore no path by which a corrected value
persists — the next Settings open re-imposes `results[0]`. The brief's W2.3
("if a stored value disagrees with config, overwrite it") must be inverted:
config has to win over re-derivation, and `accountSummary()` must stop blindly
overwriting.

**Code-comment conflict.** `broker-positions.ts:3` and `broker-sync.ts:1-2` both
state they represent the **Agentic** account, while `broker-positions.ts:36`
reads positions on the `results[0]` credential. Either the comments are wrong or
the selection is.

**Trap.** The only test fixture masks to `••••6945`
(`shared/__tests__/robinhood.test.ts:176-182`) — the same last-4 as the real
Agentic account. It is a **single-element** array and gives zero multi-account
coverage. Do not read it as evidence of which account is traded.

**NOT ESTABLISHED, and it blocks W2:** which account `results[0]` actually
resolves to on the private REST API. Confirming it requires
`POST /api/broker-auth {action:'status'}`, which is gated by `verifyOwnerBearer`
and cannot be called from here. The MCP ordering above is suggestive, not proof
— it is a different API surface.

### F5 — `PER_ORDER_CAP` is the only limit · **REFUTED as stated**

True only in the narrow sense of "only *notional* cap on the *primary* order."
`PER_ORDER_CAP = 500` (`broker-execute.ts:28`) is enforced once at L98-100,
before placement. Other quantitative bounds do exist: `stopLossPct` clamp
(L56-57), ticker regex (L49), rationale truncation (L165), trade-queue expiry
clamp (`trade-queue.ts:131-133`).

The cap has **three holes**, all real:
1. **Per-request only** — N sequential $499 orders all pass.
2. The derived protective **sell-stop** (L118-130) is placed for full `qty` with
   **no cap check at all**.
3. `trade-queue.ts` has no notional cap (POST L118-120), though it places no
   broker order.

Buying power is fetched by `getAccount` (`robinhood.ts:328-329`) and **discarded**.

### F7 — nothing reconciles order state · **CONFIRMED**

`pending` / `brokerOrderState` / `brokerOrderId` are written once
(`broker-execute.ts:154-155,167`) and read by **zero** server call sites.
Nothing mutates a `tradeLog` doc server-side, ever.

**Root cause the brief did not name:** `shared/robinhood.ts` has **no order-read
helper**. No `getOrder`, no `listOrders`. Reconciliation is not merely unbuilt,
it is currently impossible without net-new API code — and nobody has verified
the private REST exposes a usable `GET /orders/{id}`.

`ref_id` is a **fresh** `randomUUID()` per call (`robinhood.ts:431, 468, 504`),
so it satisfies Robinhood's field but **dedupes nothing** across retries or
double-clicks.

### F3/F4 — unsanctioned path, unattributable orders · **CONFIRMED**

See `mcp-client-spike.md`. Headline: `placed_agent` is real, `'agentic'` denotes
MCP, and the MCP path can only trade the cash account ••••6945.

### F8 — Buy renders without a chip · **CONFIRMED, and far worse**

The registry and the navigation had drifted **completely** apart:

> **VIEWS ∩ BOARD_VERDICTS = ∅**

Every board reachable in the app was absent from `BOARD_VERDICTS`, and every
board in the registry had been retired out of the nav. `VerdictChip` returns
`null` for an unregistered board, so **the chip rendered on nothing at all**.
Fixed in W1.

---

## Risks a careless edit here would cause

- **R1 Silent account switch.** No pin, and `status` overwrites the stored
  account on every call. If Robinhood reorders `/accounts/`, orders move to the
  IRA or the managed account with no error and no failing test.
- **R2 A guard after placement is not a guard.** `broker-execute.ts:104-114` is
  where money moves, and there is no cancel helper. Every new check must return
  **before** L102.
- **R3 Order live but unrecorded.** The journal write (L135) is awaited with no
  local try/catch; a Firestore failure returns 502 **with the order already at
  the broker**. The user retries → duplicate live order, because `ref_id` is
  fresh per call.
- **R5 Blocking a sell traps a position.** `getPositions` swallows
  instrument-resolve failures and leaves `symbol: ''`; a partial list must
  reject, not read as "not held." Sells should be exempt from notional caps.
- **R7 A wrong `pending: false`** makes a non-position render as a holding, feed
  base rates, and become **stop-watched** — arming a sell stop on shares not
  owned.
- **R8 Two uncoordinated order paths.** A daily cap computed from `tradeLog`
  cannot see orders placed by an external agent session, and vice versa.
- **R9 Untrustworthy risk inputs.** `tradeLog` is world-writable until
  2026-10-01 and `brokerSnapshot/latest` is written by an unauthenticated POST
  **by design**. Gating money on either turns a display surface into an
  authorization surface.
- **R11 Green CI is not a safety net here.** `broker-execute.test.ts` mocks the
  whole `shared/robinhood` module, so no account-selection code runs, and
  `pending`, `brokerOrderState`, `shares` and `stop` are never asserted.

---

## Decisions required before W2–W4 can ship

1. **Which account should TradeIQ trade?** Everything downstream is scoped to
   this. A $500 cap on the wrong account is not a guardrail.
2. **The cap numbers**: `DAILY_NOTIONAL_CAP`, `MAX_OPEN_POSITIONS`,
   `PER_TICKER_EXPOSURE_CAP`, and the `DO_NOT_TOUCH` list. Plus: are sells
   exempt from caps? Is the protective stop leg exempt? Does an unset
   `DO_NOT_TOUCH` fail open or closed?
3. **The four manually-bought positions (~$5.5k) in the agentic account** —
   move them out, or keep them and rely on `DO_NOT_TOUCH`? The brief is explicit
   that this is the owner's call.
4. **Approval for a server function to mutate `tradeLog`** for the first time,
   plus verification that the private REST exposes a usable order read.
5. **Cash-account ruling** — see the spike. Accepting MCP means accepting a cash
   account: no margin, no shorts, T+1 good-faith-violation exposure.
