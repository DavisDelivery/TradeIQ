import { useState, useMemo } from 'react';
import { BookOpen, AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { useScreenCatalog, useScreen } from './hooks/useScreens.js';
import { useSortable, SortableTh } from './lib/useSortable.jsx';
import { useLiveRows } from './hooks/useLiveQuotes.js';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

// FVZ-3 — published screening strategies (Minervini, CAN SLIM, Piotroski,
// Magic Formula, PEAD, ...) run over the Finviz universe.
//
// The evidence badge is the point of this view, not decoration. These
// strategies have wildly different empirical support and the app should not
// launder that difference away: an academically replicated anomaly and a
// famous trader's unaudited checklist must not look identical in the UI.
// The 'contrary' grade exists specifically so the short-squeeze screen can
// ship while stating that the published evidence points the other way.

const EVIDENCE = {
  academic: {
    label: 'Peer-reviewed',
    cls: 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10',
    blurb: 'Published, replicated academic evidence',
  },
  'paper-portfolio': {
    label: 'Tracked screen',
    cls: 'text-sky-300 border-sky-500/40 bg-sky-500/10',
    blurb: 'Long-tracked paper portfolio — no costs or slippage modelled',
  },
  mixed: {
    label: 'Mixed',
    cls: 'text-amber-300 border-amber-500/40 bg-amber-500/10',
    blurb: 'Self-reported results exceed independent replication',
  },
  anecdotal: {
    label: 'Anecdotal',
    cls: 'text-orange-300 border-orange-500/40 bg-orange-500/10',
    blurb: 'Famous practitioner, no independent backtest',
  },
  contrary: {
    label: 'Evidence against',
    cls: 'text-rose-300 border-rose-500/40 bg-rose-500/10',
    blurb: 'Published research contradicts the premise — speculative',
  },
};

const UNIVERSES = [
  { id: 'sp500', label: 'S&P 500' },
  { id: 'ndx', label: 'Nasdaq 100' },
  { id: 'russell2k', label: 'Russell 2000' },
  { id: 'dji', label: 'Dow 30' },
];

export const fmtNum = (v, digits = 2) =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : '—';

export const fmtPct = (v) =>
  typeof v === 'number' && Number.isFinite(v) ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';

export const fmtMcap = (m) => {
  if (typeof m !== 'number' || !Number.isFinite(m)) return '—';
  if (m >= 1_000_000) return `$${(m / 1_000_000).toFixed(2)}T`;
  if (m >= 1000) return `$${(m / 1000).toFixed(1)}B`;
  return `$${m.toFixed(0)}M`;
};

const EvidenceBadge = ({ grade }) => {
  const e = EVIDENCE[grade] ?? EVIDENCE.anecdotal;
  return (
    <span
      title={e.blurb}
      className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${e.cls}`}
    >
      {grade === 'contrary' && <AlertTriangle className="h-3 w-3" />}
      {e.label}
    </span>
  );
};

export const ScreensView = () => {
  const [screenId, setScreenId] = useState('high52w');
  const [universe, setUniverse] = useState('sp500');
  const [selected, setSelected] = useState(null);

  const { data: catalog, isLoading: catalogLoading } = useScreenCatalog();
  const { data, error, isLoading, isFetching } = useScreen(screenId, universe);
  const { sortKey, sortDir, sortBy, sortRows } = useSortable(null, 'desc');

  const screens = catalog?.screens ?? [];
  const meta = data?.screen;

  // Preserve the server's ranking until the user picks a column: these
  // screens are RANKED lists (the 52-week-high and Tiny Titans rules are
  // rankings in their published form), so an arbitrary default sort would
  // misrepresent the strategy.
  const sorted = useMemo(
    () => (sortKey ? sortRows(data?.rows ?? []) : (data?.rows ?? [])),
    [data, sortKey, sortRows],
  );
  const rows = useLiveRows(sorted, { priceKey: 'price', pctKey: 'changePct' });

  const th = { sortKey, sortDir, sortBy };

  const list = (
    <div className="px-3 py-4 sm:p-6 max-w-[1600px] mx-auto">
      <div className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
          Published strategies · Finviz universe · real-time
        </div>
        <h1 className="font-serif text-3xl font-bold tracking-tight">
          <span className="text-amber-300">{rows.length}</span>{' '}
          <span className="text-neutral-500 italic font-light">
            match{rows.length === 1 ? '' : 'es'}
          </span>
          {meta && <span className="ml-3 align-middle"><EvidenceBadge grade={meta.evidence} /></span>}
        </h1>
      </div>

      {/* Screen picker */}
      <div className="flex flex-wrap gap-1.5 mb-3">
        {catalogLoading && (
          <div className="h-8 w-64 bg-neutral-900 animate-pulse border border-neutral-800" />
        )}
        {screens.map((s) => (
          <button
            key={s.id}
            onClick={() => {
              setScreenId(s.id);
              setSelected(null);
            }}
            title={s.thesis}
            className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest border transition-colors ${
              screenId === s.id
                ? 'border-amber-500/50 bg-amber-500/10 text-amber-300'
                : 'border-neutral-800 text-neutral-400 hover:text-neutral-200 hover:border-neutral-700'
            }`}
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* Universe */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex border border-neutral-800">
          {UNIVERSES.map((u) => (
            <button
              key={u.id}
              onClick={() => setUniverse(u.id)}
              className={`px-3 h-8 text-[11px] font-mono uppercase tracking-widest transition-colors ${
                universe === u.id
                  ? 'bg-neutral-800 text-neutral-100'
                  : 'text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {u.label}
            </button>
          ))}
        </div>
        {data?.universeChecked > 0 && (
          <span className="px-2 py-1 text-[10px] font-mono uppercase tracking-wider border text-neutral-400 border-neutral-800 bg-neutral-950/60">
            {data.universeChecked} scanned
            {isFetching && ' · refreshing'}
          </span>
        )}
      </div>

      {/* Thesis + evidence */}
      {meta && (
        <div className="border border-neutral-800 bg-neutral-950/50 p-4 mb-4">
          <div className="flex items-start gap-2 mb-2">
            <BookOpen className="h-4 w-4 text-neutral-500 shrink-0 mt-0.5" />
            <div>
              <div className="text-neutral-200 text-sm">{meta.thesis}</div>
              <div className="text-[11px] text-neutral-500 font-mono mt-0.5">
                {meta.popularizedBy}
              </div>
            </div>
          </div>
          <p className="text-[12px] text-neutral-400 leading-relaxed">{meta.evidenceNote}</p>
          {meta.source && (
            <a
              href={meta.source}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 mt-2 text-[11px] font-mono text-sky-400 hover:text-sky-300"
            >
              source <ExternalLink className="h-3 w-3" />
            </a>
          )}
          {meta.approximations?.length > 0 && (
            <div className="mt-3 pt-3 border-t border-neutral-800/80">
              <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-amber-400/80 mb-1">
                <Info className="h-3 w-3" /> what this screen cannot reproduce
              </div>
              <ul className="list-disc list-inside space-y-1">
                {meta.approximations.map((a, i) => (
                  <li key={i} className="text-[11px] text-neutral-500 leading-relaxed">
                    {a}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-3 text-rose-300 font-mono text-[11px] mb-4">
          refresh failed: {error.message}
          {rows.length > 0 && ' — showing last loaded data'}
        </div>
      )}

      {isLoading && !rows.length && (
        <div className="space-y-1">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="h-11 bg-neutral-900 animate-pulse" />
          ))}
        </div>
      )}

      {!isLoading && !error && rows.length === 0 && (
        <div className="border border-neutral-800 p-10 text-center">
          <div className="text-neutral-400 mb-1">No matches today</div>
          <div className="text-[11px] text-neutral-600 font-mono">
            An empty screen is a real answer — these are strict criteria, and a
            mean-reversion screen should be empty in a melt-up.
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div className="overflow-x-auto border border-neutral-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-neutral-800 bg-neutral-950/60">
                <th className="px-3 py-2 text-left text-[10px] font-mono uppercase tracking-widest text-neutral-500">
                  #
                </th>
                <SortableTh {...th} field="ticker" align="left">Ticker</SortableTh>
                <SortableTh {...th} field="sector" align="left">Sector</SortableTh>
                <SortableTh {...th} field="price">Price</SortableTh>
                <SortableTh {...th} field="changePct">Chg</SortableTh>
                <SortableTh {...th} field="marketCapM">Mkt Cap</SortableTh>
                <SortableTh {...th} field="pe">P/E</SortableTh>
                <SortableTh {...th} field="perfYearPct">1Y</SortableTh>
                <SortableTh {...th} field="high52wDistPct">vs 52wH</SortableTh>
                <SortableTh {...th} field="rsi14">RSI</SortableTh>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr
                  key={r.ticker}
                  className="border-b border-neutral-900 hover:bg-neutral-900/40 transition-colors"
                >
                  <td className="px-3 py-2 text-[11px] font-mono text-neutral-600 tabular-nums">
                    {i + 1}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setSelected(r)}
                      className="font-serif font-bold text-neutral-100 hover:text-amber-300 transition-colors"
                    >
                      {r.ticker}
                    </button>
                  </td>
                  <td className="px-3 py-2 text-[11px] text-neutral-500">{r.sector ?? '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-200">
                    {fmtNum(r.price)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      (r.changePct ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}
                  >
                    {fmtPct(r.changePct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                    {fmtMcap(r.marketCapM)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                    {fmtNum(r.pe, 1)}
                  </td>
                  <td
                    className={`px-3 py-2 text-right tabular-nums ${
                      (r.perfYearPct ?? 0) >= 0 ? 'text-emerald-400/80' : 'text-rose-400/80'
                    }`}
                  >
                    {fmtPct(r.perfYearPct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                    {fmtPct(r.high52wDistPct)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums text-neutral-400">
                    {fmtNum(r.rsi14, 0)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={
        selected ? (
          <StockDetailPanel board="screens" ticker={selected.ticker} row={selected} />
        ) : null
      }
      closeLabel="Close detail"
    />
  );
};
