import React, { useState } from 'react';
import { TickerDetailModal } from './components/detail/TickerDetailModal.jsx';
import { Search, FileText, AlertTriangle, ExternalLink, Info } from 'lucide-react';
import { useTrendExposure } from './hooks/useTrendExposure.js';
import { VerdictChip } from './components/VerdictChip.jsx';
import { Ticker } from './components/Ticker.jsx';

// TREND EXPOSURE — "who is exposed to this phrase?"
//
// This is an ATTRIBUTION tool, not a screener and not a signal board. You
// type a consumer phrase; it tells you which public filers actually write
// that phrase into their SEC filings, and how concentrated those mentions
// are. Both are facts about disclosure.
//
// What it deliberately does NOT do: score, rank by expected return, or say
// buy/sell. The consumer-attention signal that motivated this work was
// measured and failed its placebo test (verdicts.ts `trend`), so the tab
// ships with the part that survived — entity resolution — and the header
// carries the NO EDGE chip so the provenance travels with the UI.
//
// Lives in the Unvalidated nav section alongside Sentiment.

const EXAMPLES = [
  { q: 'Prime Hydration', why: 'private brand — returns its suppliers/competitors' },
  { q: 'HeyDude', why: 'clean single-owner attribution' },
  { q: 'Celsius Holdings', why: 'legal suffix disambiguates the homonym' },
  { q: 'Celsius', why: 'bare token — ambiguous, mostly degrees Celsius' },
  { q: 'GLP-1', why: 'category term across many filers' },
];

const FORMS = ['10-K', '10-Q', '8-K'];
const WINDOWS = [
  { days: 730, label: '2y' },
  { days: 1825, label: '5y' },
  { days: 9000, label: 'Max' },
];

const pct = (x, d = 1) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—');
const signed = (x) =>
  Number.isFinite(x) ? `${x > 0 ? '+' : ''}${x.toFixed(0)}%` : '—';

const edgarUrl = (cik) =>
  `https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=${cik}&type=10-K`;

// Descriptive sparkline. No axis, no score — it exists to show the shape of
// attention over time, not to imply the shape predicts anything.
const Sparkline = ({ points }) => {
  if (!points || points.length < 8) return null;
  const w = 320;
  const h = 44;
  const vals = points.map((p) => p.views);
  const lo = Math.min(...vals);
  const hi = Math.max(...vals);
  const span = hi - lo || 1;
  const d = points
    .map((p, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = h - ((p.views - lo) / span) * h;
      return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-11" role="img" aria-label="Daily pageviews">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.5" className="text-sky-400" />
    </svg>
  );
};

export const TrendExposureView = () => {
  const [input, setInput] = useState('');
  const [selected, setSelected] = useState(null);
  const [phrase, setPhrase] = useState('');
  const [forms, setForms] = useState('10-K');
  const [days, setDays] = useState(730);

  const { data, error, isLoading, isFetching } = useTrendExposure(phrase, { forms, days });

  const submit = (e) => {
    e?.preventDefault();
    setPhrase(input.trim());
  };

  const run = (q) => {
    setInput(q);
    setPhrase(q);
  };

  return (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <TickerDetailModal
        ticker={selected?.ticker}
        row={selected}
        board="trend"
        onClose={() => setSelected(null)}
      />
      <header className="mb-5">
        <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
          Trend Exposure
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold text-neutral-100">Who is exposed to this phrase?</h1>
          <VerdictChip board="trend" />
        </div>
        <p className="mt-2 text-sm text-neutral-400 max-w-3xl">
          Searches the full text of SEC filings and groups the hits by filer. This answers a
          question with a checkable answer — <em>who discloses this</em> — not{' '}
          <em>what will go up</em>. There is no score here on purpose: the consumer-attention
          signal this came from failed its placebo test.
        </p>
      </header>

      <form onSubmit={submit} className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px]">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-neutral-500" />
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Prime Hydration, HeyDude, GLP-1…"
            aria-label="Phrase to attribute"
            className="w-full bg-transparent border border-neutral-800 rounded pl-9 pr-3 py-2 text-sm
                       text-neutral-100 placeholder:text-neutral-600 focus:outline-none
                       focus:border-neutral-600"
          />
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Filing form">
          {FORMS.map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setForms(f)}
              aria-pressed={forms === f}
              className={`px-2.5 py-2 text-[11px] font-mono uppercase tracking-wider border rounded ${
                forms === f
                  ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                  : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {f}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-1" role="group" aria-label="Lookback window">
          {WINDOWS.map((w) => (
            <button
              key={w.days}
              type="button"
              onClick={() => setDays(w.days)}
              aria-pressed={days === w.days}
              className={`px-2.5 py-2 text-[11px] font-mono uppercase tracking-wider border rounded ${
                days === w.days
                  ? 'border-neutral-500 bg-neutral-800 text-neutral-100'
                  : 'border-neutral-800 text-neutral-500 hover:text-neutral-300'
              }`}
            >
              {w.label}
            </button>
          ))}
        </div>

        <button
          type="submit"
          className="px-4 py-2 text-[11px] font-mono uppercase tracking-wider border
                     border-neutral-600 bg-neutral-800 text-neutral-100 rounded
                     hover:bg-neutral-700 disabled:opacity-40"
          disabled={!input.trim()}
        >
          Attribute
        </button>
      </form>

      {!phrase && (
        <div className="border border-neutral-800 rounded p-4">
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-3">
            Try one
          </div>
          <ul className="space-y-2">
            {EXAMPLES.map((e) => (
              <li key={e.q} className="flex flex-wrap items-baseline gap-2">
                <button
                  onClick={() => run(e.q)}
                  className="text-sm text-sky-300 hover:text-sky-200 underline underline-offset-2"
                >
                  {e.q}
                </button>
                <span className="text-xs text-neutral-500">{e.why}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      {isLoading && (
        <div className="text-sm text-neutral-500 font-mono py-8">Searching EDGAR…</div>
      )}

      {error && (
        <div className="border border-rose-500/40 bg-rose-500/5 rounded p-4 text-sm text-rose-300">
          {String(error.message ?? error)}
        </div>
      )}

      {data && !isLoading && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-neutral-400 font-mono">
            <span>
              <span className="text-neutral-600">filings</span> {data.totalFilings}
            </span>
            <span>
              <span className="text-neutral-600">specificity</span>{' '}
              {data.specificity == null ? '—' : pct(data.specificity)}
            </span>
            <span>
              <span className="text-neutral-600">window</span> {data.startDate} → {data.endDate}
            </span>
            <span>
              <span className="text-neutral-600">forms</span> {(data.forms ?? []).join(', ')}
            </span>
            {isFetching && <span className="text-neutral-600">refreshing…</span>}
          </div>

          {data.noListedMention && (
            <div className="border border-amber-500/40 bg-amber-500/5 rounded p-4 flex gap-3">
              <Info className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm text-neutral-300">
                <div className="font-medium text-amber-300 mb-1">No listed filer mentions this</div>
                No public company writes “{data.phrase}” into a {(data.forms ?? []).join('/')} in
                this window. Usually that means the brand is privately held — which is the answer:
                there is no listed pure-play to express the theme through. Widen the window, or try
                a supplier or category term.
              </div>
            </div>
          )}

          {data.ambiguous && !data.noListedMention && (
            <div className="border border-amber-500/40 bg-amber-500/5 rounded p-4 flex gap-3">
              <AlertTriangle className="h-4 w-4 text-amber-400 shrink-0 mt-0.5" />
              <div className="text-sm text-neutral-300">
                <div className="font-medium text-amber-300 mb-1">Ambiguous phrase</div>
                The top filer accounts for only {pct(data.specificity)} of {data.totalFilings}{' '}
                matching filings, so these mentions are scattered across unrelated companies —
                a homonym or a generic term rather than a brand. Add a legal suffix
                (“Celsius Holdings”) or use a more distinctive product name.
              </div>
            </div>
          )}

          {data.filers?.length > 0 && (
            <div className="border border-neutral-800 rounded overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-neutral-800">
                    <th className="text-left font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500 px-3 py-2">
                      Filer
                    </th>
                    <th className="text-right font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500 px-3 py-2">
                      Filings
                    </th>
                    <th className="text-right font-mono text-[10px] uppercase tracking-[0.15em] text-neutral-500 px-3 py-2">
                      Share
                    </th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.filers.map((f) => (
                    <tr key={`${f.cik ?? f.name}`} className="border-b border-neutral-900 last:border-0">
                      <td className="px-3 py-2">
                        {f.ticker
                          ? <Ticker symbol={f.ticker} board="trend" className="text-neutral-200">{f.name}</Ticker>
                          : <span className="text-neutral-200">{f.name}</span>}
                        {f.ticker && (
                          <button
                            onClick={(e) => { e.stopPropagation(); setSelected({ ticker: f.ticker }); }}
                            title={`Open ${f.ticker} full profile`}
                            className="ml-2 font-mono text-[11px] text-sky-300 hover:text-sky-200 transition-colors"
                          >
                            {f.ticker}
                          </button>
                        )}
                        {!f.ticker && (
                          <span className="ml-2 text-[11px] text-neutral-600">not listed</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-300">
                        {f.filings}
                      </td>
                      <td className="px-3 py-2 text-right font-mono tabular-nums text-neutral-400">
                        {pct(f.share)}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {f.cik && (
                          <a
                            href={edgarUrl(f.cik)}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 text-[11px] text-neutral-500 hover:text-neutral-300"
                          >
                            <FileText className="h-3 w-3" />
                            EDGAR
                            <ExternalLink className="h-3 w-3" />
                          </a>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {!data.filers?.length && !data.noListedMention && (
            <div className="border border-neutral-800 rounded p-4 text-sm text-neutral-400">
              No filer breakdown came back for this query. That is a degraded response, not a
              finding — try again, or widen the window. (EDGAR rate-limits shared clients.)
            </div>
          )}

          {data.pageviews?.points?.length > 0 && (
            <div className="border border-neutral-800 rounded p-4">
              <div className="flex flex-wrap items-baseline justify-between gap-2 mb-1">
                <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono">
                  Attention context — Wikipedia daily pageviews
                </div>
                <div className="font-mono text-xs text-neutral-400 tabular-nums">
                  <span className="text-neutral-600">YoY</span> {signed(data.pageviews.yoyPct)}
                  <span className="text-neutral-600 ml-3">28d</span> {signed(data.pageviews.momPct)}
                </div>
              </div>
              <div className="text-xs text-neutral-500 mb-2">{data.pageviews.article}</div>
              <Sparkline points={data.pageviews.points} />
              <p className="mt-2 text-[11px] text-neutral-500">
                Absolute daily counts, not a rescaled index — so two lookups are comparable.
                Descriptive only: attention measured this way reverses over weeks to a year in the
                published literature, and it is not part of any score here.
              </p>
            </div>
          )}

          {/* data-testid lets the guarantee test scope its ban-list to the
              RESULTS region. The disclaimer legitimately contains phrases
              like "expected return" in negated form, so scanning the whole
              container would either fail on the real payload or force the
              disclaimer to be watered down. */}
          {data.disclaimer && (
            <p data-testid="trend-disclaimer" className="text-[11px] text-neutral-600">
              {data.disclaimer}
            </p>
          )}
        </div>
      )}
    </div>
  );
};
