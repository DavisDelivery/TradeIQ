import React, { useState } from 'react';
import { ShoppingCart } from 'lucide-react';
import { getIdToken } from '../lib/auth.js';

// Queue a buy order for the execution agent. Queuing IS the approval — the
// human clicked it, signed in. Mutations carry the Firebase ID token
// (Google sign-in, Settings → Agentic Trading); the server verifies token
// + owner email and fails closed when unconfigured. No shared secrets.

export function QueueOrderButton({ ticker, sourceBoard, price, rationale, className = '' }) {
  const [state, setState] = useState('idle'); // idle | form | busy | queued | error
  const [qty, setQty] = useState('');
  const [limit, setLimit] = useState(price ? String(price) : '');
  const [err, setErr] = useState('');

  const submit = async (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    const q = parseFloat(qty);
    if (!(q > 0)) { setErr('qty required'); return; }
    setState('busy');
    setErr('');
    try {
      const token = await getIdToken();
      if (!token) throw new Error('sign in first (Settings → Agentic Trading)');
      const res = await fetch('/api/trade-queue', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({
          ticker,
          side: 'buy',
          qty: q,
          limitPrice: parseFloat(limit) > 0 ? parseFloat(limit) : undefined,
          sourceBoard,
          rationale,
        }),
      });
      const j = await res.json();
      if (!res.ok || !j.ok) throw new Error(j.error || `HTTP ${res.status}`);
      setState('queued');
    } catch (e) {
      setErr(String(e.message || e));
      setState('form');
    }
  };

  if (state === 'queued') {
    return (
      <span className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-emerald-300 border-emerald-500/40 bg-emerald-500/10 ${className}`}>
        <ShoppingCart className="h-3 w-3" /> queued for agent
      </span>
    );
  }

  if (state === 'form' || state === 'busy') {
    return (
      <form onSubmit={submit} onClick={(e) => e.stopPropagation()} className={`inline-flex items-center gap-1.5 text-[11px] font-mono flex-wrap ${className}`}>
        <input
          value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal"
          className="w-14 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
          autoFocus
        />
        <input
          value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="limit $" inputMode="decimal"
          className="w-20 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none focus:border-neutral-500"
        />
        <button type="submit" disabled={state === 'busy'} className="px-2 h-7 border border-emerald-500/50 text-emerald-300 uppercase tracking-wider text-[10px] disabled:opacity-50">
          {state === 'busy' ? '…' : 'Queue'}
        </button>
        <button type="button" onClick={(e) => { e.stopPropagation(); setState('idle'); }} className="px-1.5 h-7 text-neutral-500">✕</button>
        {err && <span className="text-rose-400 text-[10px] max-w-[220px] truncate" title={err}>{err}</span>}
      </form>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => { e.stopPropagation(); setState('form'); }}
      title="Queue a buy for the execution agent (requires sign-in; queuing = approval)"
      className={`inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-emerald-300 hover:border-emerald-500/50 transition-colors ${className}`}
    >
      <ShoppingCart className="h-3 w-3" /> Queue Buy
    </button>
  );
}
