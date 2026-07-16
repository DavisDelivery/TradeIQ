// Broker positions — live shares owned in the connected Robinhood account.
// Behind the app login. Used by the order ticket to show "you own N shares"
// and by the Desk to represent the Agentic account's holdings.
//
//   GET /api/broker-positions            → { ok, positions:[{symbol,qty,avgCost}] }
//   GET /api/broker-positions?ticker=NFLX → same, filtered to one symbol
//
// Not connected → 409 needsConnect (so the UI can point to Settings).

import type { Handler } from '@netlify/functions';
import { verifyOwnerBearer } from './shared/auth';
import { ensureToken, getPositions } from './shared/robinhood';
import { logger } from './shared/logger';

const log = logger.child({ fn: 'broker-positions' });

function json(status: number, body: unknown) {
  return {
    statusCode: status,
    headers: { 'content-type': 'application/json', 'cache-control': 'private, no-store' },
    body: JSON.stringify(body),
  };
}

export const handler: Handler = async (event) => {
  if (event.httpMethod !== 'GET') return json(405, { ok: false, error: 'GET only' });

  const auth = await verifyOwnerBearer((event.headers ?? {}) as Record<string, string | undefined>);
  if (!auth.ok) return json(auth.status ?? 401, { ok: false, error: auth.error });

  try {
    let creds;
    try { creds = await ensureToken(); }
    catch (e: any) { return json(409, { ok: false, error: `connect Robinhood first (${String(e?.message ?? e)})`, needsConnect: true }); }

    const all = await getPositions(creds.accessToken);
    const want = String(event.queryStringParameters?.ticker ?? '').toUpperCase().trim();
    const positions = (want ? all.filter((p) => p.symbol === want) : all)
      .map((p) => ({ symbol: p.symbol, qty: p.qty, avgCost: p.avgCost }))
      .sort((a, b) => a.symbol.localeCompare(b.symbol));

    return json(200, { ok: true, positions, asOf: new Date().toISOString() });
  } catch (err: any) {
    const msg = String(err?.message ?? err);
    log.error('broker_positions_failed', { err: msg });
    return json(502, { ok: false, error: msg });
  }
};
