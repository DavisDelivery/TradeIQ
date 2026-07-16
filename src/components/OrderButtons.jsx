import React, { useState } from 'react';
import { ShoppingCart, TrendingDown, Check } from 'lucide-react';
import { getIdToken } from '../lib/auth.js';

// Buy / Sell buttons that place a REAL Robinhood order at a click
// (broker-execute). You clicked it + you're signed in = the approval. A buy
// can carry a stop-loss — a NATIVE Robinhood sell-stop is placed at fill so
// the protection lives at the broker. Guardrails on the server: long-only,
// ~$500 per order. If Robinhood isn't connected yet the server returns a
// clear "connect first" that we surface here.

async function execute(payload) {
  const token = await getIdToken();
  if (!token) throw new Error('sign in to TradeIQ first (Settings)');
  const res = await fetch('/api/broker-execute', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (res.status === 409 && j.needsConnect) throw new Error('Connect Robinhood in Settings first');
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function OrderForm({ side, ticker, sourceBoard, price, rationale, onDone, onCancel }) {
  const [qty, setQty] = useState('');
  const [limit, setLimit] = useState('');
  const [stopPct, setStopPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isBuy = side === 'buy';
  const est = (parseFloat(qty) > 0 ? parseFloat(qty) : 0) * (parseFloat(limit) > 0 ? parseFloat(limit) : (price || 0));

  const submit = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('qty required'); return; }
    setBusy(true); setErr('');
    try {
      const res = await execute({
        ticker, side, qty: q, sourceBoard, rationale,
        limitPrice: parseFloat(limit) > 0 ? parseFloat(limit) : undefined,
        stopLossPct: isBuy && parseFloat(stopPct) > 0 ? parseFloat(stopPct) / 100 : undefined,
      });
      onDone(res);
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  return (
    <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
      <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal"
        className="w-14 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" autoFocus />
      <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder={price ? `mkt ~$${price}` : 'limit $'} inputMode="decimal"
        className="w-24 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" />
      {isBuy && (
        <span className="inline-flex items-center gap-1" title="Stop-loss % below fill — placed as a native Robinhood stop order">
          <TrendingDown className="h-3 w-3 text-rose-400" />
          <input value={stopPct} onChange={(e) => setStopPct(e.target.value)} placeholder="stop %" inputMode="decimal"
            className="w-16 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" />
        </span>
      )}
      <button type="submit" disabled={busy}
        className={`px-2 h-7 uppercase tracking-wider text-[10px] border disabled:opacity-50 ${isBuy ? 'border-emerald-500/50 text-emerald-300' : 'border-rose-500/50 text-rose-300'}`}>
        {busy ? '…' : isBuy ? `Buy${est ? ` ~$${est.toFixed(0)}` : ''}` : `Sell${est ? ` ~$${est.toFixed(0)}` : ''}`}
      </button>
      <button type="button" onClick={(e) => { e.stopPropagation(); onCancel(); }} className="px-1.5 h-7 text-neutral-500">✕</button>
      {err && <span className="text-rose-400 text-[10px] max-w-[240px] truncate" title={err}>{err}</span>}
    </form>
  );
}

export function OrderButtons({ ticker, sourceBoard, price, rationale, sellable = true, className = '' }) {
  const [mode, setMode] = useState('idle'); // idle | buy | sell | done
  const [done, setDone] = useState(null); // execute result

  if (mode === 'done' && done) {
    const o = done.order || {};
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-emerald-300 border-emerald-500/40 bg-emerald-500/10 ${className}`}>
        <Check className="h-3 w-3" /> {o.side} {o.qty} @ ${o.price}{done.stopOrder ? ` · stop $${done.stopOrder.stopPrice}` : ''}
      </span>
    );
  }
  if (mode === 'buy' || mode === 'sell') {
    return (
      <OrderForm side={mode} ticker={ticker} sourceBoard={sourceBoard} price={price} rationale={rationale}
        onDone={(res) => { setDone(res); setMode('done'); }} onCancel={() => setMode('idle')} className={className} />
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setMode('buy'); }}
        title="Place a real Robinhood buy (optional stop-loss)"
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors">
        <ShoppingCart className="h-3 w-3" /> Buy
      </button>
      {sellable && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setMode('sell'); }}
          title="Place a real Robinhood sell"
          className="inline-flex items-center px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors">
          Sell
        </button>
      )}
    </span>
  );
}
