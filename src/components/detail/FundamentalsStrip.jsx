// Phase 6 PR-F — FundamentalsStrip: the compact 5-metric preview reusable
// on every ticker-bearing surface.
//
// Default metrics: Market cap · P/E · P/S · ROE · D/E. Tap/click expands
// to the full StockDetailPanel via the parent's onExpand callback (the
// existing MasterDetail container is the panel surface).
//
// Data path: `useStockDetail(ticker)` — the SAME hook the detail panel,
// metrics grid, charts, catalysts, etc. consume. React Query caches the
// fetch per ticker for the QueryClient lifetime, so opening a panel after
// scanning a list never refetches. A `useFundamentalsStripDedupePin` test
// is paired with this component to prove two surfaces of the same ticker
// share one fetch.
//
// Visibility: an IntersectionObserver gates the fetch — the strip only
// triggers stock-detail when the row scrolls into view. A 30-row board
// where the user only scrolls the top 8 fires 8 fetches, not 30.
//
// Honest no-data: each metric pill renders "—" when its value is null,
// never a fabricated zero. The strip itself never throws; on fetch
// failure it renders an unobtrusive inline error chip that doesn't
// disrupt the row beneath it.

import React, { useEffect, useRef, useState } from 'react';
import { ChevronRight } from 'lucide-react';
import { useStockDetail } from '../../hooks/useStockDetail.js';

const METRICS = [
  { key: 'marketCap',  label: 'MCap', fmt: 'usd',   path: 'metrics.valuation.marketCap' },
  { key: 'pe',         label: 'P/E',  fmt: 'num1',  path: 'metrics.valuation.pe' },
  { key: 'ps',         label: 'P/S',  fmt: 'num1',  path: 'metrics.valuation.ps' },
  { key: 'roe',        label: 'ROE',  fmt: 'pct1',  path: 'metrics.profitability.roe' },
  { key: 'debtEquity', label: 'D/E',  fmt: 'num2',  path: 'metrics.health.debtEquity' },
];

function pluck(obj, path) {
  if (!obj || !path) return undefined;
  let v = obj;
  for (const k of path.split('.')) {
    if (v == null) return undefined;
    v = v[k];
  }
  return v;
}

function fmtUSD(v) {
  if (v == null || !Number.isFinite(v)) return '—';
  const a = Math.abs(v);
  if (a >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (a >= 1e9) return `$${(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(0)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

function fmtVal(v, kind) {
  if (v == null || !Number.isFinite(v)) return '—';
  if (kind === 'num1') return v.toFixed(1);
  if (kind === 'num2') return v.toFixed(2);
  if (kind === 'pct1') return `${v.toFixed(1)}%`;
  if (kind === 'usd') return fmtUSD(v);
  return String(v);
}

/** IntersectionObserver hook — defer the fetch until visible. */
function useInViewport(rootMargin = '120px') {
  const ref = useRef(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !ref.current) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      // jsdom + ancient browsers: skip the observer; fetch eagerly.
      setSeen(true);
      return undefined;
    }
    const el = ref.current;
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            setSeen(true);
            io.disconnect();
            return;
          }
        }
      },
      { rootMargin },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [seen, rootMargin]);
  return [ref, seen];
}

/**
 * Compact, lazy-fetched 5-metric strip. Pass `onExpand` to wire the
 * tap-to-expand affordance to the parent's detail-panel opener.
 */
export function FundamentalsStrip({
  ticker,
  onExpand,
  align = 'left',
  showExpandIcon = true,
  className = '',
}) {
  const [boxRef, inView] = useInViewport();
  const { data, isLoading, isError } = useStockDetail(ticker, { enabled: inView });

  function handleClick() {
    if (typeof onExpand === 'function') onExpand(ticker);
  }

  const interactive = typeof onExpand === 'function';
  const justify = align === 'right' ? 'justify-end' : align === 'center' ? 'justify-center' : 'justify-start';

  return (
    <div
      ref={boxRef}
      data-testid={`fundamentals-strip-${ticker}`}
      data-ticker={ticker}
      onClick={interactive ? handleClick : undefined}
      role={interactive ? 'button' : undefined}
      tabIndex={interactive ? 0 : undefined}
      onKeyDown={(e) => {
        if (!interactive) return;
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleClick(); }
      }}
      className={
        'flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] font-mono ' +
        justify + ' ' +
        (interactive ? 'cursor-pointer hover:bg-neutral-900/30 transition-colors ' : '') +
        className
      }
    >
      {!inView && (
        <span className="text-neutral-700">…</span>
      )}
      {inView && isLoading && (
        <span className="text-neutral-700 uppercase tracking-widest">loading…</span>
      )}
      {inView && isError && (
        <span className="text-rose-500/70 uppercase tracking-widest">no fundamentals</span>
      )}
      {inView && !isLoading && !isError && METRICS.map((m) => {
        const v = pluck(data, m.path);
        const display = fmtVal(v, m.fmt);
        return (
          <span
            key={m.key}
            data-testid={`strip-${m.key}-${ticker}`}
            className="inline-flex items-baseline gap-1"
          >
            <span className="text-neutral-600 uppercase tracking-widest text-[9px]">{m.label}</span>
            <span className={`tabular-nums ${v == null ? 'text-neutral-700' : 'text-neutral-200'}`}>
              {display}
            </span>
          </span>
        );
      })}
      {interactive && showExpandIcon && (
        <ChevronRight className="h-3 w-3 text-neutral-600 ml-auto shrink-0" aria-hidden />
      )}
    </div>
  );
}
