import React, { useState, useEffect } from 'react';
import { TrendingDown, Check, Loader2 } from 'lucide-react';
import { getIdToken } from '../lib/auth.js';

// Full order ticket — places a REAL Robinhood order via broker-execute.
// Buy/Sell × Market/Limit/Stop/Stop-limit, optional stop-loss on plain buys,
// and it shows how many shares you already own in the connected (Agentic)
// account so a sell is one tap ("all"). Guardrails live server-side
// (long-only, $500/order cap).

const TYPES = [
  { key: 'market', label: 'Market' },
  { key: 'limit', label: 'Limit' },
  { key: 'stop', label: 'Stop' },
  { key: 'stop_limit', label: 'Stop-lmt' },
];

async function placeOrder(payload) {
  const token = await getIdToken();
  if (!token) throw new Error('sign in to TradeIQ first (Settings)');
  const r = await fetch('/api/broker-execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const j = await r.json().catch(() => ({}));
  if (r.status === 409 && j.needsConnect) throw new Error('Connect Robinhood in Settings first');
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function useOwnedShares(ticker) {
  const [owned, setOwned] = useState(undefined); // undefined=loading, null=n/a, {qty,avgCost}
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const token = await getIdToken();
        if (!token) { if (alive) setOwned(null); return; }
        const r = await fetch(`/api/broker-positions?ticker=${encodeURIComponent(ticker)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        const j = await r.json().catch(() => ({}));
        if (!alive) return;
        if (j.ok) {
          const p = (j.positions || [])[0];
          setOwned(p ? { qty: p.qty, avgCost: p.avgCost } : { qty: 0, avgCost: null });
        } else {
          setOwned(null); // not connected / error — just hide the line
        }
      } catch { if (alive) setOwned(null); }
    })();
    return () => { alive = false; };
  }, [ticker]);
  return owned;
}

const field =
  'h-8 px-2 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500 text-[12px] font-mono';

export function OrderTicket({ ticker, sourceBoard = 'app', price, rationale, initialSide = 'buy', onDone, onCancel }) {
  const [side, setSide] = useState(initialSide);
  const [type, setType] = useState('market');
  const [qty, setQty] = useState('');
  const [limit, setLimit] = useState('');
  const [stop, setStop] = useState('');
  const [stopPct, setStopPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const owned = useOwnedShares(ticker);

  const isBuy = side === 'buy';
  const needLimit = type === 'limit' || type === 'stop_limit';
  const needStop = type === 'stop' || type === 'stop_limit';
  const showSl = isBuy && (type === 'market' || type === 'limit');
  const ownedQty = owned && owned.qty > 0 ? owned.qty : 0;

  const refPx = (needLimit && parseFloat(limit) > 0 ? parseFloat(limit)
    : needStop && parseFloat(stop) > 0 ? parseFloat(stop)
    : price) || 0;
  const est = (parseFloat(qty) > 0 ? parseFloat(qty) : 0) * refPx;

  const submit = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('enter a quantity'); return; }
    if (needLimit && !(parseFloat(limit) > 0)) { setErr('enter a limit price'); return; }
    if (needStop && !(parseFloat(stop) > 0)) { setErr('enter a stop price'); return; }
    setBusy(true); setErr('');
    try {
      const res = await placeOrder({
        ticker, side, qty: q, sourceBoard, rationale, orderType: type,
        limitPrice: needLimit ? parseFloat(limit) : undefined,
        stopPrice: needStop ? parseFloat(stop) : undefined,
        stopLossPct: showSl && parseFloat(stopPct) > 0 ? parseFloat(stopPct) / 100 : undefined,
      });
      onDone(res);
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  return (
    <form onSubmit={submit} onClick={(e) => e.stopPropagation()}
      className="border border-neutral-800 bg-neutral-950/60 p-2.5 w-full max-w-sm space-y-2 text-[12px] font-mono">
      {/* Side toggle */}
      <div className="flex items-center gap-1">
        {['buy', 'sell'].map((s) => (
          <button key={s} type="button" onClick={() => setSide(s)}
            className={`flex-1 h-8 uppercase tracking-wider text-[11px] border ${
              side === s
                ? (s === 'buy' ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/10' : 'border-rose-500/60 text-rose-300 bg-rose-500/10')
                : 'border-neutral-700 text-neutral-500'
            }`}>
            {s}
          </button>
        ))}
      </div>

      {/* Shares owned (Agentic account) */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-neutral-500 uppercase tracking-widest">{ticker}</span>
        {owned === undefined ? (
          <span className="text-neutral-600 inline-flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> positions…</span>
        ) : owned == null ? (
          <span className="text-neutral-600">holdings n/a</span>
        ) : ownedQty > 0 ? (
          <button type="button" onClick={() => setQty(String(ownedQty))}
            className="text-neutral-300 hover:text-emerald-300" title="Use full position">
            you own <span className="text-neutral-100">{ownedQty}</span>
            {owned.avgCost ? <span className="text-neutral-500"> @ ${owned.avgCost}</span> : null}
            {!isBuy && <span className="text-emerald-400"> · sell all</span>}
          </button>
        ) : (
          <span className="text-neutral-600">no shares owned</span>
        )}
      </div>

      {/* Order type */}
      <div className="grid grid-cols-4 gap-1">
        {TYPES.map((t) => (
          <button key={t.key} type="button" onClick={() => setType(t.key)}
            className={`h-7 text-[10px] uppercase tracking-wider border ${
              type === t.key ? 'border-neutral-400 text-neutral-100 bg-neutral-800/60' : 'border-neutral-800 text-neutral-500'
            }`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* Fields */}
      <div className="flex flex-wrap gap-1.5">
        <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal" className={`${field} w-16`} autoFocus />
        {needStop && (
          <input value={stop} onChange={(e) => setStop(e.target.value)} placeholder="stop $" inputMode="decimal" className={`${field} w-20`} />
        )}
        {needLimit && (
          <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="limit $" inputMode="decimal" className={`${field} w-20`} />
        )}
        {type === 'market' && (
          <span className="inline-flex items-center px-2 h-8 text-[10px] uppercase tracking-wider text-neutral-500 border border-neutral-800">
            {price ? `~$${price}` : 'mkt'}
          </span>
        )}
        {showSl && (
          <span className="inline-flex items-center gap-1 px-1 h-8 border border-neutral-800" title="Stop-loss % below fill — a native Robinhood stop">
            <TrendingDown className="h-3 w-3 text-rose-400" />
            <input value={stopPct} onChange={(e) => setStopPct(e.target.value)} placeholder="stop%" inputMode="decimal"
              className="w-12 bg-transparent text-neutral-200 placeholder:text-neutral-600 outline-none text-[12px]" />
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy}
          className={`flex-1 h-9 uppercase tracking-wider text-[11px] border disabled:opacity-50 inline-flex items-center justify-center gap-1 ${
            isBuy ? 'border-emerald-500/60 text-emerald-300 bg-emerald-500/5' : 'border-rose-500/60 text-rose-300 bg-rose-500/5'
          }`}>
          {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
          {isBuy ? 'Buy' : 'Sell'} {ticker}{est ? ` · ~$${est.toFixed(0)}` : ''}
        </button>
        <button type="button" onClick={onCancel} className="px-2 h-9 text-neutral-500 border border-neutral-800">✕</button>
      </div>

      {err && <div className="text-rose-400 text-[10px] break-words">{err}</div>}
    </form>
  );
}
