// HistoryView — snapshot replay.
//
// Pick a board + universe + snapshot date. Renders that historical snapshot
// exactly as it was when written. Read-only.
//
// Phase 1: useful immediately for "what was the model recommending on day X
// when I made trade Y" questions. Phase 4 backtest will consume the same
// snapshots programmatically, so this view is the human-facing eyeball
// equivalent.

import React, { useState, useEffect, useMemo } from 'react';
import { Clock, AlertCircle } from 'lucide-react';

const BOARDS = [
  { id: 'target-board', label: 'Target Board' },
  { id: 'prophet', label: 'Prophet' },
  { id: 'catalyst', label: 'Catalyst' },
  { id: 'insider', label: 'Insider' },
  { id: 'williams', label: 'Williams' },
  { id: 'lynch', label: 'Lynch' },
  { id: 'earnings', label: 'Earnings' },
];

const UNIVERSES_PER_BOARD = {
  'target-board': ['sp500', 'ndx', 'dow', 'russell2k'],
  prophet: ['sp500', 'ndx', 'dow', 'russell2k'],
  catalyst: ['sp500', 'ndx', 'dow', 'russell2k'],
  insider: ['sp500', 'ndx', 'dow', 'russell2k'],
  williams: ['sp500', 'ndx', 'dow', 'russell2k'],
  lynch: ['sp500', 'ndx', 'dow', 'russell2k'],
  earnings: ['all'],
};

function formatDate(iso) {
  if (!iso) return '—';
  try {
    const d = new Date(iso);
    return d.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatAge(iso) {
  if (!iso) return '';
  const ageMs = Date.now() - new Date(iso).getTime();
  const h = Math.round(ageMs / 3_600_000);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  return `${d}d ago`;
}

const HistoryView = () => {
  const [board, setBoard] = useState('target-board');
  const [universe, setUniverse] = useState('sp500');
  const [snapshots, setSnapshots] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [snapshot, setSnapshot] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingSnapshot, setLoadingSnapshot] = useState(false);
  const [error, setError] = useState(null);

  // Reset universe to a valid one when board changes
  useEffect(() => {
    const validUniverses = UNIVERSES_PER_BOARD[board] ?? ['sp500'];
    if (!validUniverses.includes(universe)) {
      setUniverse(validUniverses[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [board]);

  // Fetch snapshot list whenever board or universe changes
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSnapshot(null);
    setSelectedId(null);
    fetch(`/api/snapshot-history?board=${board}&universe=${universe}&limit=60`)
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || 'Failed to load snapshots');
          setSnapshots([]);
          return;
        }
        setSnapshots(json.snapshots ?? []);
        // Auto-select the newest
        if (json.snapshots && json.snapshots.length > 0) {
          setSelectedId(json.snapshots[0].snapshotId);
        }
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err?.message ?? err));
          setSnapshots([]);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => { cancelled = true; };
  }, [board, universe]);

  // Fetch the actual snapshot when selectedId changes
  useEffect(() => {
    if (!selectedId) {
      setSnapshot(null);
      return;
    }
    let cancelled = false;
    setLoadingSnapshot(true);
    setError(null);
    fetch(
      `/api/snapshot-history?board=${board}&universe=${universe}&snapshotId=${encodeURIComponent(selectedId)}`,
    )
      .then((r) => r.json())
      .then((json) => {
        if (cancelled) return;
        if (!json.ok) {
          setError(json.error || 'Failed to load snapshot');
          setSnapshot(null);
          return;
        }
        setSnapshot(json.snapshot);
      })
      .catch((err) => {
        if (!cancelled) {
          setError(String(err?.message ?? err));
          setSnapshot(null);
        }
      })
      .finally(() => {
        if (!cancelled) setLoadingSnapshot(false);
      });
    return () => { cancelled = true; };
  }, [selectedId, board, universe]);

  const validUniverses = UNIVERSES_PER_BOARD[board] ?? ['sp500'];

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto">
      <header className="mb-5 sm:mb-6">
        <div className="flex items-baseline gap-3 mb-2">
          <Clock className="h-4 w-4 text-emerald-400" />
          <h1 className="text-xl sm:text-2xl font-serif font-semibold text-neutral-100">
            History
          </h1>
        </div>
        <p className="text-[12px] text-neutral-500 leading-relaxed max-w-2xl">
          Replay any prior board snapshot. Useful for &ldquo;what was the model
          recommending on day X when I made trade Y&rdquo; questions. Snapshots
          start from when Phase 1 went live; older entries get backfilled from
          the trade journal.
        </p>
      </header>

      {/* Pickers */}
      <div className="flex flex-col sm:flex-row gap-3 mb-4">
        {/* Board picker */}
        <div className="flex flex-wrap gap-1">
          {BOARDS.map((b) => (
            <button
              key={b.id}
              onClick={() => setBoard(b.id)}
              className={`px-3 py-1.5 text-[12px] font-medium border transition-colors ${
                board === b.id
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
              }`}
            >
              {b.label}
            </button>
          ))}
        </div>
        {/* Universe picker */}
        <div className="flex gap-1 sm:ml-auto">
          {validUniverses.map((u) => (
            <button
              key={u}
              onClick={() => setUniverse(u)}
              className={`px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider border transition-colors ${
                universe === u
                  ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-400'
                  : 'bg-neutral-950/40 border-neutral-800 text-neutral-400 hover:border-neutral-700'
              }`}
            >
              {u}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-4 text-rose-300 font-mono text-sm flex items-start gap-2 mb-4">
          <AlertCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {loading && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          Loading snapshots…
        </div>
      )}

      {!loading && snapshots.length === 0 && !error && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
          No snapshots yet for {board} / {universe}. Once the scheduled scan
          has run a few times, history will populate here.
        </div>
      )}

      {!loading && snapshots.length > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-[260px_1fr] gap-4">
          {/* Snapshot list */}
          <aside className="border border-neutral-800 bg-neutral-950/40">
            <div className="px-3 py-2 border-b border-neutral-800 text-[10px] uppercase tracking-widest text-neutral-500 font-mono">
              {snapshots.length} snapshots
            </div>
            <div className="max-h-[60vh] overflow-y-auto">
              {snapshots.map((s) => {
                const isSelected = s.snapshotId === selectedId;
                return (
                  <button
                    key={s.snapshotId}
                    onClick={() => setSelectedId(s.snapshotId)}
                    className={`w-full text-left px-3 py-2 border-b border-neutral-900 transition-colors ${
                      isSelected
                        ? 'bg-emerald-500/10 text-emerald-300'
                        : 'hover:bg-neutral-900/40 text-neutral-300'
                    }`}
                  >
                    <div className="text-[11px] font-mono">{formatDate(s.generatedAt)}</div>
                    <div className="text-[10px] text-neutral-500 font-mono mt-0.5 flex justify-between">
                      <span>{formatAge(s.generatedAt)}</span>
                      <span>{s.resultsCount} rows</span>
                    </div>
                    {s.modelVersion && (
                      <div className="text-[10px] text-neutral-600 font-mono mt-0.5">
                        v{s.modelVersion}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </aside>

          {/* Snapshot detail */}
          <main>
            {loadingSnapshot && (
              <div className="border border-neutral-800 p-8 text-center text-neutral-500 font-mono text-sm">
                Loading snapshot…
              </div>
            )}
            {!loadingSnapshot && snapshot && (
              <SnapshotDetail board={board} universe={universe} snapshot={snapshot} />
            )}
          </main>
        </div>
      )}
    </div>
  );
};

const SnapshotDetail = ({ board, universe, snapshot }) => {
  const results = Array.isArray(snapshot?.results) ? snapshot.results : [];

  // Generic table: pick interesting columns based on first row's keys.
  const columns = useMemo(() => pickColumnsForBoard(board, results), [board, results]);

  return (
    <div className="border border-neutral-800 bg-neutral-950/40">
      <header className="px-4 py-3 border-b border-neutral-800 flex flex-wrap gap-3 items-baseline">
        <div className="font-serif text-sm text-neutral-200">
          {BOARDS.find((b) => b.id === board)?.label} ·{' '}
          <span className="font-mono uppercase text-neutral-400">{universe}</span>
        </div>
        <div className="text-[11px] text-neutral-500 font-mono ml-auto">
          {formatDate(snapshot.generatedAt)} · v{snapshot.modelVersion} ·{' '}
          {results.length}/{snapshot.universeChecked} rows ·{' '}
          {(snapshot.scanDurationMs / 1000).toFixed(1)}s scan
        </div>
      </header>

      {snapshot.warnings && snapshot.warnings.length > 0 && (
        <div className="px-4 py-2 border-b border-amber-800/30 bg-amber-950/20 text-amber-300 font-mono text-[11px]">
          {snapshot.warnings.length} warning(s):{' '}
          {snapshot.warnings.slice(0, 3).join(' · ')}
          {snapshot.warnings.length > 3 ? '…' : ''}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-[12px] font-mono">
          <thead className="bg-neutral-900/40 text-neutral-500 uppercase tracking-wider text-[10px]">
            <tr>
              {columns.map((c) => (
                <th key={c.key} className="px-3 py-2 text-left whitespace-nowrap">
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {results.slice(0, 200).map((row, i) => (
              <tr
                key={(row?.ticker ?? '') + i}
                className="border-t border-neutral-900 hover:bg-neutral-900/30"
              >
                {columns.map((c) => (
                  <td key={c.key} className="px-3 py-1.5 whitespace-nowrap">
                    {c.format(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {results.length > 200 && (
        <div className="px-4 py-2 border-t border-neutral-800 text-[11px] text-neutral-500 font-mono">
          Showing first 200 of {results.length} rows.
        </div>
      )}
    </div>
  );
};

// Per-board column selection. Each board has a different result shape; keep
// the table compact and meaningful by hand-picking a few key fields per board.
function pickColumnsForBoard(board, results) {
  const fmtNum = (v, digits = 2) =>
    v == null || !Number.isFinite(v) ? '—' : v.toFixed(digits);
  const fmtPct = (v) =>
    v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(1)}%`;
  const fmtInt = (v) => (v == null || !Number.isFinite(v) ? '—' : Math.round(v));

  const tickerCol = {
    key: 'ticker',
    label: 'Ticker',
    format: (r) => <span className="text-emerald-400">{r?.ticker ?? '—'}</span>,
  };

  switch (board) {
    case 'target-board':
      return [
        tickerCol,
        { key: 'score', label: 'Score', format: (r) => fmtInt(r?.score) },
        { key: 'price', label: 'Price', format: (r) => `$${fmtNum(r?.price)}` },
        { key: 'side', label: 'Side', format: (r) => r?.side ?? '—' },
        { key: 'rationale', label: 'Rationale', format: (r) => (
          <span className="text-neutral-400">{(r?.rationale ?? '').slice(0, 80)}</span>
        ) },
      ];
    case 'prophet':
      return [
        tickerCol,
        { key: 'score', label: 'Score', format: (r) => fmtInt(r?.score) },
        { key: 'conviction', label: 'Conviction', format: (r) => r?.conviction ?? '—' },
        { key: 'layers', label: 'Layers', format: (r) => {
          const ls = r?.layerResults ?? r?.layers ?? [];
          const passed = ls.filter((l) => l?.pass).length;
          return ls.length ? `${passed}/${ls.length}` : '—';
        } },
        { key: 'price', label: 'Price', format: (r) => `$${fmtNum(r?.price)}` },
      ];
    case 'catalyst':
      return [
        tickerCol,
        { key: 'score', label: 'Score', format: (r) => fmtInt(r?.score) },
        { key: 'conviction', label: 'Conv', format: (r) => r?.conviction ?? '—' },
        { key: 'tags', label: 'Tags', format: (r) => (r?.tags ?? []).slice(0, 3).join(' · ') || '—' },
        { key: 'price', label: 'Price', format: (r) => `$${fmtNum(r?.price)}` },
      ];
    case 'insider':
      return [
        tickerCol,
        { key: 'buyCount', label: 'Buys', format: (r) => fmtInt(r?.buyCount) },
        { key: 'buyDollars', label: '$ Bought', format: (r) =>
          r?.buyDollars ? `$${(r.buyDollars / 1000).toFixed(0)}k` : '—' },
        { key: 'topBuyer', label: 'Top Buyer', format: (r) =>
          r?.topBuyer?.name ? `${r.topBuyer.name} (${r.topBuyer.role || '?'})` : '—' },
        { key: 'mostRecent', label: 'Most Recent', format: (r) =>
          r?.mostRecentFiling ? formatDate(r.mostRecentFiling) : '—' },
      ];
    case 'williams':
      return [
        tickerCol,
        { key: 'score', label: 'Score', format: (r) => fmtInt(r?.score) },
        { key: 'side', label: 'Side', format: (r) => r?.side ?? '—' },
        { key: 'price', label: 'Price', format: (r) => `$${fmtNum(r?.price)}` },
        { key: 'reason', label: 'Setup', format: (r) =>
          <span className="text-neutral-400">{(r?.reason ?? '').slice(0, 60)}</span> },
      ];
    case 'lynch':
      return [
        tickerCol,
        { key: 'score', label: 'Score', format: (r) => fmtInt(r?.score) },
        { key: 'peg', label: 'PEG', format: (r) => fmtNum(r?.peg) },
        { key: 'pe', label: 'P/E', format: (r) => fmtNum(r?.pe, 1) },
        { key: 'growth', label: 'Growth', format: (r) => fmtPct(r?.growth) },
      ];
    case 'earnings':
      return [
        tickerCol,
        { key: 'composite', label: 'Score', format: (r) => fmtInt(r?.composite) },
        { key: 'reportDate', label: 'Reports', format: (r) => r?.reportDate ?? '—' },
        { key: 'daysUntil', label: 'Days', format: (r) =>
          r?.daysUntil != null ? (r.daysUntil < 0 ? `+${-r.daysUntil}d post` : `${r.daysUntil}d`) : '—' },
        { key: 'playType', label: 'Play', format: (r) => r?.playType ?? '—' },
        { key: 'ivr', label: 'IVR', format: (r) => fmtInt(r?.ivr) },
      ];
    default:
      // Generic fallback: ticker + first 4 numeric/string fields
      if (!results.length) return [tickerCol];
      const keys = Object.keys(results[0] || {}).filter((k) => k !== 'ticker').slice(0, 5);
      return [
        tickerCol,
        ...keys.map((k) => ({
          key: k,
          label: k,
          format: (r) => {
            const v = r?.[k];
            if (v == null) return '—';
            if (typeof v === 'number') return Number.isFinite(v) ? v.toFixed(2) : '—';
            if (typeof v === 'string') return v.slice(0, 40);
            return String(v).slice(0, 40);
          },
        })),
      ];
  }
}

export { HistoryView };
export default HistoryView;
