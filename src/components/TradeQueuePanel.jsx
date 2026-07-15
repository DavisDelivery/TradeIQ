import React from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ShoppingCart } from 'lucide-react';
import { queryKeys } from '../lib/queryKeys.js';
import { TQ_TOKEN_KEY } from './QueueOrderButton.jsx';

// Pending agentic orders (runbook Phase 2). Renders inside the Journal —
// the queue's fills land here as journal entries, so this is where the
// loop closes. Cancel requires the trade-queue token (Settings).

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const fmtWhen = (iso) => {
  if (!iso) return '—';
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
};

export function TradeQueuePanel() {
  const qc = useQueryClient();
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

  const cancel = async (id) => {
    let token = '';
    try { token = localStorage.getItem(TQ_TOKEN_KEY) ?? ''; } catch { /* noop */ }
    try {
      const r = await fetch('/api/trade-queue', {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-trade-queue-token': token },
        body: JSON.stringify({ id, action: 'cancel' }),
      });
      if (r.ok) qc.invalidateQueries({ queryKey: [...queryKeys.all, 'tradeQueue'] });
    } catch { /* surfaced by next refetch */ }
  };

  const statusStyle = (s) => ({
    queued: 'text-amber-400 border-amber-500/40 bg-amber-500/5',
    executed: 'text-emerald-400 border-emerald-500/40 bg-emerald-500/5',
    cancelled: 'text-neutral-500 border-neutral-700 bg-neutral-900/40',
    expired: 'text-neutral-500 border-neutral-700 bg-neutral-900/40',
  }[s]);

  return (
    <div className="border border-neutral-800 mb-4" data-testid="trade-queue-panel">
      <div className="px-4 py-2.5 border-b border-neutral-800/60 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-neutral-500">
        <ShoppingCart className="h-3.5 w-3.5" /> Agentic order queue
        <span className="text-neutral-600">· queuing = approval · agent executes queued rows only</span>
      </div>
      <div className="divide-y divide-neutral-900/60">
        {[...rows, ...recent].map((r) => (
          <div key={r.id} className="px-4 py-2 flex items-center gap-3 text-[12px] font-mono flex-wrap">
            <span className={`px-1.5 py-0.5 text-[9px] uppercase tracking-wider border ${statusStyle(r.status)}`}>{r.status}</span>
            <span className="font-serif font-bold text-sm">{r.ticker}</span>
            <span className="text-neutral-400">
              buy {r.qty ?? '—'}{r.limitPrice ? ` @ ≤$${r.limitPrice}` : ' @ mkt'}
            </span>
            <span className="text-[10px] text-neutral-500 uppercase">{r.sourceBoard}</span>
            <span className="text-[10px] text-neutral-500">{fmtWhen(r.queuedAt)}</span>
            {r.status === 'executed' && r.fill && (
              <span className="text-[10px] text-emerald-400">filled {r.fill.qty} @ ${r.fill.price}</span>
            )}
            {r.status === 'queued' && (
              <button
                type="button"
                onClick={() => cancel(r.id)}
                className="ml-auto px-2 py-0.5 text-[10px] uppercase tracking-wider border border-neutral-700 text-neutral-400 hover:text-rose-300 hover:border-rose-500/50"
              >
                Cancel
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
