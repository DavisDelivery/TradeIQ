import React, { useState } from 'react';
import { Sparkles, AlertTriangle, Search } from 'lucide-react';
import { useCamilloResearch } from '../../hooks/useCamilloResearch.js';

// CAMILLO PANEL — the judgment pass, rendered wherever a ticker is open.
//
// Mounted inside StockDetailPanel, so it appears BOTH on a Screens row (via
// MasterDetail) and on any other ticker detail, from one component.
//
// TWO RULES THIS COMPONENT ENFORCES VISUALLY, not just in the API:
//
//   1. NOTHING FIRES UNTIL YOU CLICK. The endpoint spends Anthropic budget
//      per call; auto-running on panel open would drain the daily cap just
//      by scrolling a board.
//   2. THE UNVERIFIED LIST IS NOT COLLAPSIBLE AND NOT OPTIONAL. It renders
//      with the same weight as the analysis. The API already rejects an
//      empty one; the UI refuses to let it be visually demoted, because the
//      failure mode here is a fluent paragraph reading as certainty.
//
// The verdict is a WORD, never a number and never a colour-coded score —
// a number invites sorting, and sorting invites treating it as alpha.

const VERDICT_STYLE = {
  WORTH_DIGGING: 'border-emerald-500/50 bg-emerald-500/10 text-emerald-300',
  THIN: 'border-neutral-600 bg-neutral-800/60 text-neutral-400',
  ALREADY_PRICED: 'border-amber-500/50 bg-amber-500/10 text-amber-300',
  NOT_A_CANDIDATE: 'border-rose-500/50 bg-rose-500/10 text-rose-300',
};

const VERDICT_LABEL = {
  WORTH_DIGGING: 'Worth digging',
  THIN: 'Thin',
  ALREADY_PRICED: 'Already priced',
  NOT_A_CANDIDATE: 'Not a candidate',
};

const Field = ({ label, children }) => (
  <div className="mb-3">
    <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 font-mono mb-1">{label}</div>
    <div className="text-sm text-neutral-200 leading-relaxed">{children}</div>
  </div>
);

const signed = (n, unit = '') => (n == null ? null : `${n > 0 ? '+' : ''}${n}${unit}`);

// One row of the context strip. `value` null means the source did not answer;
// we print WHY rather than a dash, because a silent dash reads as "zero".
const ContextRow = ({ name, value, reason, note }) => (
  <div className="flex items-baseline justify-between gap-3 py-1 border-b border-neutral-800/60 last:border-0">
    <span className="text-[11px] text-neutral-400 font-mono shrink-0">{name}</span>
    {value != null ? (
      <span className="text-[11px] text-neutral-200 font-mono text-right">
        {value}
        {note && <span className="text-neutral-600"> · {note}</span>}
      </span>
    ) : (
      <span className="text-[11px] text-neutral-600 text-right italic">{reason || 'not available'}</span>
    )}
  </div>
);

export function CamilloPanel({ ticker, universe = 'russell2k' }) {
  const [asked, setAsked] = useState(false);
  const { data, error, isLoading, isFetching } = useCamilloResearch(ticker, { universe, enabled: asked });
  const read = data?.read ?? null;
  const ev = data?.evidence ?? null;

  return (
    <section className="border border-neutral-800 rounded p-4 mb-4">
      <header className="flex flex-wrap items-center gap-2 mb-1">
        <Sparkles className="h-4 w-4 text-sky-300" />
        <h3 className="text-sm font-semibold text-neutral-100">Camillo read</h3>
        {read && (
          <span className={`inline-flex items-center px-2 py-0.5 text-[11px] font-mono uppercase tracking-wider border rounded ${VERDICT_STYLE[read.readVerdict] ?? VERDICT_STYLE.THIN}`}>
            {VERDICT_LABEL[read.readVerdict] ?? read.readVerdict}
          </span>
        )}
        {data?.model && (
          <span className="text-[10px] font-mono text-neutral-600">{data.model}</span>
        )}
      </header>

      <p className="text-xs text-neutral-500 mb-3">
        Product, trend, materiality, discovery — from fetched evidence only. No score, no target.
      </p>

      {!asked && (
        <button
          onClick={() => setAsked(true)}
          className="inline-flex items-center gap-2 px-3 py-2 text-[11px] font-mono uppercase tracking-wider
                     border border-neutral-600 bg-neutral-800 text-neutral-100 rounded hover:bg-neutral-700"
        >
          <Search className="h-3.5 w-3.5" />
          Run the read on {ticker}
        </button>
      )}

      {asked && isLoading && (
        <div className="text-sm text-neutral-500 font-mono py-3">Gathering evidence, then reading…</div>
      )}

      {error && (
        <div className="border border-amber-500/40 bg-amber-500/5 rounded p-3 text-sm text-neutral-300">
          <div className="flex items-center gap-2 text-amber-300 font-medium mb-1">
            <AlertTriangle className="h-4 w-4" /> No read produced
          </div>
          {String(error.message ?? error)}
          <button onClick={() => setAsked(false)} className="block mt-2 text-xs text-neutral-500 underline">
            reset
          </button>
        </div>
      )}

      {read && (
        <div>
          <Field label="What it sells">{read.product}</Field>
          <Field label="Is demand changing">{read.trend}</Field>
          <Field label="Materiality — the question that kills these">{read.materiality}</Field>
          <Field label="Has the market noticed">{read.discovery}</Field>

          <div className="border-t border-neutral-800 pt-3 mt-3">
            <Field label="Falsifier — what would prove this wrong">{read.falsifier}</Field>
          </div>

          {read.nextChecks?.length > 0 && (
            <div className="mb-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 font-mono mb-1">
                Check by hand
              </div>
              <ul className="list-disc list-inside text-sm text-neutral-300 space-y-1">
                {read.nextChecks.map((c, i) => <li key={i}>{c}</li>)}
              </ul>
            </div>
          )}

          {/* CONTEXT STRIP — every attention source, shown but explicitly
              unweighted. Requested visible; unweighted because none of them
              has measured an edge in this system. The heading says so once,
              so no individual row can be read as a signal. */}
          {ev && (
            <div className="border border-neutral-800 rounded p-3 mb-3">
              <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500 font-mono mb-2">
                Attention &amp; crowding — context only, zero weight
              </div>
              <ContextRow
                name="wikipedia (absolute)"
                value={ev.attention?.momPct == null ? null : `${signed(Math.round(ev.attention.momPct))}% vs prior 28d`}
                reason={ev.attention ? 'no pageview record' : 'no article resolved'}
                note={ev.attention?.recentDailyMean ? `${ev.attention.recentDailyMean}/day` : null}
              />
              <ContextRow
                name="google trends (index)"
                value={
                  ev.googleTrends?.available && ev.googleTrends.recentVsBase != null
                    ? `${signed(ev.googleTrends.recentVsBase)} idx pts, 4w vs 12w`
                    : null
                }
                reason={ev.googleTrends?.reason ?? 'not configured'}
                note={ev.googleTrends?.keyword}
              />
              <ContextRow
                name="off-exchange volume"
                value={
                  ev.offExchange?.available && ev.offExchange.volumeZ != null
                    ? `${signed(ev.offExchange.volumeZ)} sd vs 60d`
                    : null
                }
                reason={ev.offExchange?.reason ?? 'not fetched'}
                note={ev.offExchange?.dpiRecent != null ? `DPI ${ev.offExchange.dpiRecent} vs ${ev.offExchange.dpiBase}` : null}
              />
              <p className="text-[10px] text-neutral-600 mt-2 leading-snug">
                A positive off-exchange z means retail is already here — in this frame that argues
                against an undiscovered name, not for it. DPI levels are not comparable between
                companies. WallStreetBets mentions are not on this Quiver plan.
              </p>
            </div>
          )}

          {/* Never collapsed, never a footnote — see the header comment. */}
          <div className="border border-amber-500/30 bg-amber-500/5 rounded p-3">
            <div className="text-[10px] uppercase tracking-[0.18em] text-amber-300/90 font-mono mb-1">
              Not verified
            </div>
            <ul className="list-disc list-inside text-sm text-neutral-300 space-y-1">
              {read.unverified.map((u, i) => <li key={i}>{u}</li>)}
            </ul>
          </div>

          {ev && (
            <div className="mt-3 text-[11px] text-neutral-600 font-mono">
              evidence {ev.asOf} · {ev.hasFundamentals ? 'screener ✓' : 'no screener row'} ·{' '}
              {ev.newsCount} news · {ev.insiderCount} insider
              {ev.offExchange?.days ? <> · {ev.offExchange.days}d OTC</> : null}
              {ev.gaps?.length > 0 && <> · {ev.gaps.length} gap{ev.gaps.length === 1 ? '' : 's'}</>}
            </div>
          )}

          {ev?.gaps?.length > 0 && (
            <details className="mt-1">
              <summary className="text-[11px] text-neutral-600 cursor-pointer">what was missing</summary>
              <ul className="list-disc list-inside text-[11px] text-neutral-500 mt-1 space-y-0.5">
                {ev.gaps.map((g, i) => <li key={i}>{g}</li>)}
              </ul>
            </details>
          )}

          {isFetching && <div className="mt-2 text-[11px] text-neutral-600">refreshing…</div>}
        </div>
      )}
    </section>
  );
}
