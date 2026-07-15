// Broker snapshot sync — brings the Robinhood Agentic account's balance
// and positions into TradeIQ's Desk.
//
//   GET  /api/broker-sync            → latest snapshot (or {available:false})
//   POST /api/broker-sync            → store a snapshot
//
// The writer is the execution agent (a Claude session holding the
// Robinhood MCP OAuth); TradeIQ's backend cannot reach Robinhood itself
// (the OAuth lives in the agent session), and agents cannot complete a
// Google login. The owner explicitly ruled out shared secrets, so POST is
// open — hardened instead of gated:
//   - strict schema validation, numeric coercion, hard size caps
//     (30 positions, string lengths), single-doc overwrite (no growth),
//   - display-only blast radius: this data renders a dashboard card; it
//     authorizes nothing, moves nothing, and is labeled with its source
//     and timestamp in the UI.
// If spoofing ever becomes a real concern the fix is Firebase custom
// tokens for the agent — a deliberate follow-up, not a default secret.

import type { Handler } from '@netlify/functions';
import { getAdminDb } from './shared/firebase-admin';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'broker-sync' });
const DOC = 'brokerSnapshot/latest';
const MAX_POSITIONS = 30;

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

const num = (v: unknown): number | null => (Number.isFinite(+String(v)) ? +String(v) : null);
const str = (v: unknown, max = 24): string => String(v ?? '').slice(0, max);

export const handler: Handler = async (event) => {
  const db = getAdminDb();
  try {
    if (event.httpMethod === 'GET') {
      const snap = await db.doc(DOC).get();
      if (!snap.exists) return json(200, { ok: true, available: false });
      return json(200, { ok: true, available: true, ...snap.data() });
    }

    if (event.httpMethod !== 'POST') return json(405, { ok: false, error: 'GET or POST' });

    let body: any = {};
    try { body = JSON.parse(event.body ?? '{}'); } catch {
      return json(400, { ok: false, error: 'invalid json' });
    }

    const totalValue = num(body.totalValue);
    const buyingPower = num(body.buyingPower);
    if (totalValue == null || buyingPower == null) {
      return json(400, { ok: false, error: 'totalValue and buyingPower required (numbers)' });
    }
    const positionsIn = Array.isArray(body.positions) ? body.positions.slice(0, MAX_POSITIONS) : [];
    const positions = positionsIn
      .map((p: any) => ({
        symbol: str(p.symbol, 8).toUpperCase(),
        qty: num(p.qty),
        avgCost: num(p.avgCost),
        marketValue: num(p.marketValue),
      }))
      .filter((p: any) => /^[A-Z.\-]{1,8}$/.test(p.symbol) && p.qty != null);

    const doc = {
      accountMasked: str(body.accountMasked, 12) || '••••',
      totalValue,
      cash: num(body.cash),
      buyingPower,
      pendingDeposits: num(body.pendingDeposits),
      positions,
      source: str(body.source, 40) || 'executor-agent',
      asOf: typeof body.asOf === 'string' ? str(body.asOf, 32) : new Date().toISOString(),
      syncedAt: new Date().toISOString(),
    };
    await db.doc(DOC).set(doc);
    log.info('broker_snapshot_stored', { positions: positions.length, totalValue });
    return json(200, { ok: true, stored: true, positions: positions.length });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('broker_sync_failed', { err: msg });
    return json(500, { ok: false, error: msg });
  }
};
