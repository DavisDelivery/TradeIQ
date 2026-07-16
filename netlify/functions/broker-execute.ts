// One-click execution — places a REAL Robinhood order from a TradeIQ button
// and journals it. Option B, increment 2. Behind the app login. Requires a
// connected Robinhood (broker-auth); if not connected, 409 with a clear
// "connect first" so the UI can point the owner to Settings.
//
//   POST /api/broker-execute
//     { ticker, side:'buy'|'sell', qty, limitPrice?, stopLossPct? }
//
// GUARDRAILS (owner's standing rules, enforced server-side):
//   - Per-order notional cap (~$500). qty × (limit or live quote) must fit.
//   - Long-only: buys open, sells close. No shorting is expressed here; a
//     sell beyond the held position is rejected by Robinhood itself.
//   - Buys may carry a stop-loss → a NATIVE Robinhood sell-stop is placed at
//     fill so the protection lives at the broker.
// On success we write the same journal doc the queue path writes, so the
// app's live tradeLog subscription shows the fill immediately.

import type { Handler } from '@netlify/functions';
import { verifyOwnerBearer } from './shared/auth';
import {
  ensureToken, loadCreds, saveCreds, getAccount, getInstrument, getQuote,
  placeEquityOrder, placeStopLoss,
} from './shared/robinhood';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'broker-execute' });
const PER_ORDER_CAP = 500; // USD notional per order
const JOURNAL_COLLECTION = 'tradeLog';

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'POST only' });

  const auth = await verifyOwnerBearer((event.headers ?? {}) as Record<string, string | undefined>);
  if (!auth.ok) return json(auth.status ?? 401, { ok: false, error: auth.error });

  let body: any = {};
  try { body = JSON.parse(event.body ?? '{}'); } catch { return json(400, { ok: false, error: 'invalid json' }); }

  const ticker = String(body.ticker ?? '').toUpperCase().trim();
  if (!/^[A-Z.\-]{1,8}$/.test(ticker)) return json(400, { ok: false, error: 'ticker required' });
  const side = body.side === 'sell' ? 'sell' : body.side === 'buy' ? 'buy' : null;
  if (!side) return json(400, { ok: false, error: "side must be 'buy' or 'sell'" });
  const qty = Number.isFinite(+body.qty) && +body.qty > 0 ? +body.qty : null;
  if (!qty) return json(400, { ok: false, error: 'qty required (> 0)' });
  const limitPrice = Number.isFinite(+body.limitPrice) && +body.limitPrice > 0 ? +body.limitPrice : null;
  const stopLossPct = side === 'buy' && Number.isFinite(+body.stopLossPct) && +body.stopLossPct > 0
    ? Math.min(0.9, +body.stopLossPct) : null;

  try {
    // Must be connected. ensureToken throws "Robinhood not connected" / refresh
    // failures — surface as 409 so the UI sends the owner to Settings.
    let creds;
    try { creds = await ensureToken(); }
    catch (e: any) { return json(409, { ok: false, error: `connect Robinhood first (${String(e?.message ?? e)})`, needsConnect: true }); }

    // Account url (cached at connect; re-read + persist if missing).
    let accountUrl = creds.accountUrl;
    if (!accountUrl) {
      const acct = await getAccount(creds.accessToken);
      accountUrl = acct.accountUrl;
      await saveCreds({ ...creds, accountUrl, accountNumber: acct.accountNumber });
    }

    const instr = await getInstrument(creds.accessToken, ticker);
    if (!instr.tradable) return json(400, { ok: false, error: `${ticker} is not tradable on Robinhood right now` });

    // Price for the cap check + market collar.
    const quote = limitPrice ?? (await getQuote(creds.accessToken, ticker));
    if (!quote || !(quote > 0)) return json(502, { ok: false, error: `no live quote for ${ticker}` });
    const notional = qty * quote;
    if (notional > PER_ORDER_CAP) {
      return json(400, { ok: false, error: `order ~$${notional.toFixed(0)} exceeds the $${PER_ORDER_CAP}/order cap` });
    }

    // Place the real order.
    const order = await placeEquityOrder(creds.accessToken, {
      accountUrl, instrumentUrl: instr.instrumentUrl, symbol: ticker,
      side, quantity: qty, limitPrice: limitPrice ?? undefined, collarPrice: quote,
    });

    // Native stop-loss on buys (protection lives at the broker).
    let stopOrder: { stopPrice: number; id: string } | null = null;
    if (side === 'buy' && stopLossPct) {
      const stopPrice = +(quote * (1 - stopLossPct)).toFixed(2);
      try {
        const s = await placeStopLoss(creds.accessToken, {
          accountUrl, instrumentUrl: instr.instrumentUrl, symbol: ticker, quantity: qty, stopPrice,
        });
        stopOrder = { stopPrice, id: s.id };
      } catch (e: any) {
        // The buy went through; a failed stop shouldn't 500 the whole call.
        log.warn('stop_failed', { ticker, err: String(e?.message ?? e) });
      }
    }

    // Journal writeback — same shape as the queue path; the live tradeLog
    // subscription picks it up so the Journal updates without polling.
    const journalId = `${ticker}-${String(body.sourceBoard ?? 'app')}-${Date.now()}`;
    await getAdminDb().collection(JOURNAL_COLLECTION).doc(journalId).set({
      id: journalId,
      ticker,
      source: String(body.sourceBoard ?? 'app'),
      side,
      loggedAt: new Date().toISOString(),
      price: quote,
      entry: quote,
      qty: side === 'sell' ? -Math.abs(qty) : qty,
      stopPrice: stopOrder?.stopPrice ?? null,
      notes: `robinhood ${side} ${qty} ${ticker} @ ~$${quote}`
        + (stopOrder ? ` · stop $${stopOrder.stopPrice}` : '')
        + (body.rationale ? ` — ${String(body.rationale).slice(0, 300)}` : ''),
      via: 'broker-execute',
      brokerOrderId: order.id,
    });

    log.info('order_placed', { ticker, side, qty, quote, orderId: order.id, stop: stopOrder?.stopPrice, journalId });
    return json(200, {
      ok: true,
      order: { id: order.id, state: order.state, ticker, side, qty, price: quote },
      stopOrder,
      journalId,
    });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('broker_execute_failed', { err: msg, ticker, side });
    return json(502, { ok: false, error: msg });
  }
};
