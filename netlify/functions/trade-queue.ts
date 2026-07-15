// Trade queue — the human-in-the-loop bridge between TradeIQ signals and
// an external execution agent (Robinhood Agentic runbook, Phase 2).
//
//   GET   /api/trade-queue?status=queued|executed|cancelled|expired|all
//         Open read (matches every board endpoint's posture). The executor
//         agent polls status=queued.
//   POST  /api/trade-queue        { ticker, side:'buy', qty|notional,
//         limitPrice?, sourceBoard, rationale?, expiresHours? }
//         Queuing IS the approval — a human queued it from a board row.
//   PATCH /api/trade-queue        { id, action:'cancel' }
//         or { id, action:'execute', fill:{ price, qty, filledAt? } }
//         'execute' writes the fill AND creates the Journal entry
//         (Firestore tradeLog — the app's live subscription picks it up),
//         source-tagged to the originating board.
//
// AUTH — deliberate departure from the rest of the app's open-mutation
// posture: this queue drives REAL-MONEY orders, so every mutation requires
// the shared secret in the `x-trade-queue-token` header, checked against
// TRADE_QUEUE_TOKEN. FAIL-CLOSED: if the env var is unset, mutations 501
// rather than default open. The owner enters the token once in Settings
// (sent by the queue UI) and gives the same token to the executor agent.
//
// State machine (one-way, no resurrection):
//   queued -> executed | cancelled | expired
// Expiry: rows carry expiresAt (default 72h); GET lazily flips overdue
// queued rows to expired so the executor can never fill a stale signal.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'trade-queue' });
const COLLECTION = 'tradeQueue';
const JOURNAL_COLLECTION = 'tradeLog';
const DEFAULT_EXPIRES_HOURS = 72;
const STATUSES = ['queued', 'executed', 'cancelled', 'expired'] as const;
type QueueStatus = (typeof STATUSES)[number];

export interface QueueRow {
  id: string;
  ticker: string;
  side: 'buy';
  qty: number | null;
  notional: number | null;
  limitPrice: number | null;
  sourceBoard: string;
  rationale: string | null;
  status: QueueStatus;
  queuedAt: string;
  expiresAt: string;
  executedAt?: string;
  cancelledAt?: string;
  fill?: { price: number; qty: number; filledAt: string };
  journalId?: string;
}

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

function mutationAuth(event: { headers: Record<string, string | undefined> }): { ok: boolean; res?: any } {
  const secret = process.env.TRADE_QUEUE_TOKEN;
  if (!secret) {
    // Fail closed — a money-adjacent mutation surface must never default open.
    return { ok: false, res: json(501, { ok: false, error: 'TRADE_QUEUE_TOKEN not configured — queue mutations disabled' }) };
  }
  const supplied = event.headers['x-trade-queue-token'] ?? event.headers['X-Trade-Queue-Token'];
  if (supplied !== secret) {
    return { ok: false, res: json(401, { ok: false, error: 'invalid trade-queue token' }) };
  }
  return { ok: true };
}

export const handler: Handler = async (event) => {
  const db = getAdminDb();

  try {
    // ---------------- GET: list ----------------
    if (event.httpMethod === 'GET') {
      const want = (event.queryStringParameters?.status ?? 'all') as QueueStatus | 'all';
      // Single-field query only (no composite indexes needed).
      const snap = want === 'all'
        ? await db.collection(COLLECTION).orderBy('queuedAt', 'desc').limit(200).get()
        : await db.collection(COLLECTION).where('status', '==', want).limit(200).get();
      const now = new Date().toISOString();
      const rows: QueueRow[] = [];
      for (const d of snap.docs) {
        const r = d.data() as QueueRow;
        // Lazy expiry: an overdue queued row flips to expired ON READ so the
        // executor can never pick up a stale signal.
        if (r.status === 'queued' && r.expiresAt <= now) {
          r.status = 'expired';
          await d.ref.set({ status: 'expired' }, { merge: true });
        }
        rows.push(r);
      }
      rows.sort((a, b) => b.queuedAt.localeCompare(a.queuedAt));
      return json(200, { ok: true, rows, count: rows.length });
    }

    // ---------------- mutations: token required ----------------
    const auth = mutationAuth(event as any);
    if (!auth.ok) return auth.res;

    let body: any = {};
    try { body = JSON.parse(event.body ?? '{}'); } catch {
      return json(400, { ok: false, error: 'invalid json' });
    }

    if (event.httpMethod === 'POST') {
      const ticker = String(body.ticker ?? '').toUpperCase().trim();
      if (!/^[A-Z.\-]{1,8}$/.test(ticker)) return json(400, { ok: false, error: 'ticker required' });
      if (body.side !== 'buy') return json(400, { ok: false, error: "side must be 'buy' (long-only per runbook v1)" });
      const qty = Number.isFinite(+body.qty) && +body.qty > 0 ? +body.qty : null;
      const notional = Number.isFinite(+body.notional) && +body.notional > 0 ? +body.notional : null;
      if (!qty && !notional) return json(400, { ok: false, error: 'qty or notional required' });
      const sourceBoard = String(body.sourceBoard ?? '').trim();
      if (!sourceBoard) return json(400, { ok: false, error: 'sourceBoard required' });

      const now = new Date();
      const expiresHours = Number.isFinite(+body.expiresHours) && +body.expiresHours > 0
        ? Math.min(+body.expiresHours, 24 * 14)
        : DEFAULT_EXPIRES_HOURS;
      const row: QueueRow = {
        id: `tq_${ticker}_${now.getTime()}`,
        ticker,
        side: 'buy',
        qty,
        notional,
        limitPrice: Number.isFinite(+body.limitPrice) && +body.limitPrice > 0 ? +body.limitPrice : null,
        sourceBoard,
        rationale: body.rationale ? String(body.rationale).slice(0, 500) : null,
        status: 'queued',
        queuedAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + expiresHours * 3_600_000).toISOString(),
      };
      await db.collection(COLLECTION).doc(row.id).set(row);
      log.info('queued', { id: row.id, ticker, sourceBoard });
      return json(201, { ok: true, row });
    }

    if (event.httpMethod === 'PATCH') {
      const id = String(body.id ?? '');
      const action = String(body.action ?? '');
      if (!id || !['cancel', 'execute'].includes(action)) {
        return json(400, { ok: false, error: "id and action ('cancel'|'execute') required" });
      }
      const ref = db.collection(COLLECTION).doc(id);
      const snap = await ref.get();
      if (!snap.exists) return json(404, { ok: false, error: 'not found' });
      const row = snap.data() as QueueRow;
      if (row.status !== 'queued') {
        // One-way state machine: no cancelling an executed order, no
        // executing a cancelled/expired one.
        return json(409, { ok: false, error: `row is '${row.status}', not queued` });
      }

      if (action === 'cancel') {
        await ref.set({ status: 'cancelled', cancelledAt: new Date().toISOString() }, { merge: true });
        return json(200, { ok: true, id, status: 'cancelled' });
      }

      // execute
      const fill = body.fill ?? {};
      const price = +fill.price;
      const qty = +fill.qty;
      if (!(price > 0) || !(qty > 0)) return json(400, { ok: false, error: 'fill.price and fill.qty required' });
      if (row.expiresAt <= new Date().toISOString()) {
        await ref.set({ status: 'expired' }, { merge: true });
        return json(409, { ok: false, error: 'row expired before execution' });
      }
      const filledAt = typeof fill.filledAt === 'string' ? fill.filledAt : new Date().toISOString();

      // Journal writeback: same doc shape the client's logTrade writes; the
      // app's live tradeLog subscription picks it up and fires
      // 'tradelog:change' — the Journal updates without any polling.
      const journalId = `${row.ticker}-${row.sourceBoard}-${Date.now()}`;
      await db.collection(JOURNAL_COLLECTION).doc(journalId).set({
        id: journalId,
        ticker: row.ticker,
        source: row.sourceBoard,
        loggedAt: filledAt,
        price,
        entry: price,
        qty,
        notes: `agentic fill via trade-queue ${row.id}${row.rationale ? ` — ${row.rationale}` : ''}`,
        via: 'trade-queue',
      });
      await ref.set({
        status: 'executed',
        executedAt: new Date().toISOString(),
        fill: { price, qty, filledAt },
        journalId,
      }, { merge: true });
      log.info('executed', { id, ticker: row.ticker, price, qty, journalId });
      return json(200, { ok: true, id, status: 'executed', journalId });
    }

    return json(405, { ok: false, error: 'GET, POST, PATCH only' });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('trade_queue_failed', { err: msg, method: event.httpMethod });
    return json(500, { ok: false, error: msg });
  }
};
