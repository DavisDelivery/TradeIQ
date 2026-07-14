import React, { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, Sparkles } from 'lucide-react';
import { useCrosses } from './hooks/useCrosses.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';

// CROSSES — every SMA50/SMA200 golden + death cross across the S&P 500,
// detected nightly on completed closes (scan-crosses-sp500.ts). Default
// sort is by date (newest first); every column header sorts.

const TYPE_FILTERS = [
  { id: 'all', label: 'All' },
  { id: 'golden', label: 'Golden' },
  { id: 'death', label: 'Death' },
];
const WINDOWS = [
  { days: 30, label: '30D' },
  { days: 90, label: '90D' },
  { days: 180, label: '180D' },
  { days: 365, label: '1Y' },
];

// A cross is "new" for its first 5 completed bars — these are also the
// rows the Alerts view surfaces.
export const NEW_CROSS_MAX_BARS_AGO = 5;

// Dates from the API are YYYY-MM-DD (UTC trading day). Format WITHOUT a
// local-timezone round trip so US users don't see the previous day
// (audit F3 — the UTC-shift class of bug).
export function formatCrossDate(iso) {
  if (!iso || typeof iso !== 'string') return '—';
  const [y, m, d] = iso.split('-').map(Number);
  if (!y || !m || !d) return iso;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${months[m - 1]} ${d}, ${y}`;
}

function formatAgo(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

const TypePill = ({ type }) =>
  type === 'golden' ? (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border text-amber-300 border-amber-500/40 bg-amber-500/5">
      <TrendingUp className="h-3 w-3" /> Golden
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border text-rose-400 border-rose-500/40 bg-rose-500/5">
      <TrendingDown className="h-3 w-3" /> Death
    </span>
  );

export const CrossesView = () => {
  const [type, setType] = useState('all');
  const [days, setDays] = useState(365);
  const { data, error, isLoading } = useCrosses(type, days);
  const { sortKey, sortDir, sortBy, sortRows } = useSortable('date', 'desc');

  const rows = useMemo(() => sortRows(data?.rows ?? []), [data, sortRows]);
  const freshCount = useMemo(
    () => (data?.rows ?? []).filter((r) => r.barsAgo <= NEW_CROSS_MAX_BARS_AGO).length,
    [data],
  );

  const th = { sortKey, sortDir, sortBy };

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
            SMA50 / SMA200 · S&amp;P 500 · nightly on completed closes
          </div>
          <h1 className="font-serif text-3xl font-bold tracking-tight">
            <span className="text-amber-300">{rows.length}</span>{' '}
            <span className="text-neutral-500 italic font-light">
              cross{rows.length === 1 ? '' : 'es'}
            </span>
            {freshCount > 0 && (
              <span className="ml-3 align-middle inline-flex items-center gap-1 px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-emerald-300 border-emerald-500/40 bg-emerald-500/10">
                <Sparkles className="h-3 w-3" /> {freshCount} new
              </span>
            )}
          </h1>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          {data?.generatedAt && (
            <span
              className={`px-2 py-1 text-[10px] font-mono uppercase tracking-wider border ${
                data.stale
                  ? 'text-amber-400 border-amber-500/40 bg-amber-500/5'
                  : 'text-neutral-400 border-neutral-800 bg-neutral-950/60'
              }`}
              title={data.generatedAt}
            >
              {data.stale ? 'stale · ' : ''}scanned {formatAgo(data.generatedAt)}
            </span>
          )}
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex border border-neutral-800">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.id}
              onClick={() => setType(f.id)}
              className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest transition-colors ${
                type === f.id ? 'text-emerald-300 bg-emerald-500/10' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex border border-neutral-800">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              onClick={() => setDays(w.days)}
              className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest transition-colors ${
                days === w.days ? 'text-emerald-300 bg-emerald-500/10' : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {/* Error: inline banner only — cached rows keep rendering (audit F1). */}
      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-3 text-rose-300 font-mono text-[11px] mb-4">
          refresh failed: {error.message} {rows.length > 0 && '— showing last loaded data'}
        </div>
      )}

      {isLoading && !rows.length && (
        <div className="border border-neutral-800 overflow-hidden" data-testid="crosses-skeleton">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-11 border-b border-neutral-900/60 bg-neutral-900/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-500 font-mono text-sm mb-2">No {type === 'all' ? '' : type + ' '}crosses in the last {days} days.</div>
          <div className="text-neutral-600 text-[11px] font-mono">
            {data?.generatedAt ? 'Crosses appear here the evening they form on completed closes.' : 'First nightly scan has not completed yet.'}
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="border border-neutral-800 overflow-x-auto">
          <table className="w-full min-w-[760px]">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-950/60">
                <SortableTh {...th} field="date">Date</SortableTh>
                <SortableTh {...th} field="ticker">Ticker</SortableTh>
                <SortableTh {...th} field="type">Type</SortableTh>
                <SortableTh {...th} field="sector">Sector</SortableTh>
                <SortableTh {...th} field="closeAtCross">Price @ Cross</SortableTh>
                <SortableTh {...th} field="lastClose">Last</SortableTh>
                <SortableTh {...th} field="pctSinceCross">% Since</SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const isNew = r.barsAgo <= NEW_CROSS_MAX_BARS_AGO;
                return (
                  <tr key={`${r.ticker}-${r.date}-${r.type}`} className="border-b border-neutral-800/60 hover:bg-neutral-900/40">
                    <td className="px-4 py-2.5 font-mono text-[12px] text-neutral-300 whitespace-nowrap">
                      {formatCrossDate(r.date)}
                      {isNew && (
                        <span className="ml-2 px-1.5 py-0.5 text-[9px] font-mono uppercase tracking-wider text-emerald-300 border border-emerald-500/40 bg-emerald-500/10">
                          new
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-2.5">
                      <span className="font-serif font-bold text-base">{r.ticker}</span>
                      {r.name && <span className="hidden sm:inline ml-2 text-[11px] text-neutral-500 truncate">{r.name}</span>}
                    </td>
                    <td className="px-4 py-2.5"><TypePill type={r.type} /></td>
                    <td className="px-4 py-2.5 text-[11px] text-neutral-400 whitespace-nowrap">{r.sector ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-neutral-300">${r.closeAtCross?.toFixed(2) ?? '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-[12px] text-neutral-200">${r.lastClose?.toFixed(2) ?? '—'}</td>
                    <td className={`px-4 py-2.5 font-mono text-[12px] font-semibold ${r.pctSinceCross > 0 ? 'text-emerald-400' : r.pctSinceCross < 0 ? 'text-rose-400' : 'text-neutral-400'}`}>
                      {r.pctSinceCross > 0 ? '+' : ''}{r.pctSinceCross?.toFixed(1)}%
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {data?.generatedAt && rows.length > 0 && (
        <div className="text-[10px] font-mono text-neutral-500 mt-3 text-right">
          {data.universeChecked} tickers scanned · detection on completed daily closes
        </div>
      )}
    </div>
  );
};
