// Phase 6 PR-E — ScoreBreakdown for the StockDetailPanel.
//
// Renders the per-component decomposition that the rationale endpoints
// expose (PR-A surface-only): each component carries `name`, `score`,
// `weight`, `direction`, `rationale`, and a numeric `signals` object —
// plus optional `noData` / `noDataReason`.
//
// Layout: a sortable mini-table — name, score, weight, direction, rationale.
// `noData` rows are greyed and pinned to the bottom of the sort order. The
// useSortable + SortableTh standing pattern wires sort.
//
// Target board: the composite rationale endpoint returns per-analyst rows
// (the 4q AnalystContributions shape) rather than the PR-A components
// shape; rather than build a second table here, the component falls back
// to a "see Analyst Contributions section" hint when on the target board.

import React from 'react';
import { useWilliamsRationale } from '../../hooks/useWilliamsRationale.js';
import { useLynchRationale } from '../../hooks/useLynchRationale.js';
import { useSortable, SortableTh } from '../../lib/useSortable.jsx';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';

function DirectionIcon({ direction }) {
  if (direction === 'long')  return <ArrowUpRight className="h-3.5 w-3.5 text-emerald-400 inline" aria-label="long" />;
  if (direction === 'short') return <ArrowDownRight className="h-3.5 w-3.5 text-rose-400 inline" aria-label="short" />;
  return <Minus className="h-3.5 w-3.5 text-neutral-500 inline" aria-label="neutral" />;
}

function fmtSignal(v) {
  if (v === true) return 'yes';
  if (v === false) return 'no';
  if (v == null) return '—';
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2);
  return String(v);
}

export function ScoreBreakdown({ board, ticker }) {
  const isWilliams = board === 'williams';
  const isLynch = board === 'lynch';
  const williams = useWilliamsRationale(ticker, { enabled: isWilliams });
  const lynch = useLynchRationale(ticker, { enabled: isLynch });
  const q = isWilliams ? williams : isLynch ? lynch : null;

  const components = Array.isArray(q?.data?.components) ? q.data.components : [];
  const totalScore = q?.data?.score;

  const { sortKey, sortDir, sortBy, sortRows } = useSortable('score', 'desc');

  // Put noData rows at the bottom regardless of sort by adding a sort-bias
  // wrapper (sortable hook treats null as "always last", so map noData
  // rows' score to null for sorting).
  const sortable = components.map((c) => ({
    ...c,
    _sortScore: c.noData ? null : c.score,
    _sortWeight: c.noData ? null : c.weight,
    _sortName: c.name,
    _sortDirection: c.direction,
  }));
  const rowKeyMap = { score: '_sortScore', weight: '_sortWeight', name: '_sortName', direction: '_sortDirection' };
  const sorted = sortRows(sortable.map((r) => ({ ...r, [sortKey]: r[rowKeyMap[sortKey] ?? sortKey] })));

  const [expanded, setExpanded] = React.useState(() => new Set());
  function toggle(name) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name); else next.add(name);
      return next;
    });
  }

  return (
    <section
      data-testid="score-breakdown"
      className="border border-neutral-800/80 bg-neutral-950/30 p-4"
    >
      <header className="flex items-baseline justify-between gap-3 mb-3">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
          Score Breakdown
        </div>
        {totalScore != null && (
          <div className="text-[11px] font-mono text-neutral-400">
            total <span className="text-neutral-100">{Number(totalScore).toFixed(1)}</span>
          </div>
        )}
      </header>

      {!q && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">
          target composite — see Analyst Contributions for the per-analyst breakdown
        </div>
      )}

      {q && q.isLoading && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">loading components…</div>
      )}
      {q && q.isError && (
        <div className="space-y-2">
          <div className="text-[11px] font-mono uppercase tracking-widest text-rose-300">couldn't load breakdown</div>
          <button onClick={() => q.refetch()} className="px-3 h-7 border border-neutral-700 text-[10px] font-mono uppercase tracking-widest text-neutral-300 hover:text-neutral-100 hover:border-neutral-500">↻ retry</button>
        </div>
      )}

      {q && !q.isLoading && !q.isError && components.length === 0 && (
        <div className="text-[11px] font-mono uppercase tracking-widest text-neutral-600">no components surfaced</div>
      )}

      {q && !q.isLoading && !q.isError && components.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-[11px] font-mono" data-testid="score-breakdown-table">
            <thead>
              <tr className="text-neutral-500 uppercase tracking-widest text-[10px]">
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="name">Component</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="score">Score</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="weight">Weight</SortableTh>
                <SortableTh sortKey={sortKey} sortDir={sortDir} sortBy={sortBy} field="direction">Dir</SortableTh>
                <th className="text-left py-1 px-2">Rationale</th>
              </tr>
            </thead>
            <tbody>
              {sorted.map((c) => {
                const isOpen = expanded.has(c.name);
                const dimmed = c.noData;
                return (
                  <React.Fragment key={c.name}>
                    <tr
                      data-testid={`score-row-${c.name.replace(/\W+/g, '-')}`}
                      onClick={() => !dimmed && toggle(c.name)}
                      className={
                        'border-t border-neutral-800/60 ' +
                        (dimmed
                          ? 'text-neutral-600 italic cursor-default'
                          : 'text-neutral-200 cursor-pointer hover:bg-neutral-800/30')
                      }
                    >
                      <td className="py-1.5 px-2">{c.name}</td>
                      <td className="py-1.5 px-2 tabular-nums">{c.noData ? '—' : Number(c.score).toFixed(1)}</td>
                      <td className="py-1.5 px-2 tabular-nums">{(c.weight * 100).toFixed(1)}%</td>
                      <td className="py-1.5 px-2"><DirectionIcon direction={c.direction} /></td>
                      <td className="py-1.5 px-2 text-neutral-400">{c.rationale ?? '—'}</td>
                    </tr>
                    {!dimmed && isOpen && (
                      <tr className="bg-neutral-900/40 border-t border-neutral-800/60">
                        <td colSpan={5} className="py-2 px-3">
                          <SignalsTable signals={c.signals} />
                        </td>
                      </tr>
                    )}
                    {dimmed && c.noDataReason && (
                      <tr className="text-neutral-600">
                        <td colSpan={5} className="py-1 px-3 text-[10px]">{c.noDataReason}</td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
          <div className="mt-2 text-[9px] uppercase tracking-widest font-mono text-neutral-600">
            click a row to inspect signals
          </div>
        </div>
      )}
    </section>
  );
}

function SignalsTable({ signals }) {
  if (!signals || typeof signals !== 'object') {
    return <div className="text-[10px] text-neutral-600 font-mono">no signal detail</div>;
  }
  const entries = Object.entries(signals);
  if (entries.length === 0) return <div className="text-[10px] text-neutral-600 font-mono">no signal detail</div>;
  return (
    <dl className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-1 text-[10px] font-mono">
      {entries.map(([k, v]) => (
        <div key={k} className="flex items-baseline gap-2">
          <dt className="text-neutral-500">{k}</dt>
          <dd className="text-neutral-200 tabular-nums">{fmtSignal(v)}</dd>
        </div>
      ))}
    </dl>
  );
}
