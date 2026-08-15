# BROKER-1 W5 — spike: TradeIQ's backend as an MCP client

**Status:** answered. No production change. No live order placed.
**Date:** 2026-08-13
**Method:** live fetches of Robinhood's OAuth discovery documents, the MCP
endpoint's own tool schemas, and one read-only `get_accounts` call. Repo read at
`1a6bdf9`.

---

## The one-line answer

**The transport and auth work. The premise does not.** A Netlify function can
hold its own OAuth grant and speak MCP with no chat session in the loop — but
`place_equity_order` requires `agentic_allowed: true`, and on this login that is
true for exactly one account: the **cash** "Agentic" account. The account the
private path trades today cannot be traded over MCP at all.

This is not a migration. It is a proposal to trade a different account.

---

## Q1 — Can a Netlify function complete and refresh the grant unattended?

**Steady state: yes. First consent: no — one desktop browser, once.**

From `https://agent.robinhood.com/.well-known/oauth-authorization-server` (HTTP 200):

```
authorization_endpoint            https://robinhood.com/oauth
token_endpoint                    https://api.robinhood.com/oauth2/token/
registration_endpoint             https://agent.robinhood.com/oauth/trading/register
grant_types_supported             ["authorization_code", "refresh_token"]
code_challenge_methods_supported  ["S256"]
token_endpoint_auth_methods_supported  ["none"]
scopes_supported                  ["internal"]
```

- **No `client_credentials`.** There is no machine-to-machine grant on this
  endpoint. The MCP spec's client-credentials extension (SEP-1046) exists but is
  optional, and Robinhood has not enabled it. Robinhood's own metadata is the
  authority, so this is decisive rather than an inference.
- **`refresh_token` is supported**, and `registration_endpoint` means dynamic
  client registration (RFC 7591) is available — the function can mint its own
  `client_id` without a human pre-registering one. So after one consent the
  backend runs unattended. Nothing in MCP requires an LLM; it is JSON-RPC over
  HTTP.
- An unauthenticated `initialize` POST returns **401** with
  `www-authenticate: Bearer resource_metadata="…"` — standard Streamable HTTP MCP.

### Two operational risks worth pricing in

1. **`token_endpoint_auth_methods_supported: ["none"]` means a public client**,
   and the MCP authorization spec requires authorization servers to **rotate
   refresh tokens for public clients**. Rotating refresh tokens plus concurrent
   stateless Netlify invocations is a genuine race: two functions refreshing at
   once can break the chain and force re-consent. This needs single-flight
   locking around refresh, which `ensureToken()`/`refresh()` in
   `shared/robinhood.ts` does **not** have today.
2. The `token_endpoint` and `scope: "internal"` are the **same** ones the
   current private path already posts to (`robinhood.ts:139`, `:277`). The two
   paths converge at the token endpoint and differ only in how the grant is
   obtained — which is precisely the part that makes one sanctioned and the
   other not.

---

## Q2 — Can it call review/place server-to-server?

Yes, subject to Q4's account constraint. Both tools are present on the live
endpoint, and `review_equity_order` is a simulation that returns the current
quote plus pre-trade alerts covering **buying power, PDT and instrument halts**
— i.e. finding **F6** (no pre-trade validation) is resolved for free on this
path, not built.

---

## Q3 — Do orders carry an attribution marker? **YES.**

This was the load-bearing question, and the answer is affirmative with a caveat
about where the evidence comes from.

**Proven.** The live `get_equity_orders` tool schema exposes a filter parameter
named exactly `placed_agent`, described verbatim as:

> "Filter to one source: 'user', 'agentic' (MCP), 'recurring', 'drip', etc."

A server cannot offer a server-side filter on a dimension it does not record.
So Robinhood stamps provenance on every equity order, `'agentic'` denotes MCP,
and `'user'` is a distinct sibling value. Corroborated by Robinhood's own
newsroom copy describing push notifications and a real-time activity feed for
agent trades.

**Stated plainly:** the *public documentation* never mentions `placed_agent`.
It appears only in the MCP server's own tool schema. What remains unproven is
whether the value is **returned on the order payload** or is **filter-only** —
confirming that requires an authenticated `get_equity_orders` call, which this
spike did not make.

**Why it matters:** this is the field that makes TradeIQ orders distinguishable
from manual taps, and therefore the thing that makes a live per-board scorecard
possible at all. The current private path deliberately tags orders as
`placed_agent: user` — indistinguishable from the owner's own taps, hence
unattributable, hence unmeasurable.

---

## Q4 — What is lost? (and the blocker)

### THE BLOCKER — account scope

`place_equity_order` requires `agentic_allowed: true`. Live `get_accounts`:

| Account | Type | `agentic_allowed` |
|---|---|---|
| ••••0197 (default) | margin, individual, **option level 3** | **false** |
| ••••3930 | limited margin, IRA traditional | false |
| ••••6112 | limited margin, managed | false |
| ••••6945 "Agentic" | **cash**, individual | **true** |

The MCP path can trade **only** ••••6945 — a separate, separately-funded cash
account. Robinhood states margin borrowing is not enabled for Agentic accounts.
Consequences: no margin, no shorting, and T+1 settlement with good-faith-violation
exposure that a margin account does not have.

### Capability delta — MCP is RICHER, not poorer

Contrary to the brief's expectation that something would be lost, the MCP
surface exceeds the current private path:

| | private path today | MCP |
|---|---|---|
| Order types | market, limit, stop | market, limit, **stop_market, stop_limit** |
| Sessions | regular | regular, **extended**, **all_day / overnight** (limit-only) |
| Notional orders | no | **`dollar_amount`** (market only) |
| Fractional | forwarded unchecked | supported, 6dp, regular+market only |
| Cancel | **absent** | `cancel_equity_order` |
| Order read | **absent** | `get_equity_orders` (single + list) |
| Specified-lot sell | no (FIFO) | **`tax_lots`**, ≤30 lots |
| Pre-trade checks | none | `review_equity_order` |

Two of those absences are the direct causes of open BROKER-1 findings:
**F7 cannot be fixed on the private path without net-new code** because
`shared/robinhood.ts` has no order-read helper at all, and **F6** is free here.

---

## Recommendation

The technical answer is yes, and it resolves F3, F4, F6 and F7 together. It is
blocked on a decision that is not technical:

> **Is TradeIQ willing to trade the cash Agentic account ••••6945 instead of the
> margin account ••••0197?**

- **If yes** → BROKER-2 migrates `broker-execute` onto MCP, retires the private
  client, and the live per-board scorecard becomes buildable because orders
  become attributable. Add single-flight refresh locking as part of that work.
- **If no** → the private path stays, BROKER-2 adds buying-power/halt/PDT checks
  by hand, adds a `getOrder` helper for reconciliation, and TradeIQ orders remain
  permanently unattributable — which forecloses the scorecard that the
  board-trust audit identifies as the only measuring instrument left.

There is a third option worth naming: **run both.** Keep the private path for
••••0197 and use MCP for ••••6945 as the attributed, measured sleeve. That gets
a clean measurement without moving existing capital, at the cost of two order
paths to maintain.

---

## What this spike did NOT determine

- Whether `placed_agent` is returned on the order payload or is filter-only.
- Whether Robinhood revokes agentic grants on a schedule.
- Real latency/rate limits of the MCP endpoint under a Netlify function's
  10-second default timeout.
- Whether `review_equity_order`'s alerts are advisory or blocking.
