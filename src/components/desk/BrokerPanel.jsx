import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Landmark } from 'lucide-react';
import { queryKeys } from '../../lib/queryKeys.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';

// Robinhood Agentic account snapshot — balance, buying power, positions —
// as last reported by the execution agent (broker-sync). Display-only and
// labeled with its source + timestamp; hidden until the first sync lands.

const fmtUsd = (v) =>
  v == null ? '—' : `$${Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;

const fmtAgo = (iso) => {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

export function BrokerPanel() {
  const { data } = useQuery({
    queryKey: [...queryKeys.all, 'brokerSnapshot'],
    queryFn: async ({ signal }) => {
      const r = await fetch('/api/broker-sync', { signal });
      return r.json();
    },
    staleTime: 5 * 60 * 1000,
    refetchInterval: 10 * 60 * 1000,
  });
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('marketValue', 'desc');

  if (!data?.available) return null;
  const positions = sortRows(data.positions ?? []);
  const th = { sortKey, sortDir, sortBy };

  return (
    <div className="border border-neutral-800" data-testid="broker-panel">
      <div className="px-4 py-2.5 border-b border-neutral-800/60 flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest text-neutral-500 flex-wrap">
        <Landmark className="h-3.5 w-3.5" /> Agentic account {data.accountMasked}
        <span className="ml-auto text-neutral-600" title={data.syncedAt}>synced {fmtAgo(data.syncedAt)} · {data.source}</span>
      </div>
      <div className="grid grid-cols-3 gap-px bg-neutral-900/60">
        <div className="bg-[inherit] px-4 py-2.5">
          <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">Value</div>
          <div className="font-mono text-base text-neutral-200 tabular-nums">{fmtUsd(data.totalValue)}</div>
        </div>
        <div className="px-4 py-2.5">
          <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">Buying power</div>
          <div className="font-mono text-base text-emerald-400 tabular-nums">{fmtUsd(data.buyingPower)}</div>
        </div>
        <div className="px-4 py-2.5">
          <div className="text-[9px] font-mono uppercase tracking-widest text-neutral-500">
            {data.pendingDeposits ? 'Pending deposits' : 'Cash'}
          </div>
          <div className="font-mono text-base text-neutral-300 tabular-nums">
            {fmtUsd(data.pendingDeposits || data.cash)}
          </div>
        </div>
      </div>
      {positions.length > 0 && (
        <div className="overflow-x-auto border-t border-neutral-800/60">
          <table className="w-full text-[11px] font-mono">
            <thead>
              <tr className="text-neutral-500 border-b border-neutral-800/60">
                <SortableTh {...th} field="symbol">Sym</SortableTh>
                <SortableTh {...th} field="qty" align="right">Qty</SortableTh>
                <SortableTh {...th} field="avgCost" align="right">Avg</SortableTh>
                <SortableTh {...th} field="marketValue" align="right">Value</SortableTh>
              </tr>
            </thead>
            <tbody>
              {positions.map((p) => (
                <tr key={p.symbol} className="border-b border-neutral-900/50">
                  <td className="px-3 py-1.5 font-semibold text-neutral-200">{p.symbol}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-300">{p.qty ?? '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-400">{p.avgCost != null ? `$${p.avgCost}` : '—'}</td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-neutral-200">{fmtUsd(p.marketValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
