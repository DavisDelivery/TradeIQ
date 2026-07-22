import React, { useState, useMemo } from 'react';
import { TrendingUp, TrendingDown, ExternalLink, Newspaper } from 'lucide-react';
import { useSentiment } from './hooks/useSentiment.js';
import { useLiveRows } from './hooks/useLiveQuotes.js';
import { FreshnessPill } from './components/FreshnessPill.jsx';
import { FundamentalsStrip } from './components/detail/FundamentalsStrip.jsx';
import { MasterDetail } from './layout/MasterDetail.jsx';
import { StockDetailPanel } from './components/detail/StockDetailPanel.jsx';

// SENTIMENT — "Most Bullish / Most Bearish" news screener. Each ticker's
// recent headlines are scored by a finance lexicon (server-side) and shown
// with the driving headline, so the score is always explainable. This is a
// screener, not a validated edge (news sentiment is coincident + noisy), so
// it lives in the Unvalidated section and shows its work.

const SORTS = [
  { id: 'bullish', label: 'Most Bullish' },
  { id: 'bearish', label: 'Most Bearish' },
];

const fmtPrice = (n) => (Number.isFinite(n) ? `$${n.toFixed(2)}` : '—');

const fmtAgo = (epochSec) => {
  if (!epochSec) return '';
  const ms = Date.now() - epochSec * 1000;
  const h = Math.round(ms / 3_600_000);
  if (h < 1) return `${Math.max(1, Math.round(ms / 60_000))}m ago`;
  if (h < 48) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
};

const ScoreChip = ({ score, label }) => {
  const tone =
    label === 'bullish' ? 'text-emerald-300 border-emerald-500/40 bg-emerald-500/10'
    : label === 'bearish' ? 'text-rose-300 border-rose-500/40 bg-rose-500/10'
    : 'text-neutral-400 border-neutral-700 bg-neutral-800/40';
  const Icon = label === 'bullish' ? TrendingUp : label === 'bearish' ? TrendingDown : null;
  return (
    <span className={`inline-flex items-center gap-1 px-2 py-0.5 text-[10px] font-mono uppercase tracking-wider border ${tone}`}>
      {Icon && <Icon className="h-3 w-3" />}
      {score > 0 ? '+' : ''}{score}
    </span>
  );
};

export const SentimentView = ({ universe = 'sp500' }) => {
  const [sort, setSort] = useState('bullish');
  const [selected, setSelected] = useState(null);
  // The scan runs on sp500; the universe selector's other indices fall back to
  // sp500 (the only sentiment universe in v1).
  const { data, error, isLoading: loading, isFetching, forceRescan } = useSentiment('sp500', sort);
  const isRescanning = isFetching && !loading;

  const rows = useLiveRows(data?.rows ?? [], { priceKey: 'price', pctKey: 'priceChangePct' });

  const list = (
    <div className="px-3 py-4 sm:p-6 max-w-[1400px] mx-auto pb-20 sm:pb-6">
      <header className="mb-5 flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="text-[10px] uppercase tracking-[0.2em] text-neutral-500 font-mono mb-2">
            News sentiment · S&amp;P 500 · headline-scored
          </div>
          <h1 className="font-serif text-2xl sm:text-3xl font-bold tracking-tight flex items-baseline gap-2">
            {loading ? (
              <span className="text-neutral-500 italic font-light">loading…</span>
            ) : (
              <>
                <span className={sort === 'bullish' ? 'text-emerald-400' : 'text-rose-400'}>{rows.length}</span>
                <span className="text-neutral-500 italic font-light">
                  {sort === 'bullish' ? 'most bullish' : 'most bearish'} by news
                </span>
              </>
            )}
          </h1>
          <p className="text-neutral-400 text-sm mt-2 max-w-2xl">
            Recent headlines per name, scored by a finance lexicon. A screener, not a
            validated edge — news sentiment reacts to price as much as it leads it, so
            every score shows the headline behind it. Tap any ticker for the full profile.
          </p>
        </div>
        <FreshnessPill meta={data} isRescanning={isRescanning} onForceRescan={() => forceRescan()} />
      </header>

      <div className="flex items-center gap-1 text-[11px] font-mono mb-4 flex-wrap">
        <span className="text-neutral-500 mr-2 uppercase tracking-widest">Sort</span>
        {SORTS.map(({ id, label }) => (
          <button
            key={id}
            onClick={() => setSort(id)}
            className={`px-2.5 h-7 transition-colors border ${
              sort === id
                ? 'bg-emerald-500/15 text-emerald-300 border-emerald-500/40'
                : 'text-neutral-500 border-neutral-800 hover:border-neutral-600'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="border border-rose-800/50 bg-rose-950/20 p-3 text-rose-300 font-mono text-[11px] mb-4">
          refresh failed: {error.message} {rows.length > 0 && '— showing last loaded data'}
        </div>
      )}

      {loading && !data && (
        <div className="border border-neutral-800 overflow-hidden">
          {[...Array(8)].map((_, i) => (
            <div key={i} className="h-16 border-b border-neutral-900/60 bg-neutral-900/30 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
        </div>
      )}

      {!loading && data && rows.length === 0 && (
        <div className="border border-neutral-800 p-8 text-center text-neutral-500 text-sm">
          No scored news in the latest snapshot. The next scheduled scan will refresh it.
        </div>
      )}

      {rows.length > 0 && (
        <div className="space-y-2">
          {rows.map((r, i) => (
            <div key={r.ticker} className="border border-neutral-800 bg-neutral-950/40 hover:border-neutral-700 transition-colors">
              <div className="p-3 sm:p-4">
                <div className="flex items-start gap-3">
                  <span className="w-6 shrink-0 text-xs text-neutral-600 font-mono pt-1">#{i + 1}</span>
                  <div className="flex-1 min-w-0">
                    <div className="flex items-baseline justify-between gap-3 mb-1">
                      <div className="flex items-baseline gap-2 min-w-0">
                        <button
                          type="button"
                          onClick={() => setSelected(r)}
                          className="font-serif font-bold text-[15px] text-neutral-100 hover:text-emerald-300 transition-colors"
                          title="Open full detail — chart, AI brief, fundamentals"
                        >
                          {r.ticker}
                        </button>
                        <span className="text-[11px] text-neutral-500 truncate">{r.name}</span>
                      </div>
                      <div className="text-right flex-shrink-0">
                        <div className="text-[13px] text-neutral-200 font-mono">{fmtPrice(r.price)}</div>
                        {Number.isFinite(r.priceChangePct) && (
                          <div className={`text-[10px] font-mono ${r.priceChangePct >= 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                            {r.priceChangePct >= 0 ? '+' : ''}{r.priceChangePct.toFixed(2)}%
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2 flex-wrap mb-1.5">
                      <ScoreChip score={r.score} label={r.label} />
                      <span className="text-[10px] font-mono text-neutral-500">
                        {r.articleCount} article{r.articleCount === 1 ? '' : 's'}
                      </span>
                      <span className="text-[10px] font-mono text-emerald-500/80">{r.positiveCount}+</span>
                      <span className="text-[10px] font-mono text-rose-500/80">{r.negativeCount}−</span>
                      {r.sector && <span className="text-[10px] text-neutral-600 uppercase tracking-wider">{r.sector}</span>}
                    </div>
                    {r.topHeadline && (
                      <a
                        href={r.topHeadline.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="group flex items-start gap-1.5 text-[11px] leading-relaxed text-neutral-400 hover:text-neutral-200"
                      >
                        <Newspaper className="h-3 w-3 mt-0.5 flex-shrink-0 text-neutral-600" />
                        <span className="line-clamp-2">{r.topHeadline.headline}</span>
                        <ExternalLink className="h-3 w-3 mt-0.5 flex-shrink-0 opacity-0 group-hover:opacity-60" />
                      </a>
                    )}
                    {r.topHeadline && (
                      <div className="mt-0.5 text-[10px] font-mono text-neutral-600">
                        {r.topHeadline.source} · {fmtAgo(r.topHeadline.datetime)}
                      </div>
                    )}
                  </div>
                </div>
                <div className="mt-2 pt-2 border-t border-neutral-800/60 ml-9">
                  <FundamentalsStrip ticker={r.ticker} showExpandIcon={false} />
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-6 border border-neutral-800/60 bg-neutral-950/40 p-3 text-[11px] text-neutral-500 leading-relaxed">
        Source: Finnhub company-news headlines over the last 7 days, scored by a finance
        lexicon (beats/upgrade/surge vs miss/downgrade/plunge…). Score is the mean
        headline sentiment scaled to ±100; buzz is the article count. This is a
        coincident screener — treat it as a starting point for research, not a signal.
      </div>
    </div>
  );

  return (
    <MasterDetail
      selected={selected}
      onClose={() => setSelected(null)}
      list={list}
      detail={selected ? <StockDetailPanel board="sentiment" ticker={selected.ticker} row={selected} /> : null}
      closeLabel="Close detail"
    />
  );
};

export default SentimentView;
