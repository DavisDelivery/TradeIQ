import React, { useState } from 'react';
import { ShoppingCart, TrendingDown } from 'lucide-react';
import { getIdToken } from '../lib/auth.js';

// Buy / Sell order buttons wired to the trade queue. Queuing IS the
// approval (you clicked it, signed in). A buy can carry a stop-loss —
// the executor places a NATIVE Robinhood stop order at fill, so the
// protection lives at the broker and fires without any session running.
// Mutations send the app session token; the server verifies its signature.

async function queue(payload) {
  const token = await getIdToken();
  if (!token) throw new Error('sign in first (Settings → Agentic Trading)');
  const res = await fetch('/api/trade-queue', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const j = await res.json();
  if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

function OrderForm({ side, ticker, sourceBoard, price, rationale, onQueued, onCancel }) {
  const [qty, setQty] = useState('');
  const [limit, setLimit] = useState(price ? String(price) : '');
  const [stopPct, setStopPct] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const isBuy = side === 'buy';

  const submit = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('qty required'); return; }
    setBusy(true); setErr('');
    try {
      await queue({
        ticker, side, qty: q, sourceBoard, rationale,
        limitPrice: parseFloat(limit) > 0 ? parseFloat(limit) : undefined,
        stopLossPct: isBuy && parseFloat(stopPct) > 0 ? parseFloat(stopPct) / 100 : undefined,
      });
      onQueued();
    } catch (e) { setErr(String(e.message || e)); setBusy(false); }
  };

  return (
    <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className="inline-flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
      <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal"
        className="w-14 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" autoFocus />
      <input value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="limit $" inputMode="decimal"
        className="w-20 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" />
      {isBuy && (
        <span className="inline-flex items-center gap-1" title="Stop-loss % below fill — placed as a native Robinhood stop order">
          <TrendingDown className="h-3 w-3 text-rose-400" />
          <input value={stopPct} onChange={(e) => setStopPct(e.target.value)} placeholder="stop %" inputMode="decimal"
            className="w-16 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500" />
        </span>
      )}
      <button type="submit" disabled={busy}
        className={`px-2 h-7 uppercase tracking-wider text-[10px] border disabled:opacity-50 ${isBuy ? 'border-emerald-500/50 text-emerald-300' : 'border-rose-500/50 text-rose-300'}`}>
        {busy ? '…' : isBuy ? 'Queue buy' : 'Queue sell'}
      </button>
      <button type="button" onClick={(e) => { e.stopPropagation(); onCancel(); }} className="px-1.5 h-7 text-neutral-500">✕</button>
      {err && <span className="text-rose-400 text-[10px] max-w-[220px] truncate" title={err}>{err}</span>}
    </form>
  );
}

export function OrderButtons({ ticker, sourceBoard, price, rationale, sellable = true, className = '' }) {
  const [mode, setMode] = useState('idle'); // idle | buy | sell | queued
  if (mode === 'queued') {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-emerald-300 border-emerald-500/40 bg-emerald-500/10 ${className}`}>
        <ShoppingCart className="h-3 w-3" /> queued for agent
      </span>
    );
  }
  if (mode === 'buy' || mode === 'sell') {
    return (
      <OrderForm side={mode} ticker={ticker} sourceBoard={sourceBoard} price={price} rationale={rationale}
        onQueued={() => setMode('queued')} onCancel={() => setMode('idle')} className={className} />
    );
  }
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <button type="button" onClick={(e) => { e.stopPropagation(); setMode('buy'); }}
        title="Queue a buy (optional stop-loss) for the execution agent"
        className="inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors">
        <ShoppingCart className="h-3 w-3" /> Buy
      </button>
      {sellable && (
        <button type="button" onClick={(e) => { e.stopPropagation(); setMode('sell'); }}
          title="Queue a sell for the execution agent"
          className="inline-flex items-center px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-rose-300 hover:border-rose-500/50 transition-colors">
          Sell
        </button>
      )}
    </span>
  );
}
