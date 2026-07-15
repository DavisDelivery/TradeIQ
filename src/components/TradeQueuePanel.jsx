import React, { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys.js';
import { getIdToken } from '../lib/auth.js';

// Pending agentic orders. Renders inside the Journal — fills land below as
// journal entries, so the loop closes here. Cancel and "Mark filled" both
// require the Google sign-in (no shared secrets): the executor agent
// reports fills in chat; the owner confirms with one tap here, which
// writes the fill AND the source-tagged journal entry server-side.

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

async function authedPatch(body) {
  const token = await getIdToken();
  if (!token) throw new Error('sign in first (Settings)');
  const r = await fetch('/api/trade-queue', {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j;
}

function MarkFilledForm({ row, onDone }) {
  const [price, setPrice] = useState(row.limitPrice ? String(row.limitPrice) : '');
  const [qty, setQty] = useState(row.qty ? String(row.qty) : '');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const submit = async (ev) => {
    ev.preventDefault();
    setBusy(true);
    setErr('');
    try {
      await authedPatch({ id: row.id, action: 'execute', fill: { price: parseFloat(price), qty: parseFloat(qty) } });
      onDone();
    } catch (e) {
      setErr(String(e.message || e));
      setBusy(false);
    }
  };
  return (
    <form onSubmit={submit} className="inline-flex items-center gap-1.5 text-[11px] font-mono flex-wrap">
      <input value={price} onChange={(e) => setPrice(e.target.value)} placeholder="fill $" inputMode="decimal"
        className="w-20 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none" autoFocus />
      <input value={qty} onChange={(e) => setQty(e.target.value)} placeholder="qty" inputMode="decimal"
        className="w-14 h-7 px-1.5 bg-neutral-950 border border-neutral-700 text-neutral-200 placeholder:text-neutral-600 outline-none" />
      <button type="submit" disabled={busy} className="px-2 h-7 border border-emerald-500/50 text-emerald-300 uppercase tracking-wider text-[10px] disabled:opacity-50">
        {busy ? '…' : 'Confirm'}
      </button>
      {err && <span className="text-rose-400 text-[10px] max-w-[180px] truncate" title={err}>{err}</span>}
    </form>
  );
}

export function TradeQueuePanel() {
  const qc = useQueryClient();
  const [filling, setFilling] = useState(null); // row id being marked filled
  const { data, error } = useQuery({
    queryKey: [...queryKeys.all, 'tradeQueue'],
    queryFn: async ({ signal }) => {
      const r = await fetch('/api/trade-queue?status=all', { signal });
      const j = await r.json();
      if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
      return j;
    },
    staleTime: 60 * 1000,
    refetchInterval: 120 * 1000,
  });

  const rows = (data?.rows ?? []).filter((r) => r.status === 'queued');
  const recent = (data?.rows ?? []).filter((r) => r.status !== 'queued').slice(0, 5);
  if (error || (!rows.length && !recent.length)) return null; // quiet when unused

  const refresh = () => qc.invalidateQueries({ queryKey: [...queryKeys.all, 'tradeQueue'] });
  const cancel = async (id) => {
    try { await authedPatch({ id, action: 'cancel' }); refresh(); } catch { /* next refetch surfaces */ }
  };

  const statusStyle = (s) => ({
    queued: 'text-amber-400 border-amber-500/40 bg-amber-500/5',
    executed: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5',
    cancelled: 'text-neutral-500 border-neutral-700 bg-neutral-900/40',
    expired: 'text-neutral-500 border-neutral-700 bg-neutral-900/40',
  }[s]);

  return (
    <div className="border border-neutral-800 mb-4" data-testid="trade-queue-panel">
      <div className="px-4 py-2.5 border-b border-neutral-800/60 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-neutral-500 flex-wrap">
        <ShoppingCart className="h-3.5 w-3.5" /> Agentic order queue
        <span className="text-neutral-600">· queuing = approval · confirm fills here after the agent executes</span>
      </div>
      <div className="divide-y divide-neutral-900/60">
        {[...rows, ...recent].map((r) => (
          <div key={r.id} className="px-4 py-2 flex items-center gap-3 text-[12px] font-mono flex-wrap">
            <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border ${statusStyle(r.status)}`}>{r.status}</span>
            <span className="font-serif font-bold text-sm">{r.ticker}</span>
            <span className={r.side === 'sell' ? 'text-rose-300' : 'text-neutral-400'}>
              {r.side ?? 'buy'} {r.qty ?? '—'}{r.limitPrice ? ` @ ≤$${r.limitPrice}` : ' @ mkt'}
              {(r.stopPrice || r.stopLossPct) && (
                <span className="text-rose-400/80"> · stop {r.stopPrice ? `$${r.stopPrice}` : `${Math.round(r.stopLossPct * 100)}%`}</span>
              )}
            </span>
            <span className="text-[10px] text-neutral-500 uppercase">{r.sourceBoard}</span>
            <span className="text-[10px] text-neutral-500">{fmtWhen(r.queuedAt)}</span>
            {r.status === 'executed' && r.fill && (
              <span className="text-[10px] text-emerald-400">
                filled {r.fill.qty} @ ${r.fill.price}{r.stopOrder ? ` · stop $${r.stopOrder.stopPrice}` : ''}
              </span>
            )}
            {r.status === 'queued' && filling !== r.id && (
              <span className="ml-auto inline-flex gap-2">
                <button type="button" onClick={() => setFilling(r.id)}
                  className="px-2 py-0.5 text-[10px] uppercase tracking-wider border border-emerald-500/40 text-emerald-300 hover:bg-emerald-500/10">
                  Mark filled
                </button>
                <button type="button" onClick={() => cancel(r.id)}
                  className="px-2 py-0.5 text-[10px] uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-rose-300 hover:border-rose-500/50">
                  Cancel
                </button>
              </span>
            )}
            {r.status === 'queued' && filling === r.id && (
              <span className="ml-auto">
                <MarkFilledForm row={r} onDone={() => { setFilling(null); refresh(); }} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
